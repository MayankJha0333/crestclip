import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, ListChecks, Lock, Plus, Star, X } from 'lucide-react';
import { api, type LogoChoice, type Watermark, type WatermarkSize } from '../../lib/api';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { FieldLabel, Segmented, Skeleton, Spinner } from '../../components/ui';
import { setWatermark, useWatermark } from './useWatermark';
import { CORNERS, checker } from './WatermarkMark';
import { logoAskLabel, matchLogo, spotName, withLogoAsk, type LogoAsk } from './logoAsk';

const SIZES: { value: WatermarkSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];
const ROWS = [0, 0.5, 1];
const near = (a: number, b: number) => Math.abs(a - b) < 0.02;

/**
 * The logo these clips will get: the project's own pick, or (none picked) the Settings logo in its corner.
 * A picked logo that was deleted since falls back to the Settings one in the picked spot, like the renderer does.
 */
export function effectiveLogo(w: Watermark, choice: LogoChoice | undefined): LogoChoice {
  if (choice) return choice.id === null || w.logos.some((l) => l.id === choice.id) ? choice : { ...choice, id: w.defaultLogoId };
  return { id: w.enabled ? w.defaultLogoId : null, ...CORNERS[w.position], size: w.size, opacity: w.opacity };
}

/** That logo as a watermark the phone preview can draw. */
export const previewOf = (w: Watermark, c: LogoChoice): Watermark => ({
  ...w,
  enabled: c.id !== null,
  logoUrl: w.logos.find((l) => l.id === c.id)?.url ?? null,
  size: c.size,
  opacity: c.opacity,
  x: c.x,
  y: c.y,
});

/**
 * New clips → Logo: pick which logo goes on these clips (or none, or upload one right here), how big and how solid,
 * and where — a quick spot here, or anywhere by dragging it on the preview. `value` undefined = follow Settings.
 * `ask` is what the instructions say about the logo: it wins, so the parts it decides are shown and locked here.
 */
