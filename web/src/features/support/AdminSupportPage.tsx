import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, ExternalLink, Film, Inbox, Mail, Monitor, RefreshCw, Search, Send } from 'lucide-react';
import { api, type AdminTicket, type AdminTicketSummary, type TicketCategory, type TicketCounts, type TicketPriority, type TicketStatus } from '../../lib/api';
import { cn } from '../../lib/cn';
import { timeAgo } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Badge, Button, Card, EmptyState, Input, PageHeader, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { useAuth } from '../auth/auth';
import { CATEGORIES, categoryOf, StatusBadge, statusLabel, Thread, when } from './ticketUi';

type View = 'active' | TicketStatus | 'all';
const VIEWS: View[] = ['active', 'waiting', 'resolved', 'all'];
const VIEW_LABEL: Record<View, string> = { active: 'Active', open: 'Open', in_progress: 'In progress', waiting: 'Waiting', resolved: 'Resolved', closed: 'Closed', all: 'All' };
const PRIORITY_TONE: Record<TicketPriority, 'neutral' | 'warn' | 'bad'> = { normal: 'neutral', high: 'warn', urgent: 'bad' };

/**
 * Admin → Support: every help request. Left, the inbox (filter by status / topic, search by #, email or subject);
 * right, the selected request — who sent it, its context, the conversation, and the reply box.
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
  const open = (id: string | null) => setParams(id ? { t: id } : {}, { replace: false });

  return (
    <>
      <PageHeader
        back={{ to: '/app/admin', label: 'Admin' }}
        title="Support"
        description="Help requests from everyone. New messages from customers show a dot until you open them."
        actions={
          <Button size="sm" variant="ghost" onClick={() => loadList()}>
            <RefreshCw size={15} /> Refresh
          </Button>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        {/* inbox */}
        <Card className={cn('flex min-h-0 flex-col p-4 sm:p-5 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)]', selected && 'hidden lg:flex')}>
          <Segmented
            label="Status"
            size="sm"
            value={view}
            onChange={setView}
            options={VIEWS.map((v) => ({
              value: v,
              label: (
                <>
                  {VIEW_LABEL[v]}
                  {counts && counts[v] > 0 && <span className="text-xs text-ink-3 tabular-nums">{counts[v]}</span>}
                </>
              ),
            }))}
          />
          <div className="mt-3 flex gap-2">
            <label className="relative min-w-0 flex-1">
              <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" aria-hidden />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="#1042, email, subject" aria-label="Search requests" className="py-2.5 pl-9 text-sm" />
            </label>
            <Select value={category} onChange={(e) => setCategory(e.target.value as TicketCategory | '')} aria-label="Topic" className="w-36 py-2.5 text-sm">
              <option value="">All topics</option>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="-mx-2 mt-3 min-h-0 flex-1 overflow-y-auto px-2">
            {list === null ? (
              <div className="grid gap-2">
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </div>
            ) : list.length === 0 ? (
              <EmptyState compact icon={<Inbox size={26} />} title="Inbox zero">
                {query || category ? 'No requests match this filter.' : view === 'active' ? 'No open requests. Nice.' : 'Nothing here.'}
              </EmptyState>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {list.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => open(t.id)}
                      className={cn(
                        'flex w-full flex-col gap-1 rounded-2xl px-3.5 py-3 text-left transition-colors',
                        selected === t.id ? 'bg-ink text-on-ink' : 'hover:bg-row',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        {t.unreadForAdmin && <span className="size-2 shrink-0 rounded-full bg-tangerine" aria-label="New" />}
                        <b className="min-w-0 flex-1 truncate text-sm">{t.subject}</b>
                        <span className={cn('shrink-0 text-[11px]', selected === t.id ? 'text-on-ink/70' : 'text-ink-3')}>{timeAgo(t.updatedAt)}</span>
                      </span>
                      <span className={cn('truncate text-xs', selected === t.id ? 'text-on-ink/80' : 'text-ink-2')}>
                        {t.lastMessage?.from === 'admin' ? 'You: ' : ''}
                        {t.lastMessage?.body}
                      </span>
                      <span className={cn('flex flex-wrap items-center gap-x-2 text-[11px]', selected === t.id ? 'text-on-ink/70' : 'text-ink-3')}>
                        <span>#{t.number}</span>·<span className="truncate">{t.name || t.email}</span>·<span>{categoryOf(t.category).label}</span>
                        {t.priority !== 'normal' && <span className={cn('font-black uppercase', t.priority === 'urgent' ? 'text-bad' : 'text-warn')}>{t.priority}</span>}
                        {view === 'all' || view === 'active' ? <span>· {statusLabel(t.status, 'admin')}</span> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        {/* the selected request */}
        <div className={cn('min-w-0', !selected && 'hidden lg:block')}>
          {selected ? (
            <TicketPanel
              key={selected}
              id={selected}
              onBack={() => open(null)}
              onChanged={() => {
                loadList();
                refresh().catch(() => {});
              }}
            />
          ) : (
            <Card className="grid min-h-80 place-items-center p-8 text-center text-ink-3">
              <span>
                <Inbox size={28} className="mx-auto mb-2" aria-hidden />
                Pick a request on the left.
              </span>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function TicketPanel({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const [t, setT] = useState<AdminTicket | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState<'send' | 'resolve' | 'status' | null>(null);

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
  const update = async (patch: { status?: TicketStatus; priority?: TicketPriority; unread?: boolean }) => {
    setBusy('status');
    try {
      setT(await api.adminUpdateTicket(id, patch));
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!t) return <Skeleton className="h-[28rem]" />;
  const C = categoryOf(t.category);
  return (
    <div className="flex flex-col gap-5">
      <Card className="p-5 sm:p-6">
        <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-2 lg:hidden">
          <ArrowLeft size={16} /> All requests
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-2xl [overflow-wrap:anywhere]">{t.subject}</h2>
            <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-ink-3">
              <StatusBadge status={t.status} side="admin" />
              <Badge tone={PRIORITY_TONE[t.priority]}>{t.priority === 'normal' ? 'Normal priority' : `${t.priority[0].toUpperCase()}${t.priority.slice(1)} priority`}</Badge>
              <span>
                #{t.number} · {C.label} · opened {when(t.createdAt)}
              </span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={t.status} onChange={(e) => update({ status: e.target.value as TicketStatus })} aria-label="Status" className="w-44 py-2 text-sm" disabled={busy === 'status'}>
              {(['open', 'in_progress', 'waiting', 'resolved', 'closed'] as TicketStatus[]).map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s, 'admin')}
                </option>
              ))}
            </Select>
            <Select value={t.priority} onChange={(e) => update({ priority: e.target.value as TicketPriority })} aria-label="Priority" className="w-32 py-2 text-sm" disabled={busy === 'status'}>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </Select>
            <Button size="sm" variant="ghost" onClick={() => update({ unread: true })} title="Show it as new again">
              Mark unread
            </Button>
          </div>
        </div>

        {/* who and what */}
        <dl className="mt-5 grid gap-3 rounded-2xl bg-sunken p-4 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-xs font-extrabold tracking-wider text-ink-3 uppercase">From</dt>
            <dd className="mt-1 min-w-0">
              <b className="block truncate">{t.user?.name || t.name || '—'}</b>
              <a href={`mailto:${t.email}?subject=${encodeURIComponent(`Re: #${t.number} ${t.subject}`)}`} className="flex min-w-0 items-center gap-1 text-ink-2" title={t.email}>
                <Mail size={13} className="shrink-0" aria-hidden /> <span className="truncate">{t.email}</span>
              </a>
              {t.user ? (
                <span className="mt-1 block text-xs text-ink-3">
                  {t.user.plan[0].toUpperCase() + t.user.plan.slice(1)}
                  {t.user.paying ? ' (paying)' : ''} · {t.user.balance.toLocaleString()} credits · joined {new Date(t.user.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} ·{' '}
                  <a href={`/admin/users/${t.user.id}`} className="font-bold" target="_blank" rel="noreferrer">
                    account <ExternalLink size={11} className="inline" aria-hidden />
                  </a>
                </span>
              ) : (
                <span className="mt-1 block text-xs text-ink-3">Account deleted</span>
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-extrabold tracking-wider text-ink-3 uppercase">Context</dt>
            <dd className="mt-1 flex min-w-0 flex-col gap-1 text-ink-2">
              {t.project && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <Film size={13} className="shrink-0 text-ink-3" aria-hidden />
                  {t.project.exists ? (
                    <Link to={`/app/p/${t.project.id}`} className="truncate font-bold">
                      {t.project.title}
                    </Link>
                  ) : (
                    <span className="truncate">{t.project.title} (deleted)</span>
                  )}
                  <span className="shrink-0 text-xs text-ink-3">· {t.project.status}</span>
                </span>
              )}
              <span className="text-xs">Plan when sent: {t.context.plan}</span>
              {t.context.page && <span className="truncate text-xs">From page: {t.context.page}</span>}
              {t.context.userAgent && (
                <span className="flex min-w-0 items-center gap-1 text-xs" title={t.context.userAgent}>
                  <Monitor size={12} className="shrink-0" aria-hidden />
                  <span className="truncate">{t.context.userAgent}</span>
                </span>
              )}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="p-5 sm:p-6">
        <Thread messages={t.messages} me="admin" otherName={t.name || t.email} />
        <div className="mt-6 border-t border-line pt-5">
          <Textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={4}
            maxLength={5000}
            placeholder={`Reply to ${t.name || t.email}…`}
            aria-label="Reply"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(false);
            }}
          />
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto hidden text-xs text-ink-3 sm:block">They see it under Help, with a “New answer” tag.</span>
            <Button variant="ghost" onClick={() => send(true)} loading={busy === 'resolve'} disabled={reply.trim().length < 2 || busy !== null}>
              {busy !== 'resolve' && <CheckCircle2 size={16} />} Send & resolve
            </Button>
            <Button variant="primary" onClick={() => send(false)} loading={busy === 'send'} disabled={reply.trim().length < 2 || busy !== null}>
              {busy !== 'send' && <Send size={16} />} Send
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
