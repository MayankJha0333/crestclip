import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Compass, Gauge, LayoutGrid, Loader2, Plus, RefreshCw, Send, X } from 'lucide-react';
import { api, type Health } from '../lib/api';
import { Logo } from '../components/bits';
import { subscribeToasts, toast, type Toast } from '../lib/toast';

interface Issue {
  key: string;
  title: string;
  detail: string;
  action?: 'retry-tools';
}

/**
 * CrestClip installs and updates its own video tools, so people never see terminal commands.
 * This only turns *real* problems into plain-language messages (with a Try again button where it helps).
 */
function issuesFrom(h: Health | null): Issue[] {
  if (!h) return [];
  const out: Issue[] = [];
  if (!h.gemini.ok) out.push({ key: 'gemini', title: 'The AI isn’t connected', detail: 'CrestClip can’t reach Gemini right now, so new clips can’t be made. Browsing still works.' });
  const ffInstalling = h.ffmpegStatus?.state === 'installing';
  if (!h.ffmpeg && !ffInstalling) out.push({ key: 'ffmpeg', title: 'The video engine didn’t start', detail: h.ffmpegStatus?.detail || 'Rendering is unavailable right now.', action: 'retry-tools' });
  else if (h.captions === false && !ffInstalling)
    out.push({
      key: 'captions',
      title: 'Captions are off',
      detail: h.ffmpegSource === 'custom' ? 'A custom video engine is set in .env that can’t draw text. Clips still render without captions.' : h.ffmpegStatus?.detail || 'Clips still render, just without captions.',
      action: h.ffmpegSource === 'custom' ? undefined : 'retry-tools',
    });
  if (h.ytdlpStatus?.state === 'error')
    out.push({ key: 'ytdlp', title: 'Links can’t be downloaded right now', detail: h.ytdlpStatus.detail || 'The video downloader isn’t available. Uploading files still works.', action: 'retry-tools' });
  return out;
}

