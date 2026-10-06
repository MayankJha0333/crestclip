import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Loader2, Monitor, Moon, RefreshCw, ShieldCheck, Sun } from 'lucide-react';
import { api, type Connections } from '../../lib/api';
import { cn } from '../../lib/cn';
import { usePolling } from '../../lib/hooks';
import { useTheme, type ThemeChoice } from '../../lib/theme';
import { toast } from '../../lib/toast';
import { Button, buttonClass, Card, CardHeader, PageHeader } from '../../components/ui';
import { SOCIAL } from '../schedule/postStatus';
import { WatermarkSection } from '../watermark/WatermarkSection';
import { AccountsSection } from './AccountsSection';
import { useAuth } from '../auth/auth';
import { ProfileSection } from './ProfileSection';
import { useHealth } from './health';

function StatusRow({ ok, pending, label }: { ok: boolean; pending?: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2.5 rounded-2xl bg-row px-3.5 py-3 text-sm font-bold shadow-flat">
      {pending ? <Loader2 size={17} className="animate-spin text-ink-3" /> : ok ? <CheckCircle2 size={17} className="text-good" /> : <AlertTriangle size={17} className="text-warn" />}
      <span className={ok ? 'text-ink' : 'text-ink-2'}>{label}</span>
    </li>
  );
}

export function SystemSection() {
  const { health, reload } = useHealth();
  const [retrying, setRetrying] = useState(false);
  const ffSettingUp = health?.ffmpegStatus?.state === 'installing';
  const ytSettingUp = health?.ytdlpStatus?.state === 'installing' || health?.ytdlpStatus?.state === 'updating';
  const retry = async () => {
    setRetrying(true);
    try {
      await api.refreshTools();
      await reload();
      toast('Checked again');
    } catch {
      toast('Still not working — CrestClip keeps retrying', 'error');
    } finally {
      setRetrying(false);
    }
  };
  return (
    <Card className="p-5 sm:p-6">
      <CardHeader
        title="System status"
        description="CrestClip installs and updates its video tools for you."
        actions={
          <Button size="sm" loading={retrying} onClick={retry}>
            {!retrying && <RefreshCw size={14} />} Check again
          </Button>
        }
      />
      {!health ? (
        <p className="text-ink-3">Checking…</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          <StatusRow ok={health.ai.ok} label={health.ai.ok ? (health.ai.fake ? 'AI · demo mode' : 'AI connected') : 'AI not connected'} />
          {health.potHelper !== null && health.potHelper !== undefined && (
            <StatusRow ok={health.potHelper} label={health.potHelper ? 'YouTube token helper · running' : 'YouTube token helper · not reachable'} />
          )}
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
        </ul>
      )}
    </Card>
  );
}

function AppearanceSection() {
  const [choice, setChoice] = useTheme();
  const opts: { v: ThemeChoice; label: string; hint: string; Icon: typeof Sun }[] = [
    { v: 'light', label: 'Light', hint: 'Warm paper', Icon: Sun },
    { v: 'dark', label: 'Dark', hint: 'Clay at night', Icon: Moon },
    { v: 'system', label: 'Auto', hint: 'Match my computer', Icon: Monitor },
  ];
  return (
    <Card className="p-5 sm:p-6">
      <CardHeader title="Appearance" description="Pick how CrestClip looks. Saved on this device." />
      <div role="radiogroup" aria-label="Colour theme" className="grid grid-cols-3 gap-3">
        {opts.map(({ v, label, hint, Icon }) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={choice === v}
            onClick={() => setChoice(v)}
            className={cn(
              'flex flex-col items-center gap-1.5 rounded-2xl p-4 text-center transition-transform hover:-translate-y-0.5',
              choice === v ? 'bg-surface shadow-[0_0_0_3px_var(--tangerine)]' : 'bg-row shadow-flat',
            )}
          >
            <Icon size={22} />
            <b className="font-display">{label}</b>
            <span className="text-xs text-ink-3">{hint}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

/** One-time setup lives here: logo, connected accounts and look. System health and account admin are on /app/admin. */
export function SettingsPage() {
  const { me } = useAuth();
  const [data, setData] = useState<Connections | null>(null);
  const [params, setParams] = useSearchParams();
  const load = () =>
    api
      .connections()
      .then(setData)
      .catch(() => {});
  usePolling(load, 15000);

  // result of the OAuth round-trip (the server redirects back here)
  useEffect(() => {
    const ok = params.get('connected') as keyof typeof SOCIAL | null;
    const err = params.get('error');
    if (ok) toast(`${SOCIAL[ok]?.name ?? ok} connected${params.get('name') ? ` — ${params.get('name')}` : ''}`);
    if (err) toast(err, 'error');
    if (ok || err) setParams({}, { replace: true });
  }, [params, setParams]);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Your account, logo, connected accounts and theme."
        actions={
          me?.user.isAdmin ? (
            <Link to="/app/admin" className={buttonClass('secondary')}>
              <ShieldCheck size={16} /> Admin
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-6">
        <ProfileSection />
        <WatermarkSection />
        <Card className="p-5 sm:p-6">
          <CardHeader title="Connected accounts" description="Connect each account once. Then press Post on any clip, or let Autopilot post for you." />
          <AccountsSection data={data} onChange={load} />
        </Card>
        <AppearanceSection />
      </div>
    </>
  );
}
