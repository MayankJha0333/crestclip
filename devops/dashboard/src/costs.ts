import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from 'mongodb';
import { cpuAverages, dockerAvailable } from './docker.js';
import { realBill, vmInfo } from './gcp.js';

/**
 * The Costs page's numbers.
 *   - Fixed monthly: the server, its disk and IP, plus anything listed in prices.json → otherMonthly.
 *   - Who uses the server: the server's monthly price split by each part's average CPU share.
 *   - AI: every project saves its AI usage (tokens by model and kind) — priced with prices.json.
 *   - Real bill: Google's billing export, when switched on (always better than the estimates).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
type ModelPrice = { input: number; audio: number; cached: number; output: number };
interface Prices {
  _checked: string;
  server: { machinePerMonth: Record<string, Record<string, number>>; diskPerGbMonth: number; publicIpPerMonth: number };
  ai: { modelsPerMillionTokens: Record<string, ModelPrice>; fallbackModel: string; _source: string; _assumptions: string };
  otherMonthly: { name: string; perMonth: number }[];
}
export const prices = (): Prices => JSON.parse(fs.readFileSync(path.join(here, '..', 'prices.json'), 'utf8')) as Prices;

/** Size of the disk the data folder lives on, in GB (statfs of the mounted folder). */
function diskGb(): { total: number; used: number } | null {
  try {
    const dir = process.env.DATA_DIR || '/data';
    const s = fs.statfsSync(dir);
    const total = (s.blocks * s.bsize) / 1e9;
    const free = (s.bavail * s.bsize) / 1e9;
    return { total: Math.round(total), used: Math.round(total - free) };
  } catch {
    return null;
  }
}

export interface FixedLine {
  name: string;
  perMonth: number;
  note?: string;
}
export async function fixedCosts(): Promise<{ lines: FixedLine[]; total: number; serverPerMonth: number; machine: string }> {
  const p = prices();
  const vm = await vmInfo();
  const machine = vm.machineType ?? process.env.MACHINE_TYPE ?? 'e2-standard-4';
  const region = vm.region ?? process.env.REGION ?? 'asia-south1';
  const serverPerMonth = p.server.machinePerMonth[region]?.[machine] ?? 0;
  const disk = diskGb();
  const lines: FixedLine[] = [
    { name: `Server · ${machine} in ${region}`, perMonth: serverPerMonth, note: serverPerMonth ? 'on-demand price' : 'not in prices.json — add it' },
    { name: `Disk · ${disk ? `${disk.total} GB (${disk.used} GB used)` : 'size unknown'}`, perMonth: disk ? +(disk.total * p.server.diskPerGbMonth).toFixed(2) : 0 },
    { name: 'Public IP address', perMonth: p.server.publicIpPerMonth },
    ...p.otherMonthly.map((o) => ({ name: o.name, perMonth: o.perMonth })),
  ];
  return { lines, total: +lines.reduce((s, l) => s + l.perMonth, 0).toFixed(2), serverPerMonth, machine };
}

/** The server's monthly price split by how much CPU each part used on average. */
export function serverSplit(serverPerMonth: number) {
  if (!dockerAvailable()) return null;
  const { byGroup, hours, samples } = cpuAverages();
  const busy = Object.values(byGroup).reduce((a, b) => a + b, 0);
  const rows = Object.entries(byGroup)
    .map(([group, cpu]) => ({ group, cpu, share: busy > 0 ? cpu / busy : 0 }))
    .sort((a, b) => b.cpu - a.cpu)
    .map((r) => ({ ...r, perMonth: +(r.share * serverPerMonth).toFixed(2) }));
  return { rows, busy: +busy.toFixed(1), idle: +Math.max(0, 100 - busy).toFixed(1), hours: +hours.toFixed(1), samples };
}

