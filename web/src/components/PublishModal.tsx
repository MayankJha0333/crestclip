import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { CalendarClock, Instagram, Send, X, Youtube } from 'lucide-react';
import { api, type Account, type Clip } from '../lib/api';
import { toast } from '../lib/toast';
import { Seg } from './bits';

/** default schedule: the next full hour */
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
export function PublishModal({ clip, onClose, onDone }: { clip: Clip; onClose: () => void; onDone: () => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState(clip.title.slice(0, 100));
  const [caption, setCaption] = useState(`${clip.description}\n\n${clip.hashtags.join(' ')}`.trim());
  const [privacy, setPrivacy] = useState<'public' | 'unlisted' | 'private'>('public');
  const [when, setWhen] = useState<'now' | 'later'>('now');
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
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const chosen = (accounts ?? []).filter((a) => picked.has(a.id));
  const hasYT = chosen.some((a) => a.platform === 'youtube');
  const hasIG = chosen.some((a) => a.platform === 'instagram');
  const scheduledMs = when === 'later' ? new Date(at).getTime() : null;

  const submit = async () => {
    setError(null);
    if (!chosen.length) return setError('Pick at least one account.');
    if (scheduledMs != null && (!Number.isFinite(scheduledMs) || scheduledMs < Date.now() + 60_000)) return setError('Pick a time at least a minute from now.');
    if (hasYT && scheduledMs && scheduledMs > Date.now() + 1000 * 86400 * 365) return setError('YouTube can schedule up to a year ahead.');
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

  // rendered at the page level so the dialog isn't trapped inside the (animated) clip card
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal clay pop-in publish-modal" role="dialog" aria-modal="true" aria-label="Post clip">
        <header className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ fontSize: 24 }}>Post this clip</h2>
          <button className="btn btn-icon" onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={18} />
          </button>
        </header>

        <div className="publish-grid">
          <div className="clip-phone" style={{ maxWidth: 200 }}>
            {clip.videoUrl ? <video src={clip.videoUrl} poster={clip.thumbUrl ?? undefined} controls playsInline preload="none" /> : null}
          </div>

          <div className="stack" style={{ gap: 18 }}>
            <section>
              <span className="label">Post to</span>
              {accounts == null ? (
                <p className="faint">Loading accounts…</p>
              ) : accounts.length === 0 ? (
                <div className="well" style={{ padding: 14, borderRadius: 16 }}>
                  <p style={{ fontWeight: 700 }}>No accounts connected yet.</p>
                  <Link className="btn btn-primary btn-sm" to="/app/accounts" style={{ marginTop: 10 }} onClick={onClose}>
                    Connect YouTube or Instagram
                  </Link>
                </div>
              ) : (
                <div className="pick-accounts">
                  {accounts.map((a) => (
                    <label key={a.id} className={`pick-acct ${picked.has(a.id) ? 'on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={picked.has(a.id)}
                        onChange={(e) =>
                          setPicked((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(a.id);
                            else n.delete(a.id);
                            return n;
                          })
                        }
                      />
                      <span className={`acct-logo sm ${a.platform === 'youtube' ? 'yt' : 'ig'}`}>{a.platform === 'youtube' ? <Youtube size={15} /> : <Instagram size={15} />}</span>
                      {a.avatar ? <img src={a.avatar} alt="" referrerPolicy="no-referrer" /> : null}
                      <span className="clamp1" style={{ fontWeight: 800 }}>{a.handle ?? a.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </section>

            {hasYT && (
              <section>
                <span className="label">YouTube title · {title.length}/100</span>
                <input className="field" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
                <div style={{ marginTop: 10 }}>
                  <Seg
                    label="YouTube visibility"
                    value={privacy}
                    onChange={setPrivacy}
                    options={[
                      { value: 'public', label: 'Public' },
                      { value: 'unlisted', label: 'Unlisted' },
                      { value: 'private', label: 'Private' },
                    ]}
                  />
                </div>
              </section>
            )}

            <section>
              <span className="label">
                {hasIG && hasYT ? 'Caption / description' : hasIG ? 'Caption' : 'Description'} · {caption.length}/2200
              </span>
              <textarea className="field" rows={5} maxLength={2200} value={caption} onChange={(e) => setCaption(e.target.value)} />
            </section>

            <section>
              <span className="label">When</span>
              <Seg
                label="When to post"
                value={when}
                onChange={setWhen}
                options={[
                  { value: 'now', label: <span className="row" style={{ gap: 6 }}><Send size={14} /> Post now</span> },
                  { value: 'later', label: <span className="row" style={{ gap: 6 }}><CalendarClock size={14} /> Schedule</span> },
                ]}
              />
              {when === 'later' && (
                <div style={{ marginTop: 10 }}>
                  <input className="field" type="datetime-local" value={at} min={toLocalInput(new Date(Date.now() + 120_000))} onChange={(e) => setAt(e.target.value)} />
                  <p className="faint" style={{ fontSize: 12, marginTop: 6 }}>
                    {hasYT && 'YouTube: uploaded now and kept private; YouTube makes it public at this time. '}
                    {hasIG && 'Instagram: CrestClip posts it at this time — keep CrestClip running. '}
                    Times are in your timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
                  </p>
                </div>
              )}
            </section>

            {error && <p style={{ color: 'var(--bad)', fontWeight: 700 }}>{error}</p>}
            <div className="row" style={{ justifyContent: 'flex-end', gap: 10 }}>
              <button className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={submit} disabled={busy || !chosen.length}>
                {busy ? <span className="spinner" /> : when === 'later' ? <CalendarClock size={16} /> : <Send size={16} />}
                {when === 'later' ? `Schedule to ${chosen.length || ''} account${chosen.length === 1 ? '' : 's'}` : `Post to ${chosen.length || ''} account${chosen.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
