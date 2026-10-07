/**
 * CrestClip admin pages — its own small container (see devops/deploy/docker-compose.prod.yml), on 127.0.0.1:8790.
 * Caddy sends /admin/* here only after the app said the visitor is a signed-in CrestClip admin (/admin/gate).
 *
 *   /admin/         Overview: is the site up, workers connected, queue sizes, every container's CPU + memory
 *   /admin/queues/  Jobs (Bull Board): waiting / running / done / failed, each job's own log lines, retry
 *   /admin/costs    Costs: monthly price of the system, who uses the server, AI spend per day / project / person
 *   /admin/logs/    Live logs — Dozzle, a separate container (Caddy routes it; linked from here)
 */
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Redis } from 'ioredis';
import { MongoClient, type Db } from 'mongodb';
// one settings loader for the whole repo (reads /app/.env — the file the server fetched from Secret Manager)
import { config } from '../../../server/src/config.js';
import { aiCosts, fixedCosts, realBill, serverSplit } from './costs.js';
import { startSampling } from './docker.js';
import { vmInfo } from './gcp.js';
import { ago, bar, card, dot, esc, layout, pill, spark, status, usd } from './pages.js';
import { runningNow, userDetail, usersList } from './users.js';
import { makeQueues, overview } from './system.js';

const PORT = Number(process.env.DASHBOARD_PORT || 8790);
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1'; // only Caddy (same machine) can reach it

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const conn = new Redis(redisUrl, { maxRetriesPerRequest: null });
conn.on('error', (e) => console.warn('[dashboard] redis:', e.message));
const queues = makeQueues(conn);

let db: Db | null = null;
async function mongo(): Promise<Db | null> {
  if (db) return db;
  if (!config.mongoUri) return null;
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 3 });
  await client.connect();
  db = client.db(config.mongoDb);
  return db;
}

const app = express();
app.disable('x-powered-by');
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

// ---------------- Jobs (Bull Board) ----------------
const adapter = new ExpressAdapter();
adapter.setBasePath('/admin/queues');
createBullBoard({
  queues: queues.map((q) => new BullMQAdapter(q.queue, { allowRetries: true, description: q.label })),
  serverAdapter: adapter,
  options: {
    uiConfig: {
      boardTitle: 'CrestClip jobs',
      hideDocsLink: true,
      miscLinks: [
        { text: 'Overview', url: '/admin/' },
        { text: 'Live logs', url: '/admin/logs/' },
        { text: 'Costs', url: '/admin/costs' },
      ],
    },
  },
});
app.use('/admin/queues', adapter.getRouter());

