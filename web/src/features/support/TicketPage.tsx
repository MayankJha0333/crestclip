import { Link, useParams } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Film, Send } from 'lucide-react';
import { api, type Ticket } from '../../lib/api';
import { toast } from '../../lib/toast';
import { Button, Card, ConfirmDialog, PageHeader, Skeleton, Textarea } from '../../components/ui';
import { useAuth } from '../auth/auth';
import { categoryOf, StatusBadge, Thread } from './ticketUi';

/** One help request: the conversation with the team, a reply box, and "this is sorted". */
export function TicketPage() {
  const { id = '' } = useParams();
  const { refresh } = useAuth();
  const [t, setT] = useState<Ticket | null>(null);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState<'send' | 'close' | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const load = useCallback(async () => {
    try {
      setT(await api.ticket(id));
      refresh().catch(() => {}); // reading it clears the "new answer" dot
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
    const every = setInterval(() => document.visibilityState === 'visible' && api.ticket(id).then(setT).catch(() => {}), 30_000); // answers show up without a reload
    return () => clearInterval(every);
  }, [id, load]);

  const send = async () => {
    if (reply.trim().length < 2) return;
    setBusy('send');
    try {
      setT(await api.replyTicket(id, reply));
      setReply('');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const close = async () => {
    setBusy('close');
    try {
      setT(await api.closeTicket(id));
      setConfirmClose(false);
      toast('Glad it’s sorted — request closed');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  if (error)
    return (
      <>
        <PageHeader back={{ to: '/app/support', label: 'Help' }} title="Request not found" />
        <p className="text-ink-2">{error}</p>
      </>
    );
  if (!t)
    return (
      <>
        <PageHeader back={{ to: '/app/support', label: 'Help' }} title={<Skeleton className="h-9 w-72" />} />
        <Skeleton className="h-80" />
      </>
    );

  const C = categoryOf(t.category);
  const closed = t.status === 'closed';
  return (
    <>
      <PageHeader
        back={{ to: '/app/support', label: 'Help' }}
        title={t.subject}
        description={
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={t.status} side="user" />
            <span className="text-ink-3">
              #{t.number} · {C.label} · opened {new Date(t.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
          </span>
        }
        actions={
          !closed && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmClose(true)}>
              <CheckCircle2 size={16} /> It’s sorted
            </Button>
          )
        }
      />

      {t.project && (
        <p className="-mt-3 mb-5 flex items-center gap-2 text-sm text-ink-2">
          <Film size={15} className="text-ink-3" aria-hidden /> About:{' '}
          {t.project.exists ? (
            <Link to={`/app/p/${t.project.id}`} className="font-bold">
              {t.project.title}
            </Link>
          ) : (
            <span>{t.project.title} (deleted)</span>
          )}
        </p>
      )}

      <Card className="p-5 sm:p-7">
        <Thread messages={t.messages} me="user" otherName="CrestClip support" />
        {t.status === 'open' && t.messages.at(-1)?.from === 'user' && (
          <p className="mt-6 rounded-2xl bg-sunken px-4 py-3 text-center text-sm text-ink-2">Thanks — we’ve got it. We usually answer within one working day; you’ll see it here.</p>
        )}
        {closed ? (
          <p className="mt-6 rounded-2xl bg-sunken px-4 py-3 text-center text-sm text-ink-2">
            This request is closed. Still need help?{' '}
            <Link to="/app/support?new=1" className="font-bold">
              Start a new one
            </Link>
          </p>
        ) : (
          <div className="mt-6 border-t border-line pt-5">
            <Textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={3}
              maxLength={5000}
              placeholder={t.status === 'waiting' ? 'Reply to the team…' : 'Add more details…'}
              aria-label="Your reply"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
              }}
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="hidden text-xs text-ink-3 sm:block">⌘ / Ctrl + Enter to send</span>
              <Button variant="primary" onClick={send} loading={busy === 'send'} disabled={reply.trim().length < 2}>
                {busy !== 'send' && <Send size={16} />} Send
              </Button>
            </div>
          </div>
        )}
      </Card>

      <ConfirmDialog open={confirmClose} title="Close this request?" confirmLabel="Close request" busy={busy === 'close'} onCancel={() => setConfirmClose(false)} onConfirm={close}>
        Glad it’s sorted. If anything comes up again, you can start a new request any time.
      </ConfirmDialog>
    </>
  );
}
