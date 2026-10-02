import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Info, Pointer, RefreshCw, Trash2, UploadCloud } from 'lucide-react';
import { api, type Watermark, type WatermarkPatch, type WatermarkSize } from '../../lib/api';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { Badge, Button, Card, CardHeader, Segmented, Skeleton, Toggle } from '../../components/ui';
import { setWatermark, useWatermark } from './useWatermark';
import { UpgradeCallout } from '../billing/UpgradeCallout';
import { POSITIONS, WatermarkPhone } from './WatermarkPhone';

const SIZES: { value: WatermarkSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];
const SCENES = [
  { value: 'light' as const, label: 'Bright video' },
  { value: 'dark' as const, label: 'Dark video' },
];

/** A checkerboard, so a see-through logo is visible on any theme. */
const checker = 'bg-[repeating-conic-gradient(var(--sunken)_0_25%,var(--surface)_0_50%)] bg-[length:14px_14px]';

/** One setting in the list: label (+ hint) on the left, its control on the right — or below on narrow screens. */
function Row({ label, hint, children, stack, nowrap }: { label: ReactNode; hint?: ReactNode; children: ReactNode; stack?: boolean; nowrap?: boolean }) {
  return (
    <div className={cn('flex gap-3 px-4 py-3.5', stack ? 'flex-col' : 'items-center justify-between', !stack && !nowrap && 'flex-wrap')}>
      <div className="min-w-0">
        <b className="block text-sm">{label}</b>
        {hint && <span className="block text-xs text-ink-3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** Settings → Watermark: upload a logo once and it's stamped on every new clip. */
export function WatermarkSection() {
  const w = useWatermark();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scene, setScene] = useState<'light' | 'dark'>('light');
  const [opacity, setOpacity] = useState<number | null>(null); // the slider while it's moving
  const saveTimer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  const save = async (patch: WatermarkPatch, prev: Watermark) => {
    setWatermark({ ...prev, ...patch }); // show it right away
    try {
      setWatermark(await api.updateWatermark(patch));
    } catch (e) {
      setWatermark(prev);
      toast((e as Error).message, 'error');
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy('upload');
    try {
      setWatermark(await api.uploadWatermarkLogo(file));
      toast('Logo saved — every new clip gets it');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      setWatermark(await api.removeWatermarkLogo());
      toast('Logo removed');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  // drop an image anywhere on the logo area to (re)place it
  const drop = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      upload(e.dataTransfer.files?.[0]);
    },
  };

  const status = !w?.logoUrl ? (
    <Badge>Not set up</Badge>
  ) : w.enabled ? (
    <Badge tone="good">
      <span className="size-1.5 rounded-full bg-current" /> On
    </Badge>
  ) : (
    <Badge tone="warn">Paused</Badge>
  );
  const shownOpacity = opacity ?? w?.opacity ?? 85;
  const preview = w && opacity !== null ? { ...w, opacity } : w;
  const spot = POSITIONS.find((p) => p.value === w?.position)?.label;

  return (
    <Card className="p-5 sm:p-6">
      <CardHeader title="Watermark" description="Put your logo on every clip. Set it once here." actions={w && !w.locked && status} />
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />

      {w?.locked ? (
        <UpgradeCallout title="Your own logo is on Creator and Pro" cta="Upgrade">
          Clips on the Free plan carry a small CrestClip mark in the corner. Upgrade to remove it and put your logo there instead.
        </UpgradeCallout>
      ) : !w || !preview ? (
        <Skeleton className="h-96" />
      ) : (
        <div className="grid gap-8 md:grid-cols-[15rem_minmax(0,1fr)]">
          {/* the preview — also the position picker */}
          <div className="mx-auto flex w-full max-w-60 flex-col items-center gap-3">
            <WatermarkPhone watermark={preview} scene={scene} onPosition={(p) => save({ position: p }, w)} />
            <p className="text-center text-[13px] font-bold text-ink-2">
              <Pointer size={14} className="mr-1 inline -translate-y-px text-accent" />
              Tap a corner to move it · <span className="whitespace-nowrap text-ink">{spot}</span>
            </p>
            <Segmented label="Preview background" size="sm" value={scene} onChange={setScene} options={SCENES} />
            {w.position === 'bottom-right' && (
              <p className="rounded-2xl bg-warn-bg px-3 py-2 text-center text-xs font-semibold text-warn-ink">
                TikTok and Reels show like and share buttons on the right. They may cover it here — top corners are safest.
              </p>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-5">
            {/* the logo itself */}
            {w.logoUrl ? (
              <div {...drop} className={cn('flex items-center gap-4 rounded-[22px] bg-row p-3.5 shadow-flat transition-shadow', dragging && 'shadow-[0_0_0_3px_var(--tangerine)]')}>
                <span className={cn('grid size-20 shrink-0 place-items-center overflow-hidden rounded-2xl p-2 shadow-flat', checker)}>
                  <img src={w.logoUrl} alt="Your logo" className="max-h-full max-w-full object-contain" />
                </span>
                <span className="min-w-0 flex-1">
                  <b className="block truncate">{w.name || 'Your logo'}</b>
                  <span className="mt-0.5 block text-xs text-ink-3">{w.enabled ? 'Goes on every new clip' : 'Paused — new clips won’t get it'}</span>
                  <span className="mt-2.5 flex flex-wrap gap-2">
                    <Button size="sm" loading={busy === 'upload'} onClick={() => fileInput.current?.click()}>
                      {busy !== 'upload' && <RefreshCw size={14} />} Replace
                    </Button>
                    <Button size="sm" variant="ghost" loading={busy === 'remove'} onClick={remove}>
                      {busy !== 'remove' && <Trash2 size={14} />} Remove
                    </Button>
                  </span>
                </span>
              </div>
            ) : (
              <button
                type="button"
                {...drop}
                disabled={busy === 'upload'}
                onClick={() => fileInput.current?.click()}
                className={cn(
                  'flex flex-col items-center gap-3 rounded-[22px] border-2 border-dashed px-6 py-10 text-center transition-colors',
                  dragging ? 'border-tangerine bg-row' : 'border-line-strong hover:border-tangerine hover:bg-row',
                )}
              >
                <span className="grid size-14 place-items-center rounded-2xl text-white clay-tangerine">
                  <UploadCloud size={26} className={cn(busy === 'upload' && 'animate-bounce')} />
                </span>
                <span>
                  <b className="block font-display text-lg">{busy === 'upload' ? 'Saving your logo…' : 'Drop your logo here'}</b>
                  <span className="text-sm text-ink-3">or click to choose a file</span>
                </span>
                <span className="flex flex-wrap justify-center gap-1.5">
                  {['PNG', 'JPG', 'WebP', 'Up to 5 MB'].map((t) => (
                    <Badge key={t} className="text-ink-2">
                      {t}
                    </Badge>
                  ))}
                </span>
                <span className="text-xs text-ink-3">Tip: a PNG with a see-through background looks cleanest.</span>
              </button>
            )}

            {/* how it looks */}
            {w.logoUrl && (
              <div className="divide-y divide-line rounded-[22px] bg-row shadow-flat">
                <Row nowrap label="Add to every new clip" hint="Turn off to pause it without deleting your logo.">
                  <Toggle checked={w.enabled} onChange={(v) => save({ enabled: v }, w)}>
                    <span className="sr-only">Add to every new clip</span>
                  </Toggle>
                </Row>
                <div className={cn('divide-y divide-line transition-opacity', !w.enabled && 'pointer-events-none opacity-45')}>
                  <Row label="Size" hint="Small stays out of the way. Large is easy to spot.">
                    <Segmented label="Watermark size" size="sm" value={w.size} onChange={(v) => save({ size: v }, w)} options={SIZES} />
                  </Row>
                  <Row
                    stack
                    label={
                      <span className="flex items-center justify-between">
                        Visibility <span className="font-display text-ink-2 tabular-nums">{shownOpacity}%</span>
                      </span>
                    }
                  >
                    <div>
                      <input
                        type="range"
                        min={20}
                        max={100}
                        step={5}
                        value={shownOpacity}
                        aria-label="Watermark visibility"
                        className="w-full"
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setOpacity(v);
                          window.clearTimeout(saveTimer.current);
                          saveTimer.current = window.setTimeout(() => {
                            save({ opacity: v }, w).finally(() => setOpacity(null));
                          }, 400);
                        }}
                      />
                      <span className="mt-1 flex justify-between text-xs text-ink-3">
                        <span>See-through</span>
                        <span>Solid</span>
                      </span>
                    </div>
                  </Row>
                </div>
              </div>
            )}

            <p className="flex gap-2 text-[13px] text-ink-3">
              <Info size={15} className="mt-0.5 shrink-0" />
              <span>
                {w.logoUrl
                  ? 'Clips you already made keep their old look. To update one, open its ⋯ menu and pick “Render again”.'
                  : 'Once your logo is in, you can pick the corner, the size and how see-through it is.'}
              </span>
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
