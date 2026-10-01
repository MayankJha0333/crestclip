import { useEffect, useRef, useState } from 'react';
import { Music, Pause, Play, Trash2, Upload, Wand2 } from 'lucide-react';
import { api, type Motion, type MusicLibrary } from '../lib/api';
import { Seg, Toggle } from './bits';
import { toast } from '../lib/toast';

export const MOTION_OPTIONS: { value: Motion; label: string; hint: string }[] = [
  { value: 'none', label: 'Off', hint: 'Steady framing, no zooms' },
  { value: 'subtle', label: 'Subtle', hint: 'A gentle punch-in every few seconds + smooth pans between speakers' },
  { value: 'dynamic', label: 'Dynamic', hint: 'Fast-paced punch-in zooms and a zoom-out on the hook, like pro short-form edits' },
];

export function MotionPicker({ value, onChange }: { value: Motion; onChange: (m: Motion) => void }) {
  return (
    <div>
      <Seg label="Edit motion" value={value} onChange={onChange} options={MOTION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
      <p className="faint" style={{ fontSize: 13, marginTop: 8 }}>
        {MOTION_OPTIONS.find((o) => o.value === value)?.hint}
      </p>
    </div>
  );
}

let shared: HTMLAudioElement | null = null;

/**
 * Pick background music: none, auto (matches each clip's mood), an AI mood track (made with Lyria on
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
    api.music().then(setLib).catch(() => setLib(null));
    return () => {
      shared?.pause();
    };
  }, []);

  const play = (key: string, url: string | null) => {
    if (!url) return;
    if (playing === key) {
      shared?.pause();
      setPlaying(null);
      return;
    }
    shared?.pause();
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
      api.music().then(setLib).catch(() => {});
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

  const aiOff = lib && !lib.ai.available && !lib.ai.fake;
  const aiError = lib?.ai.ok === false ? lib.ai.detail : null;
  const on = track !== 'none';

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="mood-grid">
        <button type="button" className="mood" aria-pressed={track === 'none'} onClick={() => onChange({ track: 'none' })}>
          No music
          <small>Voice only</small>
        </button>
        <button type="button" className="mood" aria-pressed={track === 'auto'} onClick={() => onChange({ track: 'auto' })} disabled={Boolean(aiOff)}>
          <span className="row" style={{ gap: 6 }}>
            <Wand2 size={14} /> Auto
          </span>
          <small>Matches each clip’s mood</small>
        </button>
        {(lib?.moods ?? []).map((m) => (
          <div key={m.id} className="mood" role="button" tabIndex={0} aria-pressed={track === m.id} onClick={() => !aiOff && onChange({ track: m.id })} onKeyDown={(e) => e.key === 'Enter' && !aiOff && onChange({ track: m.id })} aria-disabled={Boolean(aiOff)}>
            {m.label}
            <small>{m.hint}</small>
            <button
              type="button"
              className="mood-play"
              aria-label={`${playing === m.id ? 'Stop' : 'Preview'} ${m.label}`}
              title={m.ready ? 'Preview' : 'Make this track with AI and preview it (first time takes ~20 s)'}
              disabled={Boolean(aiOff) || making === m.id}
              onClick={(e) => {
                e.stopPropagation();
                preview(m.id);
              }}
            >
              {making === m.id ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> : playing === m.id ? <Pause size={13} /> : <Play size={13} />}
            </button>
          </div>
        ))}
        {(lib?.uploads ?? []).map((u) => (
          <div key={u.id} className="mood" role="button" tabIndex={0} aria-pressed={track === `upload:${u.id}`} onClick={() => onChange({ track: `upload:${u.id}` })} onKeyDown={(e) => e.key === 'Enter' && onChange({ track: `upload:${u.id}` })}>
            <span className="row" style={{ gap: 6 }}>
              <Music size={14} /> <span className="clamp1">{u.name}</span>
            </span>
            <small>
              Your track ·{' '}
              <span
                role="button"
                tabIndex={0}
                className="linkish"
                style={{ fontSize: 12 }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (track === `upload:${u.id}`) onChange({ track: 'none' });
                  api.removeMusic(u.id).then(setLib);
                }}
              >
                <Trash2 size={11} /> remove
              </span>
            </small>
            <button
              type="button"
              className="mood-play"
              aria-label={`${playing === u.id ? 'Stop' : 'Preview'} ${u.name}`}
              onClick={(e) => {
                e.stopPropagation();
                play(u.id, u.url);
              }}
            >
              {playing === u.id ? <Pause size={13} /> : <Play size={13} />}
            </button>
          </div>
        ))}
        <button type="button" className="mood" onClick={() => fileRef.current?.click()} disabled={uploading}>
          <span className="row" style={{ gap: 6 }}>
            {uploading ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : <Upload size={14} />} Upload a track
          </span>
          <small>MP3, WAV, M4A — only use music you own</small>
        </button>
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

      {aiOff && <p className="music-note">AI music needs Google Cloud connected. You can still upload your own track.</p>}
      {aiError && !aiOff && <p className="music-note">Last AI music attempt failed: {aiError}</p>}

      {on && (
        <>
          <label className="music-row">
            <span style={{ fontWeight: 800, fontSize: 14, minWidth: 110 }}>Music volume · {volume}%</span>
            <input type="range" min={3} max={60} value={volume} onChange={(e) => onChange({ volume: Number(e.target.value) })} aria-label="Music volume" />
          </label>
          {!compact && duck !== undefined && (
            <Toggle checked={duck} onChange={(v) => onChange({ duck: v })}>
              Lower the music while people talk
            </Toggle>
          )}
        </>
      )}
      {!compact && <p className="music-note">AI tracks are instrumental, made for you with Google’s Lyria model on your Google Cloud credits, and reused for every clip.</p>}
    </div>
  );
}
