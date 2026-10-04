import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Health } from '../../lib/api';

interface Issue {
  key: string;
  title: string;
  detail: string;
  action?: 'retry-tools';
}

/**
 * CrestClip installs and updates its own video tools, so people never see terminal commands.
 * This turns only *real* problems into plain-language messages.
 */
function issuesFrom(h: Health | null): Issue[] {
  if (!h) return [];
  const out: Issue[] = [];
  if (!h.ai.ok) out.push({ key: 'ai', title: 'The AI isn’t connected', detail: 'CrestClip can’t reach its AI right now, so new clips can’t be made. Browsing still works.' });
  const ffInstalling = h.ffmpegStatus?.state === 'installing';
  if (!h.ffmpeg && !ffInstalling) out.push({ key: 'ffmpeg', title: 'The video engine didn’t start', detail: h.ffmpegStatus?.detail || 'Rendering is unavailable right now.', action: 'retry-tools' });
  else if (h.captions === false && !ffInstalling)
    out.push({
      key: 'captions',
      title: 'Captions are off',
      detail:
        h.ffmpegSource === 'custom'
          ? 'A custom video engine is set in .env that can’t draw text. Clips still render without captions.'
          : h.ffmpegStatus?.detail || 'Clips still render, just without captions.',
      action: h.ffmpegSource === 'custom' ? undefined : 'retry-tools',
    });
  if (h.ytdlpStatus?.state === 'error')
    out.push({
      key: 'ytdlp',
      title: 'Links can’t be downloaded right now',
      detail: h.ytdlpStatus.detail || 'The video downloader isn’t available. Uploading files still works.',
      action: 'retry-tools',
    });
  return out;
}

export type HealthState = 'checking' | 'ok' | 'setup' | 'warn' | 'bad';

interface Ctx {
  health: Health | null;
  issues: Issue[];
  state: HealthState;
  reload: () => Promise<void>;
}
const HealthContext = createContext<Ctx>({ health: null, issues: [], state: 'checking', reload: async () => {} });

/** Keeps the system status fresh (faster while tools are being set up). */
export function HealthProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const reload = useCallback(
    () =>
      api
        .health()
        .then(setHealth)
        .catch(() => setHealth(null)),
    [],
  );
  const settingUp = health?.ffmpegStatus?.state === 'installing' || health?.ytdlpStatus?.state === 'installing' || health?.ytdlpStatus?.state === 'updating';
  useEffect(() => {
    reload();
    const t = setInterval(reload, settingUp ? 4000 : 60_000);
    return () => clearInterval(t);
  }, [reload, settingUp]);
  const issues = issuesFrom(health);
  const blocking = issues.some((i) => i.key === 'ai' || i.key === 'ffmpeg');
  const state: HealthState = !health ? 'checking' : blocking ? 'bad' : issues.length ? 'warn' : settingUp ? 'setup' : 'ok';
  return <HealthContext.Provider value={{ health, issues, state, reload }}>{children}</HealthContext.Provider>;
}

export const useHealth = () => useContext(HealthContext);