export function AppShell() {
  const [health, setHealth] = useState<Health | null>(null);
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [dismissed, setDismissed] = useState<string>(() => {
    try {
      return sessionStorage.getItem('crestclip:banner') ?? '';
    } catch {
      return '';
    }
  });
  const pillRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => api.health().then(setHealth).catch(() => setHealth(null)), []);
  useEffect(() => {
    load();
  }, [load]);
  // While the app is setting up / updating its downloader, keep an eye on it.
  const ffSettingUp = health?.ffmpegStatus?.state === 'installing';
  const ytSettingUp = health?.ytdlpStatus?.state === 'installing' || health?.ytdlpStatus?.state === 'updating';
  const settingUp = ffSettingUp || ytSettingUp;
  useEffect(() => {
    if (!settingUp) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [settingUp, load]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !pillRef.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const issues = issuesFrom(health);
  const blocking = issues.filter((i) => i.key === 'gemini' || i.key === 'ffmpeg');
  const status = !health ? 'checking' : blocking.length ? 'bad' : issues.length ? 'warn' : settingUp ? 'setup' : 'ok';
  const issueKey = issues.map((i) => i.key).join(',');
  const showBanner = issues.length > 0 && dismissed !== issueKey;

  const retryTools = async () => {
    setRetrying(true);
    try {
      await api.refreshTools();
      await load();
      toast('Checked again');
    } catch {
      toast('Still not working — CrestClip will keep retrying', 'error');
    } finally {
      setRetrying(false);
    }
  };

  const pillText =
    status === 'checking' ? 'Checking…' : status === 'ok' ? (health?.gemini.fake ? 'Demo AI mode' : 'All systems go') : status === 'setup' ? 'Getting ready…' : status === 'warn' ? 'Needs attention' : 'Setup needed';

  return (
    <div className="shell">
      <aside className="sidebar clay">
        <Link to="/" style={{ textDecoration: 'none' }} aria-label="CrestClip home">
          <Logo size={38} />
        </Link>
        <nav className="stack" style={{ gap: 8, marginTop: 28 }}>
          <NavLink to="/app" end className="nav-item">
            <Plus size={18} /> New clips
          </NavLink>
          <NavLink to="/app/explore" className="nav-item">
            <Compass size={18} /> Explore
          </NavLink>
          <NavLink to="/app/projects" className="nav-item">
            <LayoutGrid size={18} /> Projects
          </NavLink>
          <NavLink to="/app/accounts" className="nav-item">
            <Send size={18} /> Publishing
          </NavLink>
        </nav>
        <div style={{ marginTop: 'auto', position: 'relative' }} ref={pillRef}>
          <button type="button" className={`status-pill ${status}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {status === 'setup' ? <Loader2 size={16} className="spin-icon" /> : <Gauge size={16} />}
            {pillText}
          </button>
          {open && health && (
            <div className="status-pop clay pop-in" role="dialog" aria-label="System status">
              <b style={{ fontFamily: 'var(--font-display)' }}>System status</b>
              <StatusRow ok={health.gemini.ok} label={health.gemini.ok ? 'AI (Gemini) connected' : 'AI not connected'} />
              <StatusRow
                ok={Boolean(health.ffmpeg) && !ffSettingUp}
                pending={ffSettingUp}
                label={ffSettingUp ? health.ffmpegStatus?.detail || 'Setting up the video engine…' : health.ffmpeg ? `Video engine · ${health.ffmpegSource ?? 'ready'}` : 'Video engine unavailable'}
              />
              {!ffSettingUp && <StatusRow ok={health.captions !== false} label={health.captions === false ? 'Captions off' : 'Captions on'} />}
              <StatusRow
                ok={health.ytdlpStatus?.state === 'ready'}
                pending={ytSettingUp}
                label={
                  ytSettingUp
                    ? health.ytdlpStatus?.detail || 'Setting up the downloader…'
                    : health.ytdlpStatus?.state === 'ready'
                      ? `Link downloader · auto-updated${health.ytdlp ? ` (${health.ytdlp})` : ''}`
                      : 'Link downloader unavailable'
                }
              />
              <p className="faint" style={{ fontSize: 12 }}>
                CrestClip installs and updates these for you.
              </p>
            </div>
          )}
        </div>
      </aside>
      <main className="main">
        {showBanner && (
          <section className={`setup-banner clay ${blocking.length ? 'bad' : ''}`} role="status">
            <AlertTriangle size={20} className="setup-ico" />
            <div className="grow stack" style={{ gap: 10 }}>
              {issues.map((i) => (
                <div key={i.key} className="setup-issue">
                  <div className="grow">
                    <b>{i.title}</b> <span className="muted">— {i.detail}</span>
                  </div>
                  {i.action === 'retry-tools' && (
                    <button type="button" className="btn btn-sm" onClick={retryTools} disabled={retrying}>
                      {retrying ? <span className="spinner" /> : <RefreshCw size={14} />} Try again
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              className="btn btn-icon btn-sm"
              aria-label="Hide for now"
              onClick={() => {
                try {
                  sessionStorage.setItem('crestclip:banner', issueKey);
                } catch {
                  /* ignore */
                }
                setDismissed(issueKey);
              }}
            >
              <X size={16} />
            </button>
          </section>
        )}
        <Outlet context={{ health }} />
      </main>
      <Toaster />
    </div>
  );
}

function StatusRow({ ok, label, pending }: { ok: boolean; label: string; pending?: boolean }) {
  return (
    <div className="row" style={{ gap: 8, fontSize: 13, fontWeight: 700 }}>
      {pending ? <Loader2 size={16} className="spin-icon" color="var(--ink-3)" /> : ok ? <CheckCircle2 size={16} color="var(--good)" /> : <AlertTriangle size={16} color="var(--warn)" />}
      <span className={ok ? '' : 'muted'}>{label}</span>
    </div>
  );
}

function Toaster() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setList), []);
  return (
    <div className="toaster" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast clay-sm pop-in ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
