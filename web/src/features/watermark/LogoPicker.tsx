import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, ListChecks, Lock, Pencil, Plus, Star, X } from 'lucide-react';
import { api, type LogoChoice, type Watermark, type WatermarkSize } from '../../lib/api';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { FieldLabel, Segmented, Skeleton, Spinner } from '../../components/ui';
import { setWatermark, useWatermark } from './useWatermark';
import { checker, spotOf } from './WatermarkMark';
import { logoAskLabel, matchLogo, spotName, withLogoAsk, type LogoAsk } from './logoAsk';
import { SpotPicker } from './SpotPicker';

const SIZES: { value: WatermarkSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

/**
 * The logo these clips will get: the project's own pick, or (none picked) the Settings logo in its corner.
 * A picked logo that was deleted since falls back to the Settings one in the picked spot, like the renderer does.
 */
export function effectiveLogo(w: Watermark, choice: LogoChoice | undefined): LogoChoice {
  if (choice) return choice.id === null || w.logos.some((l) => l.id === choice.id) ? choice : { ...choice, id: w.defaultLogoId };
  return { id: w.enabled ? w.defaultLogoId : null, ...spotOf(w), size: w.size, opacity: w.opacity };
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

const SIZE_NAME: Record<WatermarkSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };

/**
 * New clips → Logo. By default these clips get the main logo from Settings, shown as one summary line. "Change for
 * this project" opens the full picker (another logo, none, or a new upload; spot, size, visibility) — only for this
 * project. `value` undefined = follow Settings. `ask` is what the instructions say about the logo: it wins, so the
 * parts it decides are shown and locked here.
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
  const own = value !== undefined; // this project has its own pick
  const shown = w.logos.find((l) => l.id === c.id);

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
  const summary = c.id === null ? 'These clips come out without a logo' : `${spotName(c.x, c.y)} · ${SIZE_NAME[c.size]} · ${c.opacity}%`;

  return (
    <div>
      <FieldLabel>Logo</FieldLabel>
      {byText && (
        <p className="mb-2.5 flex items-start gap-1.5 rounded-2xl bg-good-bg px-3 py-2 text-xs font-bold text-good-ink">
          <ListChecks size={14} className="mt-px shrink-0" />
          <span>Your instructions set: {logoAskLabel(w, ask ?? null)}. Edit the text to change it.</span>
        </p>
      )}
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />

      {/* what these clips get, in one line */}
      <div className="flex items-center gap-3 rounded-[20px] bg-row p-2.5 pr-3 shadow-flat">
        <span className={cn('grid size-11 shrink-0 place-items-center overflow-hidden rounded-xl p-1 shadow-flat', shown?.url ? checker : 'bg-sunken text-ink-3')}>
          {shown?.url ? <img src={shown.url} alt="" className="max-h-full max-w-full object-contain" /> : <Ban size={18} />}
        </span>
        <span className="min-w-0 flex-1">
          <b className="block truncate text-sm">{own ? 'Only for this project' : c.id === null ? 'No logo' : 'Your main logo'}</b>
          <span className="block truncate text-xs text-ink-3">{summary}</span>
        </span>
        {own ? (
          <button type="button" onClick={() => onChange(undefined)} className="shrink-0 text-xs font-bold text-accent underline-offset-2 hover:underline">
            Use main logo
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onChange({ ...base })}
            aria-label="Change the logo for this project"
            title="Use another logo, no logo, or another spot — only for this project"
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface px-2.5 py-1.5 text-xs font-extrabold text-ink shadow-flat hover:bg-row-hover"
          >
            <Pencil size={12} /> Change
          </button>
        )}
      </div>
      {!own && c.id === null && (
        <p className="mt-2 text-xs text-ink-3">
          {w.logos.length ? 'Your main logo is paused, or not picked. ' : 'No logo uploaded yet. '}
          <Link to="/app/settings" className="font-bold text-accent underline-offset-2 hover:underline">
            Set it up in Settings
          </Link>{' '}
          to get it on every clip — or press Change to add one just here.
        </p>
      )}

      {own && (
        <div className="mt-2.5 flex flex-col gap-3 rounded-[20px] bg-row p-3 shadow-flat">
          <fieldset disabled={byText?.logo} className={cn('min-w-0', byText?.logo && 'opacity-45')}>
            <span className="mb-1.5 block text-xs font-bold text-ink-2">Which logo</span>
            <div role="radiogroup" aria-label="Logo for these clips" className="flex flex-wrap gap-2">
              <button
                type="button"
                role="radio"
                aria-checked={c.id === null}
                title="No logo on these clips"
                onClick={() => pick({ id: null })}
                className={cn(tile(c.id === null), 'bg-sunken text-ink-3')}
              >
                <Ban size={18} />
                <span className="sr-only">No logo</span>
              </button>
              {w.logos.map((l) => {
                const main = l.id === w.defaultLogoId;
                return (
                  <span key={l.id} className="group relative">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={c.id === l.id}
                      title={main ? `${l.name || 'Your logo'} · your main logo` : l.name}
                      onClick={() => pick({ id: l.id })}
                      className={cn(tile(c.id === l.id), checker)}
                    >
                      {l.url && <img src={l.url} alt={l.name || 'Logo'} className="max-h-full max-w-full object-contain" />}
                    </button>
                    {main ? (
                      <Star size={13} aria-label="Main logo" className="pointer-events-none absolute -top-1 -right-1 rounded-full bg-surface p-0.5 text-tangerine shadow-flat" fill="currentColor" />
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
              <div>
                <span className="mb-1.5 block text-xs font-bold text-ink-2">Where it goes</span>
                <SpotPicker x={c.x} y={c.y} onPick={(x, y) => pick({ x, y })} disabled={byText?.spot} />
              </div>
              <fieldset disabled={byText?.size} className={cn('min-w-0', byText?.size && 'opacity-45')}>
                <span className="mb-1.5 block text-xs font-bold text-ink-2">Size</span>
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
            </>
          )}
          <p className="text-xs text-ink-3">This only changes this project. Your main logo in Settings stays the same.</p>
        </div>
      )}
    </div>
  );
}
