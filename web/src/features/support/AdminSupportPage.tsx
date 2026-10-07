import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  Film,
  Globe,
  Inbox,
  Mail,
  MailOpen,
  MessageSquareText,
  Monitor,
  RefreshCw,
  Reply,
  Search,
  Send,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { api, type AdminTicket, type AdminTicketSummary, type TicketCategory, type TicketCounts, type TicketPriority, type TicketStatus } from '../../lib/api';
import { cn } from '../../lib/cn';
import { timeAgo } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Badge, Button, Card, EmptyState, Input, PageHeader, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { useAuth } from '../auth/auth';
import { CATEGORIES, categoryOf, StatusBadge, statusLabel, Thread, when } from './ticketUi';

type View = 'active' | TicketStatus | 'all';
const VIEW_LABEL: Record<View, string> = { active: 'Active', open: 'Needs reply', in_progress: 'In progress', waiting: 'Waiting', resolved: 'Resolved', closed: 'Closed', all: 'All' };
const PRIORITIES: { value: TicketPriority; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

/** Ready-made answers for the common cases — dropped into the reply box to edit before sending. */
const TEMPLATES: { label: string; body: (name: string) => string }[] = [
  { label: 'Looking into it', body: (n) => `Hi ${n}, thanks for letting us know! We’re looking into this now and will get back to you here shortly.` },
  { label: 'Need more details', body: (n) => `Hi ${n}, thanks for reaching out. Could you share a bit more — what you clicked, what you expected to happen, and what you saw instead? A screenshot helps too.` },
  { label: 'Refund done', body: (n) => `Hi ${n}, we’ve refunded the payment. It goes back to the original card or UPI account and usually shows up within 5–7 working days.` },
  { label: 'Credits added', body: (n) => `Hi ${n}, we’ve added the credits back to your account — you’ll see them on Plan & credits. Sorry for the trouble!` },
  { label: 'Fixed', body: (n) => `Hi ${n}, this is fixed now. Could you try again and let us know if anything still looks off?` },
  { label: 'Thanks for the idea', body: (n) => `Hi ${n}, thanks for the suggestion! We’ve added it to our list — we’ll let you know if it ships.` },
];

/** "Chrome on macOS" from a browser's user-agent text. */
function browserName(ua: string | null) {
  if (!ua) return null;
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  return b && os ? `${b} on ${os}` : b || os || 'Unknown browser';
}

const initials = (s: string) =>
  s
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';
const AVATAR_TONES = ['bg-orange-bg text-orange-ink', 'bg-info-bg text-info-ink', 'bg-good-bg text-good-ink', 'bg-lilac/25 text-[#5b45c9] dark:text-lilac', 'bg-warn-bg text-warn-ink'];
const toneFor = (s: string) => AVATAR_TONES[[...s].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_TONES.length];

function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-full font-display font-bold',
        toneFor(name),
        size === 'sm' ? 'size-8 text-xs' : size === 'lg' ? 'size-12 text-base' : 'size-10 text-sm',
      )}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/**
 * Admin → Support: everyone's help requests. A row of counters (click to filter), the inbox (status tabs, topic,
 * search by #, email or subject) and the open request: the conversation and reply box, with who sent it and their
 * context on the side.
 */
