#!/usr/bin/env bash
# One-time Google Cloud setup for automatic deploys. Run it in Cloud Shell (the >_ button in the Cloud console).
#
#   bash devops/gcp/setup.sh        (or paste it into Cloud Shell)
#
# It creates:
#   1. an image store (Artifact Registry) where GitHub puts each new version of the app
#   2. a keyless login for GitHub Actions (Workload Identity Federation) — only this repo's main branch can use it
#      (the server fetches new versions itself — see devops/deploy/update.sh — so GitHub never logs in to it)
#   3. the server's access to its settings: ONE secret "crestclip-env" in Secret Manager (the whole .env file).
#      If it's empty, the settings now on the server (/opt/crestclip/.env) are copied into it — the values pass
#      through this shell only, never printed.
#   4. (optional) a BigQuery dataset for Google's billing export, read by the Costs page
# It's safe to run again: steps that are already done are skipped.
set -euo pipefail

PROJECT=peakclip-510216
REGION=us-central1
GITHUB_REPO=MayankJha0333/crestclip
VM=crestclip-server-mumbai
VM_SA="crestclip-server@${PROJECT}.iam.gserviceaccount.com"
DEPLOYER="github-deployer@${PROJECT}.iam.gserviceaccount.com"

say() { printf '\n▸ %s\n' "$*"; }
export CLOUDSDK_CORE_PROJECT="$PROJECT" # this script only — your default project (e.g. SellerGeni) is left alone
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

say "Turning on the services we need"
gcloud services enable artifactregistry.googleapis.com iamcredentials.googleapis.com sts.googleapis.com secretmanager.googleapis.com bigquery.googleapis.com

say "1/4 Image store"
gcloud artifacts repositories describe crestclip --location="$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create crestclip --repository-format=docker --location="$REGION" \
    --description="CrestClip app images (one per deploy)"
# keep only the 5 newest versions (enough to go back); everything older is deleted (Google runs this about once a day)
cat >/tmp/cleanup.json <<'JSON'
[
  { "name": "keep-newest-5", "action": { "type": "Keep" }, "mostRecentVersions": { "keepCount": 5 } },
  { "name": "delete-the-rest", "action": { "type": "Delete" }, "condition": { "tagState": "ANY" } }
]
JSON
gcloud artifacts repositories set-cleanup-policies crestclip --location="$REGION" --policy=/tmp/cleanup.json --no-dry-run >/dev/null
# the server may download images
gcloud artifacts repositories add-iam-policy-binding crestclip --location="$REGION" \
  --member="serviceAccount:${VM_SA}" --role=roles/artifactregistry.reader >/dev/null

say "2/4 Keyless login for GitHub Actions"
gcloud iam service-accounts describe "$DEPLOYER" >/dev/null 2>&1 ||
  gcloud iam service-accounts create github-deployer --display-name="GitHub Actions (uploads app images)"
gcloud artifacts repositories add-iam-policy-binding crestclip --location="$REGION" \
  --member="serviceAccount:${DEPLOYER}" --role=roles/artifactregistry.writer >/dev/null
gcloud iam workload-identity-pools describe github --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
CONDITION="assertion.repository=='${GITHUB_REPO}' && assertion.ref=='refs/heads/main'"
if gcloud iam workload-identity-pools providers describe github --location=global --workload-identity-pool=github >/dev/null 2>&1; then
  # already there — make sure it trusts the current repo name (e.g. after renaming the repo)
  gcloud iam workload-identity-pools providers update-oidc github --location=global --workload-identity-pool=github \
    --attribute-condition="$CONDITION" >/dev/null
else
  gcloud iam workload-identity-pools providers create-oidc github --location=global --workload-identity-pool=github \
    --display-name="GitHub" --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="$CONDITION"
fi
POOL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --role=roles/iam.workloadIdentityUser \
  --member="${POOL}/${GITHUB_REPO}" >/dev/null
# the repo's old name no longer gets in
gcloud iam service-accounts remove-iam-policy-binding "$DEPLOYER" --role=roles/iam.workloadIdentityUser \
  --member="${POOL}/MayankJha0333/peakclip" >/dev/null 2>&1 || true

say "Server: old SSH deploy key"
# Deploys are pulled by the server itself, so no SSH key is needed. Remove an old "deploy" key if one was added.
ZONE=$(gcloud compute instances list --filter="name=${VM}" --format='value(zone.basename())')
[ -n "$ZONE" ] || { echo "✗ Can't find the VM ${VM}."; exit 1; }
gcloud compute instances describe "$VM" --zone="$ZONE" --format=json |
  python3 -c 'import json, sys; d = json.load(sys.stdin); print(next((i["value"] for i in d.get("metadata", {}).get("items", []) if i["key"] == "ssh-keys"), ""))' >/tmp/ssh-keys
if grep -q '^deploy:' /tmp/ssh-keys; then
  grep -v '^deploy:' /tmp/ssh-keys | sed '/^$/d' >/tmp/ssh-keys.new || true
  gcloud compute instances add-metadata "$VM" --zone="$ZONE" --metadata-from-file=ssh-keys=/tmp/ssh-keys.new >/dev/null
  echo "  removed the old deploy key"
