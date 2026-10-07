import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ChevronRight, LifeBuoy, MessageSquarePlus } from 'lucide-react';
import { api, type Project, type TicketCategory, type TicketSummary } from '../../lib/api';
import { cn } from '../../lib/cn';
import { timeAgo } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Button, Card, Dialog, EmptyState, Field, FieldLabel, Input, PageHeader, Select, Skeleton, Textarea } from '../../components/ui';
import { useAuth } from '../auth/auth';
import { CATEGORIES, categoryOf, StatusBadge } from './ticketUi';

/** Help: the person's requests to the CrestClip team, and a way to start a new one. */
export function SupportPage() {
  const [list, setList] = useState<TicketSummary[] | null>(null);
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(params.get('new') === '1');

  useEffect(() => {
    api
      .myTickets()
      .then(setList)
      .catch((e) => toast((e as Error).message, 'error'));
  }, []);

  const active = list?.filter((t) => t.status !== 'resolved' && t.status !== 'closed') ?? [];
  const done = list?.filter((t) => t.status === 'resolved' || t.status === 'closed') ?? [];

  return (
    <>
      <PageHeader
        title="Help"
        description="Ask a question or report a problem — the CrestClip team answers here, usually within one working day."
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <MessageSquarePlus size={17} /> New request
          </Button>
        }
      />

      {list === null ? (
        <div className="grid gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : list.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            icon={<LifeBuoy size={28} />}
            title="How can we help?"
            action={
              <Button variant="primary" onClick={() => setOpen(true)}>
                <MessageSquarePlus size={17} /> New request
              </Button>
            }
          >
            Tell us what happened — a payment, a video that didn’t clip, a post that didn’t go out — and we’ll get back to you right here.
          </EmptyState>
        </Card>
      ) : (
        <div className="flex flex-col gap-8">
          {active.length > 0 && <TicketList title="Open" items={active} />}
          {done.length > 0 && <TicketList title="Resolved & closed" items={done} />}
        </div>
      )}

      <NewRequest
        open={open}
        onClose={() => {
          setOpen(false);
          if (params.get('new')) setParams({}, { replace: true });
        }}
      />
    </>
  );
}

function TicketList({ title, items }: { title: string; items: TicketSummary[] }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-extrabold tracking-wider text-ink-3 uppercase">{title}</h2>
      <div className="flex flex-col gap-3">
        {items.map((t) => {
          const C = categoryOf(t.category);
          return (
            <Link
              key={t.id}
              to={`/app/support/${t.id}`}
              className="group flex items-center gap-4 rounded-[22px] bg-surface p-4 text-ink no-underline shadow-clay-sm transition-transform hover:-translate-y-0.5 sm:p-5"
            >
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-row text-ink-2 shadow-flat" aria-hidden>
                <C.Icon size={19} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <b className="truncate font-display text-[16px]">{t.subject}</b>
                  {t.unreadForUser && <span className="rounded-full bg-tangerine px-2 py-0.5 text-[11px] font-black text-white">New answer</span>}
                </span>
                {t.lastMessage && (
                  <span className="mt-0.5 block truncate text-sm text-ink-2">
                    {t.lastMessage.from === 'admin' ? 'CrestClip: ' : 'You: '}
                    {t.lastMessage.body}
                  </span>
                )}
                <span className="mt-1 block text-xs text-ink-3">
                  #{t.number} · {C.label} · updated {timeAgo(t.updatedAt)}
                </span>
              </span>
              <span className="hidden shrink-0 sm:block">
                <StatusBadge status={t.status} side="user" />
              </span>
              <ChevronRight size={18} className="shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** The form for a new request: what it's about, a subject, the details, and (optionally) which video. */
export function NewRequest({ open, onClose, projectId: presetProject }: { open: boolean; onClose: () => void; projectId?: string }) {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [category, setCategory] = useState<TicketCategory | null>(null);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [projectId, setProjectId] = useState(presetProject ?? '');
  const [videos, setVideos] = useState<Project[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || videos) return;
    api
      .projects()
      .then((p) => setVideos(p.slice(0, 30)))
      .catch(() => setVideos([]));
  }, [open, videos]);

  const ready = category && subject.trim().length >= 3 && message.trim().length >= 2;
  const send = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const t = await api.newTicket({ category, subject, message, projectId: projectId || null, page: window.location.pathname.startsWith('/app/support') ? null : window.location.pathname });
      toast(`Request #${t.number} sent — we’ll answer here`);
      setSubject('');
      setMessage('');
      setCategory(null);
      onClose();
      refresh().catch(() => {});
      navigate(`/app/support/${t.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy}
      size="lg"
      title="New request"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={send} loading={busy} disabled={!ready}>
            Send request
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div>
          <FieldLabel>What’s it about?</FieldLabel>
          <div className="grid gap-2 sm:grid-cols-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.value}
                type="button"
                aria-pressed={category === c.value}
                onClick={() => setCategory(c.value)}
                className={cn(
                  'flex items-start gap-3 rounded-2xl p-3 text-left transition-all',
                  category === c.value ? 'bg-ink text-on-ink shadow-lift' : 'bg-row text-ink shadow-flat hover:-translate-y-px',
                )}
              >
                <c.Icon size={18} className="mt-0.5 shrink-0" aria-hidden />
                <span className="min-w-0">
                  <b className="block text-sm">{c.label}</b>
                  <span className={cn('block text-xs', category === c.value ? 'text-on-ink/75' : 'text-ink-3')}>{c.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <Field label="Subject">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} placeholder="e.g. Charged twice for Creator" />
        </Field>
        <Field label="What happened?" hint="The more detail, the faster we can help: what you did, what you expected, what you saw instead.">
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={6} maxLength={5000} />
        </Field>
        {videos && videos.length > 0 && (
          <Field label="Which video? (optional)">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Not about a specific video</option>
              {videos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title || 'Untitled video'}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <p className="text-xs text-ink-3">We’ll see your plan and which page you came from, so you don’t have to explain those. Answers show up here and next to Help in the menu.</p>
      </div>
    </Dialog>
  );
}