export function LogoPicker({ value, onChange, ask }: { value: LogoChoice | undefined; onChange: (v: LogoChoice | undefined) => void; ask?: LogoAsk | null }) {
  const w = useWatermark();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null); // 'upload' or the id being deleted

  if (!w) return <Skeleton className="h-24" />;
  if (w.locked)
    return (
      <div>
        <FieldLabel>Logo</FieldLabel>
        <p className="flex items-start gap-2 rounded-[20px] bg-row px-3.5 py-3 text-[13px] text-ink-2 shadow-flat">
          <Lock size={15} className="mt-0.5 shrink-0 text-accent" />
          <span>
            Free clips carry a small CrestClip mark.{' '}
            <Link to="/app/billing" className="font-bold text-accent underline-offset-2 hover:underline">
              Upgrade
            </Link>{' '}
            to put your own logo anywhere on the video.
          </span>
        </p>
      </div>
    );

  const base = effectiveLogo(w, value);
  const c = withLogoAsk(w, base, ask ?? null);
  const pick = (patch: Partial<LogoChoice>) => onChange({ ...base, ...patch });
  const byText = ask && c !== base ? { logo: Boolean(ask.none || matchLogo(w.logos, ask.hint)), spot: ask.x != null, size: Boolean(ask.size), opacity: ask.opacity != null } : null;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy('upload');
    try {
      const r = await api.addLogo(file);
      setWatermark(r);
      pick({ id: r.added });
      toast('Logo added — it’s on these clips');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    try {
      setWatermark(await api.removeLogo(id));
      if (value?.id === id) onChange(undefined);
      toast('Logo deleted');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const tile = (on: boolean) =>
    cn(
      'grid size-12 place-items-center overflow-hidden rounded-2xl p-1.5 shadow-flat transition-all',
      on ? 'shadow-[0_0_0_3px_var(--tangerine)]' : 'hover:-translate-y-px hover:shadow-[0_0_0_1px_var(--line-strong)]',
    );

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <FieldLabel className="mb-0">Logo</FieldLabel>
        {value ? (
          <button type="button" onClick={() => onChange(undefined)} className="text-xs font-bold text-accent underline-offset-2 hover:underline">
            Use my Settings logo
          </button>
        ) : (
          <span className="text-xs text-ink-3">From Settings</span>
        )}
      </div>
      {byText && (
        <p className="mb-2.5 flex items-start gap-1.5 rounded-2xl bg-good-bg px-3 py-2 text-xs font-bold text-good-ink">
          <ListChecks size={14} className="mt-px shrink-0" />
          <span>Your instructions set: {logoAskLabel(w, ask ?? null)}. Edit the text to change it.</span>
        </p>
      )}
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />

      <fieldset disabled={byText?.logo} className={cn('min-w-0', byText?.logo && 'opacity-45')}>
        <div role="radiogroup" aria-label="Logo for these clips" className="flex flex-wrap gap-2">
          <button type="button" role="radio" aria-checked={c.id === null} title="No logo" onClick={() => pick({ id: null })} className={cn(tile(c.id === null), 'bg-row text-ink-3')}>
            <Ban size={18} />
            <span className="sr-only">No logo</span>
          </button>
          {w.logos.map((l) => {
            const isDefault = l.id === w.defaultLogoId;
            return (
              <span key={l.id} className="group relative">
                <button
                  type="button"
                  role="radio"
                  aria-checked={c.id === l.id}
                  title={isDefault ? `${l.name || 'Your logo'} · your Settings logo` : l.name}
                  onClick={() => pick({ id: l.id })}
                  className={cn(tile(c.id === l.id), checker)}
                >
                  {l.url && <img src={l.url} alt={l.name || 'Logo'} className="max-h-full max-w-full object-contain" />}
                </button>
                {isDefault ? (
                  <Star size={13} aria-hidden className="pointer-events-none absolute -top-1 -right-1 rounded-full bg-surface p-0.5 text-tangerine shadow-flat" fill="currentColor" />
                ) : (
                  <button
                    type="button"
                    aria-label={`Delete ${l.name || 'this logo'}`}
                    title="Delete this logo"
                    disabled={busy === l.id}
                    onClick={() => remove(l.id)}
                    className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-surface text-ink-2 opacity-0 shadow-flat transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:text-bad-ink"
                  >
                    {busy === l.id ? <Spinner className="size-3 border-2" /> : <X size={12} strokeWidth={3} />}
                  </button>
                )}
              </span>
            );
          })}
          <button
            type="button"
            title="Upload a logo for these clips"
            disabled={busy === 'upload'}
            onClick={() => fileInput.current?.click()}
            className="grid size-12 place-items-center rounded-2xl border-2 border-dashed border-line-strong text-ink-2 transition-colors hover:border-tangerine hover:text-ink"
          >
            {busy === 'upload' ? <Spinner /> : <Plus size={18} />}
            <span className="sr-only">Upload a logo</span>
          </button>
        </div>
      </fieldset>

      {c.id !== null && (
        <>
          <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-[20px] bg-row p-3 shadow-flat">
            {/* nine quick spots on a mini 9:16 frame */}
            <fieldset disabled={byText?.spot} className={cn('min-w-0', byText?.spot && 'opacity-45')}>
              <div role="radiogroup" aria-label="Logo spot" className="grid aspect-[9/16] w-14 grid-cols-3 grid-rows-3 place-items-center rounded-xl bg-sunken p-1 shadow-well">
                {ROWS.map((y) =>
                  ROWS.map((x) => {
                    const on = near(c.x, x) && near(c.y, y);
                    const name = spotName(x, y);
                    return (
                      <button
                        key={`${x}-${y}`}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={name}
                        title={name}
                        onClick={() => pick({ x, y })}
                        className="grid size-full place-items-center rounded-md hover:bg-row-hover"
                      >
                        <span className={cn('rounded-full transition-all', on ? 'size-2.5 bg-tangerine' : 'size-1.5 bg-ink-3')} />
                      </button>
                    );
                  }),
                )}
              </div>
            </fieldset>
            <div className="flex min-w-0 flex-col gap-2.5">
              <fieldset disabled={byText?.size} className={cn('min-w-0', byText?.size && 'opacity-45')}>
                <Segmented label="Logo size" size="sm" value={c.size} onChange={(size) => pick({ size })} options={SIZES} />
              </fieldset>
              <fieldset disabled={byText?.opacity} className={cn('min-w-0', byText?.opacity && 'opacity-45')}>
                <label className="block">
                  <span className="flex justify-between text-xs font-bold text-ink-2">
                    Visibility <span className="tabular-nums">{c.opacity}%</span>
                  </span>
                  <input type="range" min={20} max={100} step={5} value={c.opacity} aria-label="Logo visibility" className="mt-1 w-full" onChange={(e) => pick({ opacity: Number(e.target.value) })} />
                </label>
              </fieldset>
            </div>
          </div>
          {!byText?.spot && <p className="mt-2 text-xs text-ink-3">Tap a spot, or drag the logo on the preview to put it anywhere.</p>}
        </>
      )}
    </div>
  );
}