export function AdminSupportPage() {
  const { me, refresh } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get('t');
  const [view, setView] = useState<View>('active');
  const [category, setCategory] = useState<TicketCategory | ''>('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<AdminTicketSummary[] | null>(null);
  const [counts, setCounts] = useState<TicketCounts | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const ask = useRef(0);
  const loadList = useCallback(async () => {
    const n = ++ask.current;
    try {
      const r = await api.adminTickets({ status: view, category, q: query });
      if (n !== ask.current) return;
      setList(r.items);
      setCounts(r.counts);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, [view, category, query]);
  useEffect(() => {
    setList(null);
    loadList();
  }, [loadList]);
  useEffect(() => {
    const every = setInterval(() => document.visibilityState === 'visible' && loadList(), 30_000);
    return () => clearInterval(every);
  }, [loadList]);

  if (!me?.user.isAdmin) return <Navigate to="/app/settings" replace />;
  const open = (id: string | null) => setParams(id ? { t: id } : {});
  const shown = unreadOnly ? list?.filter((t) => t.unreadForAdmin) : list;
  const pick = (v: View, unread = false) => {
    setView(v);
    setUnreadOnly(unread);
  };

  return (
    <>
      <PageHeader
        back={{ to: '/app/admin', label: 'Admin' }}
        title="Support inbox"
        description="Help requests from everyone. Answer here — people see it under Help with a “New answer” tag."
        actions={
          <Button size="sm" variant="ghost" onClick={() => loadList()}>
            <RefreshCw size={15} /> Refresh
          </Button>
        }
      />

      {/* counters */}
      <div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Counter icon={Sparkles} tone="bg-orange-bg text-orange-ink" label="New messages" value={counts?.unread} active={unreadOnly} onClick={() => pick('active', true)} />
        <Counter icon={Reply} tone="bg-bad-bg text-bad-ink" label="Need a reply" value={counts ? counts.open + counts.in_progress : undefined} active={view === 'open' && !unreadOnly} onClick={() => pick('open')} />
        <Counter icon={Clock3} tone="bg-warn-bg text-warn-ink" label="Waiting on customer" value={counts?.waiting} active={view === 'waiting'} onClick={() => pick('waiting')} />
        <Counter icon={CheckCircle2} tone="bg-good-bg text-good-ink" label="Resolved" value={counts?.resolved} active={view === 'resolved'} onClick={() => pick('resolved')} />
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,390px)_minmax(0,1fr)]">
        {/* inbox */}
        <Card className={cn('flex flex-col overflow-hidden lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)]', selected && 'hidden lg:flex')}>
          <div className="flex flex-col gap-3 border-b border-line p-4">
            <Segmented
              label="Show"
              size="sm"
              className="w-full"
              value={unreadOnly ? ('unread' as View) : view === 'open' ? 'active' : view}
              onChange={(v) => pick(v as View)}
              options={(['active', 'waiting', 'resolved', 'all'] as View[]).map((v) => ({
                value: v,
                label: (
                  <>
                    {VIEW_LABEL[v]}
                    {counts && v !== 'all' && counts[v] > 0 && <span className="rounded-full bg-sunken px-1.5 text-[11px] text-ink-2 tabular-nums">{counts[v]}</span>}
                  </>
                ),
              }))}
            />
            <div className="flex gap-2">
              <label className="relative min-w-0 flex-1">
                <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" aria-hidden />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search #, email, subject" aria-label="Search requests" className="py-2.5 pl-9 text-sm" />
              </label>
              <Select value={category} onChange={(e) => setCategory(e.target.value as TicketCategory | '')} aria-label="Topic" className="w-[8.5rem] py-2.5 text-sm">
                <option value="">All topics</option>
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </div>
            {(unreadOnly || view === 'open') && (
              <button type="button" onClick={() => pick('active')} className="self-start text-xs font-bold text-accent">
                Showing {unreadOnly ? 'new messages' : 'requests that need a reply'} · show all active
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {shown == null ? (
              <div className="grid gap-2 p-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-24" />
                ))}
              </div>
            ) : shown.length === 0 ? (
              <EmptyState compact icon={<Inbox size={26} />} title={query || category ? 'No matches' : 'All caught up'}>
                {query || category ? 'No requests match this search or topic.' : unreadOnly ? 'No new messages.' : 'Nothing waiting here.'}
              </EmptyState>
            ) : (
              <ul className="flex flex-col gap-1">
                {shown.map((t) => (
                  <InboxRow key={t.id} t={t} selected={selected === t.id} onOpen={() => open(t.id)} />
                ))}
              </ul>
            )}
          </div>
          {shown && shown.length > 0 && (
            <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3">
              {shown.length} request{shown.length === 1 ? '' : 's'} · newest activity first
            </p>
          )}
        </Card>

        {/* the open request */}
        <div className={cn('min-w-0', !selected && 'hidden lg:block')}>
          {selected ? (
            <TicketPanel
              key={selected}
              id={selected}
              onBack={() => open(null)}
              onOpen={open}
              onChanged={() => {
                loadList();
                refresh().catch(() => {});
              }}
            />
          ) : (
            <Card className="grid min-h-[26rem] place-items-center p-8 text-center">
              <span className="flex flex-col items-center gap-3">
                <span className="grid size-16 place-items-center rounded-3xl bg-sunken text-ink-3 shadow-well">
                  <MessageSquareText size={28} aria-hidden />
                </span>
                <b className="font-display text-lg">Pick a request</b>
                <span className="max-w-xs text-sm text-ink-3">Choose one on the left to read the conversation and answer. Orange dots are new messages.</span>
              </span>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Counter({ icon: Icon, tone, label, value, active, onClick }: { icon: LucideIcon; tone: string; label: string; value: number | undefined; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex min-w-0 items-center gap-3 rounded-[22px] bg-surface p-3.5 text-left shadow-clay-sm transition-all hover:-translate-y-0.5 sm:p-4',
        active && 'ring-2 ring-tangerine ring-offset-2 ring-offset-page',
      )}
    >
      <span className={cn('grid size-11 shrink-0 place-items-center rounded-2xl', tone)} aria-hidden>
        <Icon size={20} />
      </span>
      <span className="min-w-0">
        <b className={cn('block font-display text-[26px] leading-tight tabular-nums', !value && 'text-ink-3')}>{value ?? '—'}</b>
        <span className="block text-[13px] leading-tight font-extrabold text-ink-2">{label}</span>
      </span>
    </button>
  );
}

function InboxRow({ t, selected, onOpen }: { t: AdminTicketSummary; selected: boolean; onOpen: () => void }) {
  const who = t.name || t.email;
  const C = categoryOf(t.category);
  const needsReply = (t.status === 'open' || t.status === 'in_progress') && t.lastMessage?.from === 'user';
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected || undefined}
        className={cn(
          'relative flex w-full gap-3 rounded-2xl p-3 text-left transition-colors',
          selected ? 'bg-row shadow-flat ring-1 ring-tangerine/60' : 'hover:bg-row/70',
        )}
      >
        {t.unreadForAdmin && <span className="absolute top-1/2 left-0.5 size-2 -translate-y-1/2 rounded-full bg-tangerine" aria-label="New message" />}
        <Avatar name={who} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-[13px]', t.unreadForAdmin ? 'font-extrabold text-ink' : 'font-semibold text-ink-2')}>{who}</span>
            <span className="shrink-0 text-[11px] text-ink-3">{timeAgo(t.updatedAt)}</span>
          </span>
          <span className={cn('mt-0.5 block truncate text-sm', t.unreadForAdmin ? 'font-bold text-ink' : 'font-semibold text-ink')}>{t.subject}</span>
          <span className="mt-0.5 block truncate text-xs text-ink-3">
            {t.lastMessage?.from === 'admin' ? 'You: ' : ''}
            {t.lastMessage?.body}
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-1.5">
            {needsReply ? <Badge tone="bad">Needs reply</Badge> : <StatusBadge status={t.status} side="admin" />}
            <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[11px] font-bold text-ink-2">
              <C.Icon size={11} aria-hidden /> {C.label}
            </span>
            {t.priority !== 'normal' && <Badge tone={t.priority === 'urgent' ? 'bad' : 'warn'}>{t.priority === 'urgent' ? 'Urgent' : 'High'}</Badge>}
            <span className="ml-auto text-[11px] text-ink-3 tabular-nums">#{t.number}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

function TicketPanel({ id, onBack, onOpen, onChanged }: { id: string; onBack: () => void; onOpen: (id: string) => void; onChanged: () => void }) {
  const [t, setT] = useState<AdminTicket | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState<'send' | 'resolve' | 'update' | null>(null);
  const [templates, setTemplates] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api
      .adminTicket(id)
      .then((x) => {
        setT(x);
        onChanged(); // opening it marks it read
      })
      .catch((e) => toast((e as Error).message, 'error'));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (resolve: boolean) => {
    if (reply.trim().length < 2) return;
    setBusy(resolve ? 'resolve' : 'send');
    try {
      setT(await api.adminReplyTicket(id, reply, resolve ? 'resolved' : undefined));
      setReply('');
      toast(resolve ? 'Answered and resolved' : 'Answer sent');
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const update = async (patch: { status?: TicketStatus; priority?: TicketPriority; unread?: boolean }, done?: string) => {
    setBusy('update');
    try {
      setT(await api.adminUpdateTicket(id, patch));
      if (done) toast(done);
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!t)
    return (
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
        <Skeleton className="h-[30rem]" />
        <Skeleton className="hidden h-80 xl:block" />
      </div>
    );

  const C = categoryOf(t.category);
  const who = t.user?.name || t.name || t.email;
  const first = (t.user?.name || t.name || '').split(' ')[0] || 'there';
  const done = t.status === 'resolved' || t.status === 'closed';

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_272px]">
      {/* conversation */}
      <Card className="flex min-w-0 flex-col overflow-hidden xl:col-start-1 xl:row-span-2 xl:row-start-1">
        <div className="border-b border-line p-5 sm:p-6">
          <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-2 lg:hidden">
            <ArrowLeft size={16} /> All requests
          </button>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
            <span className="font-bold tabular-nums">#{t.number}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <C.Icon size={12} aria-hidden /> {C.label}
            </span>
            <span aria-hidden>·</span>
            <span>opened {when(t.createdAt)}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-start justify-between gap-3">
            <h2 className="min-w-0 text-2xl leading-tight [overflow-wrap:anywhere]">{t.subject}</h2>
            <StatusBadge status={t.status} side="admin" />
          </div>
        </div>

        <div className="max-h-[60vh] min-h-48 overflow-y-auto bg-sunken/40 p-5 sm:p-6">
          <Thread messages={t.messages} me="admin" otherName={who} />
        </div>

        {/* reply */}
        <div className="border-t border-line p-5 sm:p-6">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-extrabold text-ink-2">Reply to {who}</span>
            <div className="relative">
              <Button size="sm" variant="ghost" onClick={() => setTemplates((o) => !o)} aria-expanded={templates}>
                <MessageSquareText size={15} /> Templates
              </Button>
              {templates && (
                <div role="menu" className="absolute right-0 bottom-full z-30 mb-2 w-64 animate-pop-in rounded-2xl bg-surface p-1.5 shadow-float">
                  {TEMPLATES.map((x) => (
                    <button
                      key={x.label}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setReply(x.body(first));
                        setTemplates(false);
                        setTimeout(() => box.current?.focus(), 0);
                      }}
                      className="block w-full rounded-xl px-3 py-2 text-left text-sm font-bold text-ink hover:bg-row"
                    >
                      {x.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <Textarea
            ref={box}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={4}
            maxLength={5000}
            placeholder={done ? 'Replying opens it again for them…' : 'Write your answer…'}
            aria-label="Reply"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(false);
            }}
          />
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto hidden text-xs text-ink-3 sm:block">⌘ / Ctrl + Enter to send</span>
            <Button variant="ghost" onClick={() => send(true)} loading={busy === 'resolve'} disabled={reply.trim().length < 2 || busy !== null}>
              {busy !== 'resolve' && <CheckCircle2 size={16} />} Send & resolve
            </Button>
            <Button variant="primary" onClick={() => send(false)} loading={busy === 'send'} disabled={reply.trim().length < 2 || busy !== null}>
              {busy !== 'send' && <Send size={16} />} Send
            </Button>
          </div>
        </div>
      </Card>

      {/* manage + who sent it (beside the conversation on wide screens, under it otherwise) */}
      <div className="grid min-w-0 gap-5 sm:grid-cols-2 lg:grid-cols-1 xl:col-start-2 xl:row-start-1">
        <Card className="p-5">
          <h3 className="mb-3 text-xs font-extrabold tracking-wider text-ink-3 uppercase">Manage</h3>
          <label className="block text-xs font-bold text-ink-3" htmlFor="ticket-status">
            Status
          </label>
          <Select
            id="ticket-status"
            value={t.status}
            onChange={(e) => update({ status: e.target.value as TicketStatus }, `Marked ${statusLabel(e.target.value as TicketStatus, 'admin').toLowerCase()}`)}
            className="mt-1 py-2 text-sm font-bold"
            disabled={busy === 'update'}
          >
            {(['open', 'in_progress', 'waiting', 'resolved', 'closed'] as TicketStatus[]).map((s) => (
              <option key={s} value={s}>
                {statusLabel(s, 'admin')}
              </option>
            ))}
          </Select>
          <span className="mt-3 block text-xs font-bold text-ink-3">Priority</span>
          <Segmented label="Priority" size="sm" className="mt-1 w-full" value={t.priority} options={PRIORITIES} onChange={(p) => update({ priority: p })} />
          <div className="mt-4 flex flex-wrap gap-2">
            {!done && (
              <Button size="sm" onClick={() => update({ status: 'resolved' }, 'Resolved')} disabled={busy !== null}>
                <CheckCircle2 size={15} /> Resolve
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => update({ unread: true }, 'Marked as new')} title="Show it as new again" disabled={busy !== null}>
              <MailOpen size={15} /> Mark unread
            </Button>
          </div>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-3">
            <Avatar name={who} size="lg" />
            <span className="min-w-0">
              <b className="block truncate font-display text-lg">{who}</b>
              {t.user ? (
                <span className="text-xs text-ink-3">Customer since {new Date(t.user.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span>
              ) : (
                <span className="text-xs text-bad">Account deleted</span>
              )}
            </span>
          </div>
          <div className="mt-4 flex items-center gap-1.5 rounded-xl bg-sunken px-3 py-2 text-sm">
            <Mail size={14} className="shrink-0 text-ink-3" aria-hidden />
            <a href={`mailto:${t.email}?subject=${encodeURIComponent(`Re: #${t.number} ${t.subject}`)}`} className="min-w-0 flex-1 truncate font-semibold text-ink no-underline" title={t.email}>
              {t.email}
            </a>
            <button type="button" aria-label="Copy email" className="shrink-0 text-ink-3 hover:text-ink" onClick={() => navigator.clipboard.writeText(t.email).then(() => toast('Email copied'))}>
              <Copy size={14} />
            </button>
          </div>
          {t.user && (
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-ink-3">Plan</dt>
                <dd className="font-bold capitalize">
                  {t.user.plan}
                  {t.user.paying && <span className="ml-1 text-xs font-semibold text-good-ink">paying</span>}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Credits</dt>
                <dd className="font-bold tabular-nums">{t.user.balance.toLocaleString()}</dd>
              </div>
            </dl>
          )}
          {t.user && (
            <a href={`/admin/users/${t.user.id}`} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1 text-sm font-bold text-accent no-underline hover:underline">
              Open account <ExternalLink size={13} aria-hidden />
            </a>
          )}
        </Card>

      </div>

      {/* context (under the customer on wide screens, after the conversation otherwise) */}
      <div className="grid min-w-0 gap-5 sm:grid-cols-2 lg:grid-cols-1 xl:col-start-2 xl:row-start-2">
        <Card className="p-5">
          <h3 className="mb-3 text-xs font-extrabold tracking-wider text-ink-3 uppercase">Context</h3>
          <ul className="flex flex-col gap-2.5 text-sm">
            {t.project && (
              <li className="flex min-w-0 items-start gap-2">
                <Film size={15} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                <span className="min-w-0">
                  {t.project.exists ? (
                    <Link to={`/app/p/${t.project.id}`} className="block truncate font-bold">
                      {t.project.title}
                    </Link>
                  ) : (
                    <span className="block truncate">{t.project.title} (deleted)</span>
                  )}
                  <span className="text-xs text-ink-3">Video · {t.project.status}</span>
                </span>
              </li>
            )}
            <li className="flex items-start gap-2">
              <Sparkles size={15} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
              <span>
                <span className="font-semibold capitalize">{t.context.plan}</span> <span className="text-xs text-ink-3">plan when sent</span>
              </span>
            </li>
            {t.context.page && (
              <li className="flex min-w-0 items-start gap-2">
                <Globe size={15} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                <span className="min-w-0 truncate font-mono text-xs leading-5">{t.context.page}</span>
              </li>
            )}
            {t.context.userAgent && (
              <li className="flex items-start gap-2" title={t.context.userAgent}>
                <Monitor size={15} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                <span>{browserName(t.context.userAgent)}</span>
              </li>
            )}
          </ul>
        </Card>

        {t.otherTickets.length > 0 && (
          <Card className="p-5">
            <h3 className="mb-3 text-xs font-extrabold tracking-wider text-ink-3 uppercase">Their other requests</h3>
            <ul className="flex flex-col gap-1">
              {t.otherTickets.map((o) => (
                <li key={o.id}>
                  <button type="button" onClick={() => onOpen(o.id)} className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-row">
                    <span className="min-w-0 flex-1 truncate font-semibold">{o.subject}</span>
                    <span className="shrink-0 text-[11px] text-ink-3">{statusLabel(o.status, 'admin')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