fi
rm -f "$HOME"/crestclip_deploy_key*

say "3/4 Settings in one place (Secret Manager)"
SECRET=crestclip-env
gcloud secrets describe "$SECRET" >/dev/null 2>&1 ||
  gcloud secrets create "$SECRET" --replication-policy=automatic --labels=app=crestclip >/dev/null
# the server may read it (accessor = the value, viewer = which version is newest)
for role in roles/secretmanager.secretAccessor roles/secretmanager.viewer; do
  gcloud secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:${VM_SA}" --role="$role" >/dev/null
done
if [ -z "$(gcloud secrets versions list "$SECRET" --filter=state=ENABLED --limit=1 --format='value(name)')" ]; then
  echo "  The secret is empty. Copying the settings that are on the server now (/opt/crestclip/.env)…"
  umask 077
  if gcloud compute ssh "$VM" --zone="$ZONE" --quiet --command 'sudo cat /opt/crestclip/.env' 2>/dev/null >/tmp/crestclip.env && [ -s /tmp/crestclip.env ]; then
    # the key that unlocks connected YouTube/Instagram accounts (data/secret.key) goes in too, so a new server can
    # read them — only when the settings don't use SECRET_KEY instead (then that is the key, and the file is unused)
    if ! grep -q '^[[:space:]]*SECRET_KEY[[:space:]]*=' /tmp/crestclip.env; then
      KEYHEX=$(gcloud compute ssh "$VM" --zone="$ZONE" --quiet --command 'sudo cat /opt/crestclip/data/secret.key 2>/dev/null' 2>/dev/null | tr -d '[:space:]' || true)
      if [[ "$KEYHEX" =~ ^[0-9a-fA-F]{64}$ ]]; then
        printf '\n# data/secret.key (unlocks connected accounts) — keep it the same forever\nSECRET_KEY_HEX=%s\n' "$KEYHEX" >>/tmp/crestclip.env
      fi
      KEYHEX=
    fi
    gcloud secrets versions add "$SECRET" --data-file=/tmp/crestclip.env >/dev/null
    echo "  ✓ copied ($(grep -c '=' /tmp/crestclip.env) lines) — from now on edit them with devops/secrets/secrets.sh"
  else
    echo "  ✗ couldn't read it from the server. Upload a file yourself: devops/secrets/secrets.sh push <file>"
  fi
  rm -f /tmp/crestclip.env
else
  echo "  already has settings ✓"
fi
# the server reads Secret Manager and BigQuery with its own account — that needs the "cloud-platform" access scope
if ! gcloud compute instances describe "$VM" --zone="$ZONE" --format='value(serviceAccounts[0].scopes)' | grep -q cloud-platform; then
  echo "  ! The server's access scopes don't include cloud-platform, so it can't read the secret."
  echo "    Fix (needs a short stop): gcloud compute instances stop $VM --zone=$ZONE && \\"
  echo "      gcloud compute instances set-service-account $VM --zone=$ZONE --service-account=$VM_SA --scopes=cloud-platform && \\"
  echo "      gcloud compute instances start $VM --zone=$ZONE"
fi

say "4/4 Billing export for the Costs page (optional)"
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${VM_SA}" --role=roles/bigquery.jobUser --condition=None >/dev/null ||
  echo "  (couldn't grant BigQuery Job User to ${VM_SA} — the Costs page will show estimates only)"
bq --project_id="$PROJECT" show billing >/dev/null 2>&1 ||
  bq --project_id="$PROJECT" mk --dataset --location=US --description="Google Cloud billing export (read by the CrestClip Costs page)" "$PROJECT:billing" >/dev/null ||
  echo "  (couldn't create the BigQuery dataset 'billing' — create it in the console if you want the real bill)"
bq --project_id="$PROJECT" add-iam-policy-binding --member="serviceAccount:${VM_SA}" --role=roles/bigquery.dataViewer "$PROJECT:billing" >/dev/null 2>&1 ||
  echo "  (couldn't grant read access on the dataset — give ${VM_SA} 'BigQuery Data Viewer' on dataset billing in the console)"
BILLING_ACCOUNT=$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' 2>/dev/null | sed 's#billingAccounts/##' || true)
if [ -n "$BILLING_ACCOUNT" ]; then
  TABLE="${PROJECT}.billing.gcp_billing_export_v1_${BILLING_ACCOUNT//-/_}"
  echo "  Turn the export on (Google only allows this in the console):"
  echo "    https://console.cloud.google.com/billing/${BILLING_ACCOUNT}/export"
  echo "    → BigQuery export → Standard usage cost → Edit settings → project ${PROJECT}, dataset billing → Save"
  echo "  Then add this line to the settings (devops/secrets/secrets.sh edit):"
  echo
  echo "    BILLING_EXPORT_TABLE=${TABLE}"
  echo
  echo "  The first numbers appear after a few hours; the Costs page shows them from then on."
fi

say "Done. If not done yet — in GitHub → your repo → Settings → Secrets and variables → Actions → Variables tab:"
echo
echo "    Name:  GCP_WIF_PROVIDER"
echo "    Value: projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/github"
