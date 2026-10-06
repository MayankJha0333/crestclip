/** Plain server-made HTML for the admin pages (no build step, no libraries). */

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const usd = (n: number, digits = 2) => `$${(Math.round(n * 10 ** digits) / 10 ** digits).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

const CSS = `
:root{--bg:#f6f5f2;--card:#fff;--ink:#1f1d1a;--muted:#6b665f;--line:#e6e2db;--accent:#ef7d3c;--ok:#1f9d63;--bad:#d64545;--warn:#c98a12;--bar:#ef7d3c33}
@media (prefers-color-scheme:dark){:root{--bg:#141311;--card:#1e1c19;--ink:#f1eee9;--muted:#a39d94;--line:#2f2c28;--bar:#ef7d3c44}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;gap:18px;align-items:center;flex-wrap:wrap;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--card)}
header b{font-size:17px;margin-right:8px}header a{color:var(--muted);text-decoration:none;padding:4px 2px}header a.on{color:var(--ink);border-bottom:2px solid var(--accent)}
main{max-width:1100px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:22px;margin:4px 0 4px}h2{font-size:16px;margin:28px 0 10px}p.sub{color:var(--muted);margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card .k{color:var(--muted);font-size:13px}.card .v{font-size:24px;font-weight:650;margin-top:2px}.card .s{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:middle}th{color:var(--muted);font-weight:500;font-size:13px}
tr:last-child td{border-bottom:0}td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}.ok{background:var(--ok)}.bad{background:var(--bad)}.warn{background:var(--warn)}
.bar{position:relative;height:8px;border-radius:5px;background:var(--line);min-width:80px}.bar i{position:absolute;inset:0 auto 0 0;border-radius:5px;background:var(--accent)}
.note{color:var(--muted);font-size:13px;margin-top:8px}.pill{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.spark{display:flex;align-items:flex-end;gap:2px;height:70px;padding:8px 0}.spark i{flex:1;background:var(--accent);border-radius:2px 2px 0 0;min-height:1px;opacity:.85}
.wrap{overflow-x:auto}a{color:var(--accent)}
`;

export function layout(title: string, active: 'overview' | 'costs', body: string, refreshSeconds = 0) {
  const nav = [
    ['overview', '/admin/', 'Overview'],
    ['jobs', '/admin/queues/', 'Jobs'],
    ['logs', '/admin/logs/', 'Live logs'],
    ['costs', '/admin/costs', 'Costs'],
  ]
    .map(([k, href, label]) => `<a href="${href}" class="${k === active ? 'on' : ''}">${label}</a>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ''}<title>${esc(title)} · CrestClip admin</title><style>${CSS}</style></head>
<body><header><b>CrestClip admin</b>${nav}<span style="flex:1"></span><a href="/app">Back to the app</a></header><main>${body}</main></body></html>`;
}

export const bar = (fraction: number) => `<div class="bar"><i style="width:${Math.max(0, Math.min(1, fraction)) * 100}%"></i></div>`;
export const dot = (state: 'ok' | 'bad' | 'warn') => `<span class="dot ${state}"></span>`;
export const card = (k: string, v: string, s = '') => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
export function spark(values: number[]) {
  const max = Math.max(...values, 0.0001);
  return `<div class="spark">${values.map((v) => `<i title="${usd(v, 3)}" style="height:${(v / max) * 100}%"></i>`).join('')}</div>`;
}
