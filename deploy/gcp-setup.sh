#!/usr/bin/env bash
# One-time Google Cloud setup for automatic deploys. Run it in Cloud Shell (the >_ button in the Cloud console).
#
# It creates:
#   1. an image store (Artifact Registry) where GitHub puts each new version of the app
#   2. a keyless login for GitHub Actions (Workload Identity Federation) — only this repo's main branch can use it
#   (the server fetches new versions itself — see deploy/pull-deploy.sh — so GitHub never logs in to it)
# It's safe to run again: steps that are already done are skipped.
set -euo pipefail

PROJECT=peakclip-510216
REGION=us-central1
GITHUB_REPO=MayankJha0333/crestclip
VM=crestclip-server-mumbai
VM_SA="crestclip-server@${PROJECT}.iam.gserviceaccount.com"
DEPLOYER="github-deployer@${PROJECT}.iam.gserviceaccount.com"

say() { printf '\n▸ %s\n' "$*"; }
gcloud config set project "$PROJECT" >/dev/null
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

say "Turning on the services we need"
gcloud services enable artifactregistry.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

say "1/3 Image store"
gcloud artifacts repositories describe crestclip --location="$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create crestclip --repository-format=docker --location="$REGION" \
    --description="CrestClip app images (one per deploy)"
# keep the 10 newest versions (for going back), delete older ones after 30 days
cat >/tmp/cleanup.json <<'JSON'
[
  { "name": "keep-newest-10", "action": { "type": "Keep" }, "mostRecentVersions": { "keepCount": 10 } },
  { "name": "delete-old", "action": { "type": "Delete" }, "condition": { "olderThan": "30d" } }
]
JSON
gcloud artifacts repositories set-cleanup-policies crestclip --location="$REGION" --policy=/tmp/cleanup.json --no-dry-run >/dev/null
# the server may download images
gcloud artifacts repositories add-iam-policy-binding crestclip --location="$REGION" \
  --member="serviceAccount:${VM_SA}" --role=roles/artifactregistry.reader >/dev/null

say "2/3 Keyless login for GitHub Actions"
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

say "3/3 Server"
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

say "Done. In GitHub → your repo → Settings → Secrets and variables → Actions → Variables tab → New repository variable:"
echo
echo "    Name:  GCP_WIF_PROVIDER"
echo "    Value: projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/github"
