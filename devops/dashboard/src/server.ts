/**
 * CrestClip admin pages — its own small container (see devops/server/docker-compose.prod.yml), on 127.0.0.1:8790.
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
import { bar, card, dot, esc, layout, spark, usd } from './pages.js';
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
    const body = `
<h1>Overview</h1><p class="sub">${esc(vm.name ?? 'this machine')}${vm.machineType ? ` · ${esc(vm.machineType)} · ${esc(vm.zone)}` : ''} · refreshes every 20 seconds</p>
<div class="grid">
  ${card('Website', `${dot(webUp === o.web.length ? 'ok' : webUp ? 'warn' : 'bad')}${webUp} of ${o.web.length} up`, o.web.map((w) => `:${w.port} ${w.ok ? `${w.ms} ms` : 'down'}`).join(' · '))}
  ${card('Workers connected', `${dot(workers ? 'ok' : 'bad')}${workers}`, workers ? 'taking video jobs' : 'no worker is taking jobs!')}
  ${card('Jobs running', String(busy), `${waiting} waiting in line`)}
  ${card('Failed jobs', `${dot(failed ? 'warn' : 'ok')}${failed}`, failed ? '<a href="/admin/queues/">see why →</a>' : 'nothing failed recently')}
  ${o.disk ? card('Disk', `${o.disk.pct}%`, `${o.disk.usedGb} of ${o.disk.totalGb} GB used`) : ''}
  ${card('Redis memory', `${o.redis.usedMb} MB`, o.redis.maxMb ? `limit ${o.redis.maxMb} MB` : 'no limit set')}
</div>

<h2>Job queues</h2>
<div class="wrap"><table><tr><th>Queue</th><th class="n">Workers</th><th class="n">Running</th><th class="n">Waiting</th><th class="n">Failed</th><th class="n">Done (kept 2 days)</th></tr>
${o.queues.map((q) => `<tr><td><a href="/admin/queues/queue/${q.name}">${esc(q.label)}</a></td><td class="n">${q.workers}</td><td class="n">${q.active ?? 0}</td><td class="n">${q.waiting}</td><td class="n">${q.failed ?? 0}</td><td class="n">${q.completed ?? 0}</td></tr>`).join('')}
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
      : `<p class="note">${dot('warn')}Not switched on yet. Turn on Google's billing export to see the real bill per service here — see <b>devops/README.md → step 6</b>. Until then, the numbers below are estimates.</p>`;

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
