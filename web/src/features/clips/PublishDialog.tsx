import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Send } from 'lucide-react';
import { api, type Account, type Clip } from '../../lib/api';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { Button, buttonClass, Dialog, Field, FieldLabel, Input, Segmented, Textarea } from '../../components/ui';
import { SOCIAL } from '../schedule/postStatus';
import { useAccount } from '../auth/auth';
import { ClipVideo } from './ClipVideo';

const nextHour = () => {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(0, 0, 0);
  return d;
};
const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Post or schedule one clip to the connected YouTube / Instagram accounts. */
export function PublishDialog({ clip, onClose, onDone }: { clip: Clip; onClose: () => void; onDone: () => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState(clip.title.slice(0, 100));
  const [caption, setCaption] = useState(`${clip.description}\n\n${clip.hashtags.join(' ')}`.trim());
  const [privacy, setPrivacy] = useState<'public' | 'unlisted' | 'private'>('public');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const canSchedule = useAccount().plan.scheduling;
  const [at, setAt] = useState(toLocalInput(nextHour()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .connections()
      .then((c) => {
        setAccounts(c.accounts);
        setPicked(new Set(c.accounts.map((a) => a.id)));
      })
      .catch(() => setAccounts([]));
  }, []);

  const chosen = (accounts ?? []).filter((a) => picked.has(a.id));
  const hasYT = chosen.some((a) => a.platform === 'youtube');
  const hasIG = chosen.some((a) => a.platform === 'instagram');
  const scheduledMs = when === 'later' ? new Date(at).getTime() : null;
  const n = chosen.length;

  const submit = async () => {
    setError(null);
    if (!n) return setError('Pick at least one account.');
    if (scheduledMs != null && (!Number.isFinite(scheduledMs) || scheduledMs < Date.now() + 60_000)) return setError('Pick a time at least a minute from now.');
    if (hasYT && scheduledMs && scheduledMs > Date.now() + 365 * 86400_000) return setError('YouTube can schedule up to a year ahead.');
    setBusy(true);
    try {
      await api.createPosts({
        clipId: clip.id,
        targets: chosen.map((a) => ({ connectionId: a.id, ...(a.platform === 'youtube' ? { title, privacy } : {}), caption })),
        scheduledAt: scheduledMs,
      });
      toast(scheduledMs ? `Scheduled for ${new Date(scheduledMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'Posting… you can keep working');
      onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      title="Post this clip"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!n}>
            {!busy && (when === 'later' ? <CalendarClock size={16} /> : <Send size={16} />)}
            {when === 'later' ? 'Schedule' : 'Post'} to {n || ''} account{n === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="grid gap-6 sm:grid-cols-[180px_minmax(0,1fr)]">
        <ClipVideo clip={clip} className="mx-auto max-w-[180px]" />
        <div className="flex flex-col gap-5">
          <div>
            <FieldLabel>Post to</FieldLabel>
            {accounts == null ? (
              <p className="text-ink-3">Loading accounts…</p>
            ) : accounts.length === 0 ? (
              <div className="rounded-2xl bg-sunken p-4 shadow-well">
                <p className="font-bold">No accounts connected yet.</p>
                <Link to="/app/settings" onClick={onClose} className={buttonClass('primary', 'sm', 'mt-3')}>
                  Connect YouTube or Instagram
                </Link>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {accounts.map((a) => {
                  const on = picked.has(a.id);
                  const P = SOCIAL[a.platform];
                  return (
                    <label
                      key={a.id}
                      className={cn(
                        'inline-flex max-w-full cursor-pointer items-center gap-2 rounded-full py-1.5 pr-3.5 pl-2',
                        on ? 'bg-good-bg shadow-[inset_0_0_0_2px_var(--mint-d)]' : 'bg-row shadow-flat',
                      )}
                    >
                      <input
                        type="checkbox"
                        className="accent-[var(--mint-d)]"
                        checked={on}
                        onChange={(e) =>
                          setPicked((s) => {
                            const next = new Set(s);
                            if (e.target.checked) next.add(a.id);
                            else next.delete(a.id);
                            return next;
                          })
                        }
                      />
                      <span className={cn('grid size-7 place-items-center rounded-lg text-white', P.color)}>
                        <P.Icon size={15} />
                      </span>
                      {a.avatar && <img src={a.avatar} alt="" referrerPolicy="no-referrer" className="size-6 rounded-full" />}
                      <span className="truncate font-extrabold">{a.handle ?? a.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {hasYT && (
            <div className="flex flex-col gap-2.5">
              <Field label={`YouTube title · ${title.length}/100`}>
                <Input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <Segmented
                label="YouTube visibility"
                size="sm"
                value={privacy}
                onChange={setPrivacy}
                options={[
                  { value: 'public', label: 'Public' },
                  { value: 'unlisted', label: 'Unlisted' },
                  { value: 'private', label: 'Private' },
                ]}
              />
            </div>
          )}

          <Field label={`${hasIG && hasYT ? 'Caption / description' : hasIG ? 'Caption' : 'Description'} · ${caption.length}/2200`}>
            <Textarea rows={5} maxLength={2200} value={caption} onChange={(e) => setCaption(e.target.value)} />
          </Field>

          <div>
            <FieldLabel>When</FieldLabel>
            <Segmented
              label="When to post"
              value={when}
              onChange={setWhen}
              options={[
                {
                  value: 'now',
                  label: (
                    <>
                      <Send size={14} /> Post now
                    </>
                  ),
                },
                {
                  value: 'later',
                  disabled: !canSchedule,
                  title: canSchedule ? undefined : 'Scheduling is on the Creator and Pro plans',
                  label: (
                    <>
                      <CalendarClock size={14} /> Schedule
                    </>
                  ),
                },
              ]}
            />
            {!canSchedule && (
              <p className="mt-2 text-xs text-ink-3">
                Scheduling is on Creator and Pro.{' '}
                <Link to="/app/billing" className="font-bold text-accent">
                  See plans
                </Link>
              </p>
            )}
            {when === 'later' && (
              <div className="mt-3">
                <Input type="datetime-local" value={at} min={toLocalInput(new Date(Date.now() + 120_000))} onChange={(e) => setAt(e.target.value)} />
                <p className="mt-2 text-xs text-ink-3">
                  {hasYT && 'YouTube: uploaded now and kept private; YouTube makes it public at this time. '}
                  {hasIG && 'Instagram: CrestClip posts it at this time — keep CrestClip running. '}
                  Times are in your time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
                </p>
              </div>
            )}
          </div>
          {error && <p className="text-sm font-bold text-bad">{error}</p>}
        </div>
      </div>
    </Dialog>
  );
}
