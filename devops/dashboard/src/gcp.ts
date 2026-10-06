/**
 * What this server is (asked from Google's metadata service — only works on the VM) and, when billing export is on,
 * the real bill per Google service (BigQuery, with the VM's own Google account — no key file).
 */

const MD = 'http://metadata.google.internal/computeMetadata/v1';
async function md(path: string): Promise<string | null> {
  try {
    const r = await fetch(`${MD}/${path}`, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

export interface VmInfo {
  onGcp: boolean;
  project: string | null;
  zone: string | null;
  region: string | null;
  machineType: string | null;
  name: string | null;
}
let vmCache: VmInfo | null = null;
export async function vmInfo(): Promise<VmInfo> {
  if (vmCache) return vmCache;
  const [project, zonePath, typePath, name] = await Promise.all([md('project/project-id'), md('instance/zone'), md('instance/machine-type'), md('instance/name')]);
  const zone = zonePath?.split('/').pop() ?? null;
  const info = {
    onGcp: Boolean(project),
    project,
    zone,
    region: zone ? zone.replace(/-[a-z]$/, '') : null,
    machineType: typePath?.split('/').pop() ?? null,
    name,
  };
  if (info.onGcp) vmCache = info;
  return info;
}

async function token(): Promise<string | null> {
  const t = await md('instance/service-accounts/default/token');
  if (!t) return null;
  try {
    return (JSON.parse(t) as { access_token: string }).access_token;
  } catch {
    return null;
  }
}

export interface BillRow {
  service: string;
  thisMonth: number;
  last30: number;
}
let billCache: { at: number; rows: BillRow[]; currency: string; error: string | null } | null = null;

/**
 * The real Google bill by service, from the billing export table (BILLING_EXPORT_TABLE, e.g.
 * `peakclip-510216.billing.gcp_billing_export_v1_XXXX`). Cached for an hour — the export itself updates a few times a day.
 */
export async function realBill(): Promise<{ rows: BillRow[]; currency: string; error: string | null } | null> {
  const table = (process.env.BILLING_EXPORT_TABLE || '').trim();
  if (!table) return null;
  if (billCache && Date.now() - billCache.at < 3600_000) return billCache;
  const vm = await vmInfo();
  const t = await token();
  if (!vm.project || !t) return { rows: [], currency: 'USD', error: 'Only works on the Google Cloud server.' };
  const query = `
    SELECT service.description AS service, currency,
      SUM(IF(invoice.month = FORMAT_DATE('%Y%m', CURRENT_DATE()), cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0), 0)) AS this_month,
      SUM(IF(usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY), cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0), 0)) AS last_30
    FROM \`${table.replace(/`/g, '')}\`
    WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 62 DAY)
    GROUP BY service, currency
    ORDER BY last_30 DESC`;
  try {
    const r = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${vm.project}/queries`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, useLegacySql: false, timeoutMs: 20000 }),
      signal: AbortSignal.timeout(25000),
    });
    const j = (await r.json()) as { rows?: { f: { v: string }[] }[]; error?: { message: string } };
    if (!r.ok) throw new Error(j.error?.message ?? `BigQuery ${r.status}`);
    const rows = (j.rows ?? []).map((x) => ({ service: x.f[0].v, thisMonth: Number(x.f[2].v), last30: Number(x.f[3].v) }));
    const currency = j.rows?.[0]?.f[1].v ?? 'USD';
    billCache = { at: Date.now(), rows, currency, error: null };
  } catch (e) {
    billCache = { at: Date.now() - 3000_000, rows: [], currency: 'USD', error: (e as Error).message }; // retry in 10 min
  }
  return billCache;
}
