import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Music, Pause, Play, Trash2, Upload, Wand2 } from 'lucide-react';
import { api, type MusicLibrary } from '../../lib/api';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { Spinner, Toggle } from '../../components/ui';

let shared: HTMLAudioElement | null = null;

function Tile({ on, disabled, onSelect, title, hint, side }: { on: boolean; disabled?: boolean; onSelect: () => void; title: ReactNode; hint: ReactNode; side?: ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={on}
      aria-disabled={disabled}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !disabled && (e.preventDefault(), onSelect())}
      className={cn(
        'relative flex min-h-16 cursor-pointer flex-col items-start gap-0.5 rounded-2xl px-3 py-2.5 pr-10 text-left text-sm font-extrabold transition-transform duration-200 hover:-translate-y-0.5',
        on ? 'bg-mint text-[#0f3b2e] shadow-[inset_0_0_0_2px_var(--mint-d)]' : 'bg-row shadow-flat',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      {title}
      <small className={cn('text-xs font-semibold', on ? 'text-[#1f5e4c]' : 'text-ink-3')}>{hint}</small>
      {side && <span className="absolute top-2 right-2">{side}</span>}
    </div>
  );
}

function PlayButton({ label, state, onClick, disabled, title }: { label: string; state: 'idle' | 'playing' | 'making'; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid size-7 place-items-center rounded-full bg-surface text-ink shadow-flat disabled:opacity-50"
    >
      {state === 'making' ? <Spinner className="size-3 border-2" /> : state === 'playing' ? <Pause size={13} /> : <Play size={13} />}
    </button>
  );
}

/**
 * Background music: none, auto (matches each clip's mood), an AI mood track (made with Lyria on
 * your Google Cloud credits, cached after the first time), or your own upload. Tap ▶ to preview.
 */
export function MusicPicker({
  track,
  volume,
  duck,
  onChange,
  compact,
}: {
  track: string;
  volume: number;
  duck?: boolean;
  onChange: (v: { track?: string; volume?: number; duck?: boolean }) => void;
  compact?: boolean;
}) {
  const [lib, setLib] = useState<MusicLibrary | null>(null);
  const [making, setMaking] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .music()
      .then(setLib)
      .catch(() => setLib(null));
    return () => shared?.pause();
  }, []);

  const play = (key: string, url: string | null) => {
    if (!url) return;
    shared?.pause();
    if (playing === key) return setPlaying(null);
    shared = new Audio(url);
    shared.volume = 0.6;
    shared.onended = () => setPlaying(null);
    shared.play().catch(() => setPlaying(null));
    setPlaying(key);
  };

  const preview = async (id: string) => {
    const m = lib?.moods.find((x) => x.id === id);
    if (m?.ready && m.url) return play(id, m.url);
    setMaking(id);
    try {
      const next = await api.makeMood(id);
      setLib(next);
      play(id, next.moods.find((x) => x.id === id)?.url ?? null);
    } catch (e) {
      toast((e as Error).message, 'error');
      api
        .music()
        .then(setLib)
        .catch(() => {});
    } finally {
      setMaking(null);
    }
  };

  const upload = async (f: File) => {
    setUploading(true);
    try {
      const next = await api.uploadMusic(f);
      setLib(next);
      onChange({ track: `upload:${next.added}` });
      toast('Track added');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setUploading(false);
    }
  };

  const aiOff = Boolean(lib && !lib.ai.available && !lib.ai.fake);
  const aiError = lib?.ai.ok === false ? lib.ai.detail : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        <Tile on={track === 'none'} onSelect={() => onChange({ track: 'none' })} title="No music" hint="Voice only" />
        <Tile
          on={track === 'auto'}
          disabled={aiOff}
          onSelect={() => onChange({ track: 'auto' })}
          title={
            <span className="inline-flex items-center gap-1.5">
              <Wand2 size={14} /> Auto
            </span>
          }
          hint="Matches each clip’s mood"
        />
        {(lib?.moods ?? []).map((m) => (
          <Tile
            key={m.id}
            on={track === m.id}
            disabled={aiOff}
            onSelect={() => onChange({ track: m.id })}
            title={m.label}
            hint={m.hint}
            side={
              <PlayButton
                label={`${playing === m.id ? 'Stop' : 'Preview'} ${m.label}`}
                title={m.ready ? 'Preview' : 'Make this track with AI and preview it (first time takes ~20 s)'}
                disabled={aiOff || making === m.id}
                state={making === m.id ? 'making' : playing === m.id ? 'playing' : 'idle'}
                onClick={() => preview(m.id)}
              />
            }
          />
        ))}
        {(lib?.uploads ?? []).map((u) => {
          const key = `upload:${u.id}`;
          return (
            <Tile
              key={u.id}
              on={track === key}
              onSelect={() => onChange({ track: key })}
              title={
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Music size={14} /> <span className="truncate">{u.name}</span>
                </span>
              }
              hint={
                <button
                  type="button"
                  className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (track === key) onChange({ track: 'none' });
                    api.removeMusic(u.id).then(setLib);
                  }}
                >
                  <Trash2 size={11} /> Remove
                </button>
              }
              side={<PlayButton label={`${playing === u.id ? 'Stop' : 'Preview'} ${u.name}`} state={playing === u.id ? 'playing' : 'idle'} onClick={() => play(u.id, u.url)} />}
            />
          );
        })}
        <Tile
          on={false}
          disabled={uploading}
          onSelect={() => fileRef.current?.click()}
          title={<span className="inline-flex items-center gap-1.5">{uploading ? <Spinner className="size-3.5 border-2" /> : <Upload size={14} />} Upload a track</span>}
          hint="MP3, WAV, M4A — only music you own"
        />
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            e.target.value = '';
          }}
        />
      </div>

      {aiOff && <p className="text-[13px] text-ink-3">AI music needs Google Cloud connected. You can still upload your own track.</p>}
      {aiError && !aiOff && <p className="text-[13px] text-ink-3">Last AI music attempt failed: {aiError}</p>}

      {track !== 'none' && (
        <>
          <label className="flex flex-wrap items-center gap-3">
            <span className="min-w-36 text-sm font-extrabold">Music volume · {volume}%</span>
            <input className="min-w-36 flex-1" type="range" min={3} max={60} value={volume} onChange={(e) => onChange({ volume: Number(e.target.value) })} aria-label="Music volume" />
          </label>
          {!compact && duck !== undefined && (
            <Toggle checked={duck} onChange={(v) => onChange({ duck: v })}>
              Lower the music while people talk
            </Toggle>
          )}
        </>
      )}
      {!compact && <p className="text-[13px] text-ink-3">AI tracks are instrumental, made just for your clips, and reused for every clip.</p>}
    </div>
  );
}