// ---------------- Overview ----------------
app.get(
  ['/admin', '/admin/'],
  wrap(async (_req, res) => {
    const [o, vm] = await Promise.all([overview(conn, queues), vmInfo()]);
    const webUp = o.web.filter((w) => w.ok).length;
    const workers = o.queues.find((q) => q.name === 'cc-videos')?.workers ?? 0;
    const busy = o.queues.reduce((s, q) => s + (q.active ?? 0), 0);
    const waiting = o.queues.reduce((s, q) => s + (q.waiting ?? 0), 0);
    const failed = o.queues.reduce((s, q) => s + (q.failed ?? 0), 0);
    const longest = Math.max(0, ...o.queues.map((q) => q.longestWaitMin));
    const body = `
<h1>Overview</h1><p class="sub">${esc(vm.name ?? 'this machine')}${vm.machineType ? ` · ${esc(vm.machineType)} · ${esc(vm.zone)}` : ''} · refreshes every 20 seconds</p>
<div class="grid">
  ${card('Website', `${dot(webUp === o.web.length ? 'ok' : webUp ? 'warn' : 'bad')}${webUp} of ${o.web.length} up`, o.web.map((w) => `:${w.port} ${w.ok ? `${w.ms} ms` : 'down'}`).join(' · '))}
  ${card('Workers connected', `${dot(workers ? 'ok' : 'bad')}${workers}`, workers ? 'taking video jobs' : 'no worker is taking jobs!')}
  ${card('Jobs running', String(busy), `${waiting} waiting in line`)}
  ${card('Longest wait', `${dot(longest >= 60 ? 'bad' : longest >= 15 ? 'warn' : 'ok')}${longest} min`, waiting ? 'oldest job still in line' : 'nobody is waiting')}
  ${card('Failed jobs', `${dot(failed ? 'warn' : 'ok')}${failed}`, failed ? '<a href="/admin/queues/">see why →</a>' : 'nothing failed recently')}
  ${o.disk ? card('Disk', `${o.disk.pct}%`, `${o.disk.usedGb} of ${o.disk.totalGb} GB used`) : ''}
  ${card('Redis memory', `${o.redis.usedMb} MB`, o.redis.maxMb ? `limit ${o.redis.maxMb} MB` : 'no limit set')}
</div>

<h2>Job queues</h2>
<div class="wrap"><table><tr><th>Queue</th><th class="n">Workers</th><th class="n">Running</th><th class="n">Waiting</th><th class="n">Longest wait</th><th class="n">Failed</th><th class="n">Done (kept 2 days)</th></tr>
${o.queues.map((q) => `<tr><td><a href="/admin/queues/queue/${q.name}">${esc(q.label)}</a></td><td class="n">${q.workers}</td><td class="n">${q.active ?? 0}</td><td class="n">${q.waiting}</td><td class="n">${q.waiting ? `${q.longestWaitMin} min` : '—'}</td><td class="n">${q.failed ?? 0}</td><td class="n">${q.completed ?? 0}</td></tr>`).join('')}
</table></div>

<h2>Containers right now</h2>
${
  o.containers
    ? `<div class="wrap"><table><tr><th>Container</th><th>What it does</th><th>Status</th><th class="n">CPU (of whole server)</th><th></th><th class="n">Memory</th></tr>
${o.containers.map((c) => `<tr><td>${esc(c.service)}</td><td>${esc(c.group)}</td><td>${dot(c.state === 'running' ? 'ok' : 'bad')}${esc(c.status)}</td><td class="n">${c.cpu}%</td><td style="width:140px">${bar(c.cpu / 100)}</td><td class="n">${c.memMb} MB</td></tr>`).join('')}
</table></div><p class="note">Live from Docker on this server. Full logs for each one: <a href="/admin/logs/">Live logs</a>.</p>`
    : '<p class="note">Container stats need the Docker socket (only on the server).</p>'
}`;
    res.type('html').send(layout('Overview', 'overview', body, 20));
  }),
);

// ---------------- Users ----------------
const plan = (p: string, paying: boolean) => `${esc(p[0]?.toUpperCase() + p.slice(1))}${paying ? ' ' + pill('paying', 'ok') : ''}`;
const SORTS: Record<string, [string, (a: { [k: string]: unknown }, b: { [k: string]: unknown }) => number]> = {
  active: ['Last active', (a, b) => Number(b.lastActive) - Number(a.lastActive)],
  credits: ['Credits left', (a, b) => Number(b.credits) - Number(a.credits)],
  used: ['Credits used (30 d)', (a, b) => Number(b.used30) - Number(a.used30)],
  videos: ['Videos', (a, b) => Number(b.videos) - Number(a.videos)],
  joined: ['Newest', (a, b) => Number(b.joined) - Number(a.joined)],
};

