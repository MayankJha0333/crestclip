import { Link } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Clapperboard, History, RotateCcw, Search, Sparkles } from 'lucide-react';
import { api, type CreditEvent, type CreditHistoryType, type CreditUsage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { Button, Card, CardHeader, EmptyState, Input, PageHeader, Segmented, Skeleton } from '../../components/ui';
import { CreditEventRow } from './CreditEventRow';

type Range = '7' | '30' | '90' | '365';
const RANGES: { value: Range; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];
const TYPES: { value: CreditHistoryType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'used', label: 'Used' },
  { value: 'added', label: 'Added' },
  { value: 'refunds', label: 'Given back' },
  { value: 'plan', label: 'Plan changes' },
];

const dayLabel = (iso: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, opts);

/** "Today", "Yesterday", "Mon 6 Oct", "12 Aug 2025" — the heading over a day's lines. */
function dayHeading(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

/**
 * Credit history: where the credits went (totals, a day-by-day chart, the videos that used the most) and the full
 * list of every credit added or used and every plan change — filterable and searchable.
 */
export function CreditHistoryPage() {
  const [range, setRange] = useState<Range>('30');
  const [type, setType] = useState<CreditHistoryType>('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [usage, setUsage] = useState<CreditUsage | null>(null);
  const [items, setItems] = useState<CreditEvent[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const days = Number(range);

  // the search waits for a pause in typing
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setUsage(null);
    api
      .creditUsage(days)
      .then(setUsage)
      .catch((e) => toast((e as Error).message, 'error'));
  }, [days]);

  const ask = useRef(0);
  useEffect(() => {
    const n = ++ask.current;
    setItems(null);
    api
      .creditHistory({ type, days, q: query })
      .then((r) => {
        if (n !== ask.current) return; // a newer filter was picked meanwhile
        setItems(r.items);
        setNext(r.nextBefore);
      })
      .catch((e) => toast((e as Error).message, 'error'));
  }, [type, days, query]);

  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    try {
      const r = await api.creditHistory({ type, days, q: query, before: next });
      setItems((cur) => [...(cur ?? []), ...r.items]);
      setNext(r.nextBefore);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setMore(false);
    }
  };

  // the list, grouped under a heading per day
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: CreditEvent[] }[] = [];
    for (const e of items ?? []) {
      const key = new Date(e.createdAt).toDateString();
      if (out.at(-1)?.key !== key) out.push({ key, label: dayHeading(e.createdAt), items: [] });
      out.at(-1)!.items.push(e);
    }
    return out;
  }, [items]);

  return (
    <>
      <PageHeader
        back={{ to: '/app/billing', label: 'Plan & credits' }}
        title="Credit history"
        description="Every credit added and used, and every plan change. Each clip uses 5 credits; clips that don’t come out give theirs back."
        actions={<Segmented label="Period" size="sm" value={range} options={RANGES} onChange={setRange} />}
      />

      {/* totals for the period */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Total icon={<ArrowUpRight size={20} />} tone="bg-orange-bg text-orange-ink" label="Credits used" value={usage?.totals.used} />
        <Total icon={<Clapperboard size={20} />} tone="bg-lilac/25 text-[#5b45c9] dark:text-lilac" label="Clips made" value={usage?.totals.clips} />
        <Total icon={<ArrowDownLeft size={20} />} tone="bg-good-bg text-good-ink" label="Credits added" value={usage?.totals.added} />
        <Total icon={<RotateCcw size={20} />} tone="bg-info-bg text-info-ink" label="Given back" value={usage?.totals.refunded} />
      </div>

      {/* where they went */}
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Card className="p-5 sm:p-6">
          <CardHeader title="Credits used" description={`Per ${days > 90 ? 'week' : 'day'}, last ${RANGES.find((r) => r.value === range)!.label}`} />
          {usage ? <UsageChart usage={usage} /> : <Skeleton className="h-48" />}
        </Card>
        <Card className="p-5 sm:p-6">
          <CardHeader title="Top videos" description="The videos that used the most credits" />
          {!usage ? (
            <Skeleton className="h-48" />
          ) : usage.projects.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-3">No videos clipped in this period.</p>
          ) : (
            <ul className="grid gap-3.5">
              {usage.projects.map((p) => (
                <li key={p.id} className="text-sm">
                  <span className="flex items-baseline justify-between gap-3">
                    {p.exists ? (
                      <Link to={`/app/p/${p.id}`} className="min-w-0 truncate font-semibold text-ink no-underline hover:text-accent">
                        {p.title}
                      </Link>
                    ) : (
                      <span className="min-w-0 truncate font-semibold text-ink-3">{p.title} (deleted)</span>
                    )}
                    <span className="shrink-0 text-xs text-ink-3 tabular-nums">
                      <b className="font-display text-sm text-ink">{p.used.toLocaleString()}</b> · {p.clips} clip{p.clips === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-sunken">
                    <span className="block h-full rounded-full bg-tangerine" style={{ width: `${(p.used / usage.projects[0].used) * 100}%` }} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* every line */}
      <Card className="mt-6 p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <Segmented label="Show" size="sm" value={type} options={TYPES} onChange={setType} />
          <label className="relative w-full sm:w-64">
            <Search size={16} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search history" aria-label="Search history" className="py-2.5 pl-10 text-sm" />
          </label>
        </div>

        {items === null ? (
          <div className="grid gap-3">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState compact icon={<History size={26} />} title="Nothing here">
            {query || type !== 'all' ? 'No lines match this filter. Try another type, a longer period or a different search.' : 'No credit activity in this period yet.'}
          </EmptyState>
        ) : (
          <>
            {groups.map((g) => (
              <section key={g.key} className="mt-2 first:mt-0">
                <h3 className="sticky top-0 z-[1] -mx-1 bg-surface/95 px-1 pt-3 pb-1 text-xs font-extrabold tracking-wider text-ink-3 uppercase backdrop-blur">{g.label}</h3>
                <ul className="divide-y divide-line">
                  {g.items.map((e) => (
                    <CreditEventRow key={e.id} e={e} timeOnly />
                  ))}
                </ul>
              </section>
            ))}
            {next && (
              <div className="mt-4 flex justify-center">
                <Button size="sm" variant="ghost" onClick={loadMore} loading={more}>
                  Show older
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

function Total({ icon, tone, label, value }: { icon: React.ReactNode; tone: string; label: string; value: number | undefined }) {
  return (
    <div className="flex min-w-0 items-center gap-3.5 rounded-[22px] bg-surface p-4 shadow-clay-sm sm:px-5">
      <span className={cn('grid size-11 shrink-0 place-items-center rounded-2xl', tone)} aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">
        <b className="block font-display text-[26px] leading-tight tracking-tight tabular-nums">{value === undefined ? '—' : value.toLocaleString()}</b>
        <span className="text-[13px] font-extrabold text-ink-2">{label}</span>
      </span>
    </div>
  );
}

/** Bars of credits used per day (per week for long periods). Hover a bar for its numbers. */
function UsageChart({ usage }: { usage: CreditUsage }) {
  const weekly = usage.days > 90;
  const bars = useMemo(() => {
    if (!weekly) return usage.daily.map((d) => ({ from: d.day, to: d.day, used: d.used, added: d.added }));
    const out: { from: string; to: string; used: number; added: number }[] = [];
    for (let i = 0; i < usage.daily.length; i += 7) {
      const w = usage.daily.slice(i, i + 7);
      out.push({ from: w[0].day, to: w.at(-1)!.day, used: w.reduce((n, d) => n + d.used, 0), added: w.reduce((n, d) => n + d.added, 0) });
    }
    return out;
  }, [usage, weekly]);
  const max = Math.max(...bars.map((b) => b.used), 0);
  if (max === 0)
    return (
      <div className="grid h-48 place-items-center rounded-2xl bg-sunken text-center text-sm text-ink-3">
        <span>
          <Sparkles size={18} className="mx-auto mb-1.5 text-ink-3" aria-hidden />
          No credits used in this period.
        </span>
      </div>
    );
  const label = (b: (typeof bars)[number]) => (b.from === b.to ? dayLabel(b.from) : `${dayLabel(b.from)} – ${dayLabel(b.to)}`);
  const ticks = [0, Math.floor((bars.length - 1) / 2), bars.length - 1];
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs text-ink-3">
        <span>
          Busiest {weekly ? 'week' : 'day'}: <b className="text-ink">{max.toLocaleString()}</b> credits
        </span>
        <span>
          Average <b className="text-ink">{Math.round(usage.totals.used / bars.length).toLocaleString()}</b> / {weekly ? 'week' : 'day'}
        </span>
      </div>
      <div className="mt-3 flex h-44 items-end gap-[3px] border-b border-line" role="img" aria-label={`Credits used per ${weekly ? 'week' : 'day'}`}>
        {bars.map((b) => (
          <div key={b.from} className="group relative flex h-full min-w-0 flex-1 items-end">
            <div
              className={cn('w-full rounded-t-[4px] transition-colors', b.used ? 'bg-tangerine/80 group-hover:bg-tangerine' : 'bg-sunken')}
              style={{ height: b.used ? `${Math.max(3, (b.used / max) * 100)}%` : '2px' }}
            />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-xl bg-ink px-3 py-2 text-xs text-on-ink shadow-clay-sm group-hover:block">
              <b className="block">{label(b)}</b>
              {b.used.toLocaleString()} used{b.added ? ` · ${b.added.toLocaleString()} added` : ''}
            </div>
          </div>
        ))}
      </div>
      <div className="relative mt-1.5 h-4 text-[11px] text-ink-3">
        {ticks.map((i, n) => (
          <span key={n} className={cn('absolute', n === 0 ? 'left-0' : n === 2 ? 'right-0' : 'left-1/2 -translate-x-1/2')}>
            {dayLabel(bars[i].from)}
          </span>
        ))}
      </div>
    </div>
  );
}