// ---------------- AI (Gemini) ----------------
interface LabelRow {
  label: string;
  model: string;
  calls: number;
  text: number;
  audio: number;
  video: number;
  image: number;
  cached: number;
  output: number;
}
function priceOf(model: string, p: Prices): ModelPrice {
  const list = p.ai.modelsPerMillionTokens;
  return list[model] ?? list[Object.keys(list).find((k) => model.startsWith(k)) ?? ''] ?? list[p.ai.fallbackModel];
}
/** Cost of one ledger row: prompt tokens (cached ones at the cached rate) + answer tokens. */
function costOf(r: LabelRow, p: Prices): number {
  const m = priceOf(r.model, p);
  const cached = Math.min(r.cached, r.text + r.video + r.image + r.audio);
  const textLike = Math.max(0, r.text + r.video + r.image - cached);
  return (textLike * m.input + r.audio * m.audio + cached * m.cached + r.output * m.output) / 1e6;
}

export async function aiCosts(db: Db, days = 30) {
  const p = prices();
  const since = Date.now() - days * 86400_000;
  const rows = await db
    .collection('projects')
    .find({ createdAt: { $gte: since }, aiUsage: { $ne: null } }, { projection: { userId: 1, title: 1, createdAt: 1, aiUsage: 1 } })
    .toArray();
  const byDay = new Map<string, number>();
  const byUser = new Map<string, { cost: number; projects: number }>();
  const byModel = new Map<string, { cost: number; calls: number; tokens: number }>();
  const byStep = new Map<string, { cost: number; calls: number }>();
  const projects: { id: string; title: string; userId: string; at: number; cost: number; calls: number }[] = [];
  let total = 0;
  for (const d of rows) {
    const usage = d.aiUsage as { byLabel?: LabelRow[] } | null;
    if (!usage?.byLabel?.length) continue;
    let cost = 0;
    let calls = 0;
    for (const r of usage.byLabel) {
      const c = costOf(r, p);
      cost += c;
      calls += r.calls;
      const m = byModel.get(r.model) ?? { cost: 0, calls: 0, tokens: 0 };
      m.cost += c;
      m.calls += r.calls;
      m.tokens += r.text + r.audio + r.video + r.image + r.output;
      byModel.set(r.model, m);
      const s = byStep.get(r.label) ?? { cost: 0, calls: 0 };
      s.cost += c;
      s.calls += r.calls;
      byStep.set(r.label, s);
    }
    total += cost;
    const day = new Date(Number(d.createdAt)).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + cost);
    const u = byUser.get(String(d.userId)) ?? { cost: 0, projects: 0 };
    u.cost += cost;
    u.projects++;
    byUser.set(String(d.userId), u);
    projects.push({ id: String(d._id), title: String(d.title ?? 'Untitled'), userId: String(d.userId), at: Number(d.createdAt), cost, calls });
  }
  // names for the people (email)
  const topUsers = [...byUser.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 10);
  const people = await db
    .collection('users')
    .find({ _id: { $in: topUsers.map(([id]) => id) } } as never, { projection: { email: 1 } })
    .toArray();
  const email = new Map(people.map((u) => [String(u._id), String(u.email ?? '')]));
  const series: { day: string; cost: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    series.push({ day, cost: +(byDay.get(day) ?? 0).toFixed(4) });
  }
  return {
    days,
    total: +total.toFixed(2),
    projects: projects.length,
    perProject: projects.length ? +(total / projects.length).toFixed(3) : 0,
    series,
    byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v, cost: +v.cost.toFixed(2) })).sort((a, b) => b.cost - a.cost),
    byStep: [...byStep.entries()].map(([step, v]) => ({ step, ...v, cost: +v.cost.toFixed(2) })).sort((a, b) => b.cost - a.cost).slice(0, 12),
    topUsers: topUsers.map(([id, v]) => ({ id, email: email.get(id) || id, projects: v.projects, cost: +v.cost.toFixed(2) })),
    topProjects: projects.sort((a, b) => b.cost - a.cost).slice(0, 10).map((x) => ({ ...x, cost: +x.cost.toFixed(3) })),
    source: p.ai._source,
    assumptions: p.ai._assumptions,
    checked: p._checked,
  };
}

export { realBill };