app.get(
  '/admin/users',
  wrap(async (req, res) => {
    const d = await mongo();
    if (!d) return void res.type('html').send(layout('Users', 'users', '<h1>Users</h1><p class="sub">Needs the database (MONGODB_URI).</p>'));
    const { rows, totals } = await usersList(d, queues);
    const sortKey = SORTS[String(req.query.sort)] ? String(req.query.sort) : 'active';
    rows.sort(SORTS[sortKey][1] as never);
    const sortLinks = Object.entries(SORTS)
      .map(([k, [label]]) => (k === sortKey ? `<b>${label}</b>` : `<a href="?sort=${k}">${label}</a>`))
      .join(' · ');
    const body = `
<h1>Users</h1><p class="sub">Everyone with a CrestClip account. Click a person to see their credits, videos and jobs.
To change someone's plan or credits, use the <a href="/app/admin">admin page in the app</a>.</p>
<div class="grid">
  ${card('People', String(totals.users), `${totals.newThisWeek} new this week`)}
  ${card('Active this week', String(totals.activeThisWeek), 'signed in or clipped a video')}
  ${card('Paying', String(totals.paying), 'with a subscription')}
  ${card('Videos, last 30 days', String(totals.videos30), `${totals.used30.toLocaleString()} credits used`)}
  ${card('Jobs right now', `${totals.running} running`, `${totals.waiting} waiting · <a href="/admin/running">see them</a>`)}
</div>
<h2>Everyone</h2>
<input class="search" id="q" placeholder="Search by email or name…" autocomplete="off">
<p class="small muted">Sort: ${sortLinks}</p>
<div class="wrap"><table id="t"><tr><th>Person</th><th>Plan</th><th class="n">Credits left</th><th class="n">Used (30 d)</th><th class="n">Videos</th><th>Jobs now</th><th>Last active</th><th>Joined</th></tr>
${rows
  .map(
    (r) => `<tr class="row" data-s="${esc((r.email + ' ' + r.name).toLowerCase())}" onclick="location.href='/admin/users/${encodeURIComponent(r.id)}'">
  <td><a class="plain" href="/admin/users/${encodeURIComponent(r.id)}"><b>${esc(r.email)}</b>${r.isAdmin ? ' ' + pill('admin') : ''}${r.name ? `<br><span class="small muted">${esc(r.name)}</span>` : ''}</a></td>
  <td>${plan(r.plan, r.paying)}</td>
  <td class="n">${r.credits.toLocaleString()}</td>
  <td class="n">${r.used30.toLocaleString()}</td>
  <td class="n">${r.videos}${r.videos30 ? ` <span class="small muted">(${r.videos30} this month)</span>` : ''}</td>
  <td>${r.running ? pill(`${r.running} running`, 'warn') : ''} ${r.waiting ? pill(`${r.waiting} waiting`) : ''}${!r.running && !r.waiting ? '<span class="muted">—</span>' : ''}</td>
  <td>${ago(r.lastActive)}</td>
  <td>${r.joined ? new Date(r.joined).toISOString().slice(0, 10) : '—'}</td></tr>`,
  )
  .join('')}
</table></div>
<script>
const q = document.getElementById('q');
q.addEventListener('input', () => { const v = q.value.trim().toLowerCase();
  for (const tr of document.querySelectorAll('#t tr[data-s]')) tr.style.display = !v || tr.dataset.s.includes(v) ? '' : 'none'; });
</script>`;
    res.type('html').send(layout('Users', 'users', body));
  }),
);

app.get(
  '/admin/users/:id',
  wrap(async (req, res) => {
    const d = await mongo();
    const u = d ? await userDetail(d, queues, String(req.params.id)) : null;
    if (!u) return void res.status(404).type('html').send(layout('Not found', 'users', '<h1>No such person</h1><p class="sub"><a href="/admin/users">Back to Users</a></p>'));
    const p = u.user;
    const working = u.projects.filter((x) => x.queue);
    const body = `
<p class="small"><a href="/admin/users">← All users</a></p>
<h1>${esc(p.email)}</h1>
<p class="sub">${p.name ? esc(p.name) + ' · ' : ''}${plan(p.plan, p.paying)}${p.cancelAtPeriodEnd ? ' ' + pill('cancels at period end', 'warn') : ''}${p.isAdmin ? ' ' + pill('admin') : ''} · joined ${p.joined ? new Date(p.joined).toISOString().slice(0, 10) : '—'}
${u.connections.length ? ' · connected: ' + u.connections.map((c) => `${esc(c.platform)} (${esc(c.name)})`).join(', ') : ''}
· <a href="/app/admin">change plan or credits</a></p>
<div class="grid">
  ${card('Credits left', u.credits.toLocaleString(), u.grants[0] ? `next expiry ${new Date(u.grants[0].expiresAt).toISOString().slice(0, 10)}` : 'no live credits')}
  ${card('Used, last 30 days', u.used30.toLocaleString(), 'credits')}
  ${card('Videos', String(u.projects.length >= 60 ? '60+' : u.projects.length), `${u.projects.filter((x) => x.status === 'done').length} done · ${u.projects.filter((x) => x.status === 'failed').length} failed`)}
  ${card('Jobs right now', `${working.filter((x) => x.queue!.state === 'running').length} running`, `${working.filter((x) => x.queue!.state === 'waiting').length} waiting`)}
</div>

${
  working.length
    ? `<h2>Working on now</h2><div class="wrap"><table><tr><th>Video</th><th>State</th><th>Step</th><th></th><th>Since</th></tr>
${working.map((x) => `<tr><td>${esc(x.title)}</td><td>${x.queue!.state === 'running' ? pill('running', 'warn') : pill(x.queue!.ahead ? `waiting · ${x.queue!.ahead} ahead` : 'next in line')}</td><td class="small">${esc(x.stageDetail || x.stage || '')}</td><td style="width:140px">${bar(x.progress / 100)}</td><td>${ago(x.queue!.since)}</td></tr>`).join('')}
</table></div>`
    : ''
}

<h2>Videos (newest first)</h2>
${
  u.projects.length
    ? `<div class="wrap"><table><tr><th>Video</th><th>Status</th><th class="n">Clips</th><th class="n">Length</th><th class="n">Credits</th><th>Made</th></tr>
${u.projects.map((x) => `<tr><td>${esc(x.title)}${x.error && x.status === 'failed' ? `<br><span class="small muted">${esc(x.error.slice(0, 160))}</span>` : ''}</td><td>${status(x.status)}${x.status === 'processing' ? ` <span class="small muted">${Math.round(x.progress)}%</span>` : ''}</td><td class="n">${x.clips.ready}/${x.clips.all}</td><td class="n">${x.minutes != null ? x.minutes + ' min' : '—'}</td><td class="n">${x.credits || '—'}</td><td>${ago(x.createdAt)}</td></tr>`).join('')}
</table></div>`
    : '<p class="note">No videos yet.</p>'
}

<h2>Credits they hold</h2>
${
  u.grants.length
    ? `<div class="wrap"><table><tr><th>From</th><th class="n">Left</th><th class="n">Of</th><th>Expires</th></tr>
${u.grants.map((g) => `<tr><td>${esc(g.source)}</td><td class="n">${g.remaining.toLocaleString()}</td><td class="n">${g.amount.toLocaleString()}</td><td>${new Date(g.expiresAt).toISOString().slice(0, 10)}</td></tr>`).join('')}
</table></div>`
    : '<p class="note">None right now.</p>'
}

<h2>Credit history (last 40)</h2>
${
  u.events.length
    ? `<div class="wrap"><table><tr><th>When</th><th>What</th><th class="n">Change</th><th>Note</th></tr>
${u.events.map((e) => `<tr><td>${ago(e.at)}</td><td>${esc(({ spend: 'Used', topup: 'Top-up', grant: 'Plan credits', refund: 'Refund', adjust: 'Adjusted by admin' } as Record<string, string>)[e.kind] ?? e.kind)}${e.refunded ? ' ' + pill('refunded') : ''}</td><td class="n" style="color:var(${e.delta >= 0 ? '--ok' : '--ink'})">${e.delta > 0 ? '+' : ''}${e.delta.toLocaleString()}</td><td class="small">${esc(e.note)}</td></tr>`).join('')}
</table></div>`
    : '<p class="note">No credit changes yet.</p>'
}

${
  u.posts.length
    ? `<h2>Posts (last 15)</h2><div class="wrap"><table><tr><th>Where</th><th>Title</th><th>Status</th><th>When</th></tr>
${u.posts.map((x) => `<tr><td>${esc(x.platform)}</td><td>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || 'open')}</a>` : esc(x.title)}${x.error ? `<br><span class="small muted">${esc(x.error.slice(0, 140))}</span>` : ''}</td><td>${({ published: pill('posted', 'ok'), scheduled: pill('booked'), uploading: pill('uploading', 'warn'), processing: pill('uploading', 'warn'), failed: pill('failed', 'bad'), canceled: pill('canceled') } as Record<string, string>)[x.status] ?? pill(x.status)}</td><td>${ago(x.at)}</td></tr>`).join('')}
</table></div>`
    : ''
}`;
    res.type('html').send(layout(p.email, 'users', body, working.length ? 20 : 0));
  }),
);

// ---------------- Running now ----------------
app.get(
  '/admin/running',
  wrap(async (_req, res) => {
    const d = await mongo();
    if (!d) return void res.type('html').send(layout('Running now', 'running', '<h1>Running now</h1><p class="sub">Needs the database (MONGODB_URI).</p>'));
    const jobs = await runningNow(d, queues);
    const run = jobs.filter((j) => j.state === 'running');
    const wait = jobs.filter((j) => j.state === 'waiting');
    const kind = (k: string) => ({ project: 'Clip a video', render: 'Render a clip', pick: 'Picked parts' })[k] ?? k;
    const row = (j: (typeof jobs)[number]) => `<tr>
  <td>${esc(j.title)}</td>
  <td>${j.userId ? `<a href="/admin/users/${encodeURIComponent(j.userId)}">${esc(j.email)}</a>` : '—'}</td>
  <td>${kind(j.kind)}</td>
  <td>${j.state === 'running' ? pill('running', 'warn') : pill(j.ahead ? `${j.ahead} ahead` : 'next', '')}</td>
  <td class="small">${esc(j.stage)}</td>
  <td style="width:120px">${j.state === 'running' && j.kind === 'project' ? bar(j.progress / 100) : ''}</td>
  <td>${ago(j.since)}</td>
  <td class="small muted">${esc(j.worker ?? '')}</td>
  <td><a href="/admin/queues/queue/${j.queue}?status=${j.state === 'running' ? 'active' : 'waiting'}">log</a></td></tr>`;
    const head = '<tr><th>Video</th><th>Person</th><th>Job</th><th>State</th><th>Step</th><th></th><th>Since</th><th>Worker</th><th></th></tr>';
    const body = `
<h1>Running now</h1><p class="sub">Every job being worked on or waiting in line, and whose it is. Refreshes every 10 seconds.</p>
<div class="grid">
  ${card('Running', String(run.length), 'being worked on')}
  ${card('Waiting', String(wait.length), wait.length ? `longest ${ago(Math.min(...wait.map((j) => j.since))).replace(' ago', '')}` : 'nobody waiting')}
</div>
<h2>Running</h2>${run.length ? `<div class="wrap"><table>${head}${run.map(row).join('')}</table></div>` : '<p class="note">Nothing running right now.</p>'}
<h2>Waiting in line</h2>${wait.length ? `<div class="wrap"><table>${head}${wait.map(row).join('')}</table></div>` : '<p class="note">Nobody waiting.</p>'}`;
    res.type('html').send(layout('Running now', 'running', body, 10));
  }),
);

// ---------------- Costs ----------------
app.get(
  '/admin/costs',
  wrap(async (_req, res) => {
    const fixed = await fixedCosts();
    const split = serverSplit(fixed.serverPerMonth);
    const d = await mongo().catch(() => null);
    const ai = d ? await aiCosts(d, 30).catch((e) => ({ error: (e as Error).message }) as const) : null;
    const bill = await realBill();
    const aiMonth = ai && !('error' in ai) ? ai.total : 0;

    const billHtml = bill
      ? bill.error
        ? `<p class="note">${dot('warn')}Couldn't read the billing export: ${esc(bill.error)}</p>`
        : `<div class="wrap"><table><tr><th>Google service</th><th class="n">This month so far</th><th class="n">Last 30 days</th><th></th></tr>
${bill.rows.map((r) => `<tr><td>${esc(r.service)}</td><td class="n">${usd(r.thisMonth)}</td><td class="n">${usd(r.last30)}</td><td style="width:160px">${bar(r.last30 / Math.max(...bill.rows.map((x) => x.last30), 0.01))}</td></tr>`).join('')}
<tr><td><b>Total</b></td><td class="n"><b>${usd(bill.rows.reduce((s, r) => s + r.thisMonth, 0))}</b></td><td class="n"><b>${usd(bill.rows.reduce((s, r) => s + r.last30, 0))}</b></td><td></td></tr></table></div>
<p class="note">Real numbers from Google's billing export (after free credits and discounts), in ${esc(bill.currency)}. Updated a few times a day.</p>`
      : `<p class="note">${dot('warn')}Not switched on yet. Turn on Google's billing export to see the real bill per service here — see <b>devops/docs/first-time-setup.md → step 6</b>. Until then, the numbers below are estimates.</p>`;

    const aiHtml = !ai
      ? '<p class="note">Needs the database (MONGODB_URI).</p>'
      : 'error' in ai
        ? `<p class="note">${dot('warn')}${esc(ai.error)}</p>`
        : `<div class="grid">
  ${card('AI spend, last 30 days', usd(ai.total), `${ai.projects} videos clipped`)}
  ${card('Per video, average', usd(ai.perProject, 3), 'AI calls only')}
  ${card('Per day, average', usd(ai.total / ai.days, 2), '')}
</div>
<div class="card" style="margin-top:12px"><div class="k">AI spend per day (last 30 days)</div>${spark(ai.series.map((s) => s.cost))}<div class="s">${esc(ai.series[0]?.day)} → ${esc(ai.series.at(-1)?.day)}</div></div>
<h2>By model</h2><div class="wrap"><table><tr><th>Model</th><th class="n">Calls</th><th class="n">Tokens</th><th class="n">Cost</th><th></th></tr>
${ai.byModel.map((m) => `<tr><td>${esc(m.model)}</td><td class="n">${m.calls.toLocaleString()}</td><td class="n">${(m.tokens / 1e6).toFixed(1)} M</td><td class="n">${usd(m.cost)}</td><td style="width:160px">${bar(m.cost / Math.max(ai.total, 0.01))}</td></tr>`).join('')}</table></div>
<h2>By step (what the AI was asked to do)</h2><div class="wrap"><table><tr><th>Step</th><th class="n">Calls</th><th class="n">Cost</th><th></th></tr>
${ai.byStep.map((s) => `<tr><td>${esc(s.step)}</td><td class="n">${s.calls.toLocaleString()}</td><td class="n">${usd(s.cost)}</td><td style="width:160px">${bar(s.cost / Math.max(ai.total, 0.01))}</td></tr>`).join('')}</table></div>
<h2>Who uses the most</h2><div class="wrap"><table><tr><th>Person</th><th class="n">Videos</th><th class="n">AI cost</th></tr>
${ai.topUsers.map((u) => `<tr><td>${esc(u.email)}</td><td class="n">${u.projects}</td><td class="n">${usd(u.cost)}</td></tr>`).join('')}</table></div>
<h2>Most expensive videos</h2><div class="wrap"><table><tr><th>Video</th><th>When</th><th class="n">AI calls</th><th class="n">Cost</th></tr>
${ai.topProjects.map((p) => `<tr><td>${esc(p.title)}</td><td>${new Date(p.at).toISOString().slice(0, 10)}</td><td class="n">${p.calls}</td><td class="n">${usd(p.cost, 3)}</td></tr>`).join('')}</table></div>
<p class="note">Estimates: tokens saved with each project × the prices in devops/dashboard/prices.json (checked ${esc(ai.checked)}). ${esc(ai.assumptions)} Background music (Lyria) isn't counted here.</p>`;

    const body = `
<h1>Costs</h1><p class="sub">What CrestClip costs to run, and which part uses how much.</p>
<div class="grid">
  ${card('Fixed, per month', usd(fixed.total), 'server, disk, IP and the extras you listed')}
  ${card('AI, last 30 days', ai && !('error' in ai) ? usd(aiMonth) : '—', 'estimate from token counts')}
  ${card('Estimated total / month', usd(fixed.total + aiMonth), 'fixed + last 30 days of AI')}
</div>

<h2>Real bill from Google</h2>${billHtml}

<h2>Fixed monthly costs</h2>
<div class="wrap"><table><tr><th>What</th><th class="n">Per month</th></tr>
${fixed.lines.map((l) => `<tr><td>${esc(l.name)}${l.note ? ` <span class="pill">${esc(l.note)}</span>` : ''}</td><td class="n">${usd(l.perMonth)}</td></tr>`).join('')}
<tr><td><b>Total</b></td><td class="n"><b>${usd(fixed.total)}</b></td></tr></table></div>
<p class="note">Edit these in devops/dashboard/prices.json (for example your DataImpulse spend or domain price).</p>

<h2>Who uses the server (${esc(fixed.machine)}, ${usd(fixed.serverPerMonth)}/month)</h2>
${
  split && split.samples
    ? `<div class="wrap"><table><tr><th>Part</th><th class="n">Average CPU</th><th></th><th class="n">Share of the server's price</th></tr>
${split.rows.map((r) => `<tr><td>${esc(r.group)}</td><td class="n">${r.cpu}%</td><td style="width:160px">${bar(r.share)}</td><td class="n">${usd(r.perMonth)}</td></tr>`).join('')}
<tr><td>Idle (unused)</td><td class="n">${split.idle}%</td><td></td><td class="n"></td></tr></table></div>
<p class="note">Average over the last ${split.hours} hours (sampled every 30 seconds since this page's container started). The server costs the same whether busy or idle — this shows who uses it. Lots of idle time means a smaller, cheaper machine would do.</p>`
    : '<p class="note">Collecting CPU samples — check back in a few minutes (needs the Docker socket, so only on the server).</p>'
}

<h2>AI (Gemini) — last 30 days</h2>${aiHtml}`;
    res.type('html').send(layout('Costs', 'costs', body));
  }),
);

app.get('/admin/healthz', (_req, res) => void res.json({ ok: true }));
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[dashboard]', err);
  res.status(500).type('html').send(layout('Error', 'overview', `<h1>Something went wrong</h1><p class="sub">${esc(err.message)}</p>`));
});

startSampling();
app.listen(PORT, HOST, () => console.log(`  CrestClip admin pages → http://${HOST}:${PORT}/admin/`));
