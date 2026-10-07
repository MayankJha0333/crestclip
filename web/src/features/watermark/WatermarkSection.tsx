import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Move, RefreshCw, Star, Trash2, UploadCloud } from 'lucide-react';
import { api, type Watermark, type WatermarkPatch, type WatermarkSize } from '../../lib/api';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { Badge, Button, Card, CardHeader, Segmented, Skeleton, Toggle } from '../../components/ui';
import { setWatermark, useWatermark } from './useWatermark';
import { UpgradeCallout } from '../billing/UpgradeCallout';
import { WatermarkPhone } from './WatermarkPhone';
import { checker, spotOf } from './WatermarkMark';
import { SpotPicker } from './SpotPicker';

const SIZES: { value: WatermarkSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];
const SCENES = [
  { value: 'light' as const, label: 'Bright video' },
  { value: 'dark' as const, label: 'Dark video' },
];

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

/**
 * Settings → Logo: the person's main logo — uploaded once, put on every new clip in the spot, size and visibility set
 * here. A single project can use another logo (or none) from New clips without changing this.
 */
export function WatermarkSection() {
  const w = useWatermark();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scene, setScene] = useState<'light' | 'dark'>('light');
  const [covers, setCovers] = useState(false);
  const [opacity, setOpacity] = useState<number | null>(null); // the slider while it's moving
  const [spotDraft, setSpotDraft] = useState<{ x: number; y: number } | null>(null); // the logo while it's dragged
  const saveTimer = useRef<number>(undefined);
  const spotTimer = useRef<number>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(saveTimer.current);
      window.clearTimeout(spotTimer.current);
    },
    [],
  );

  const save = async (patch: WatermarkPatch, prev: Watermark) => {
    setWatermark({ ...prev, ...patch }); // show it right away
    try {
      setWatermark(await api.updateWatermark(patch));
    } catch (e) {
      setWatermark(prev);
      toast((e as Error).message, 'error');
    }
  };

  const makeDefault = async (id: string) => {
    try {
      setWatermark(await api.setDefaultLogo(id));
      toast('That’s your main logo now — every new clip gets it');
    } catch (e) {
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
    <Badge>{w?.logos.length ? 'No main logo yet' : 'Not set up'}</Badge>
  ) : w.enabled ? (
    <Badge tone="good">
      <span className="size-1.5 rounded-full bg-current" /> On
    </Badge>
  ) : (
    <Badge tone="warn">Paused</Badge>
  );
  const shownOpacity = opacity ?? w?.opacity ?? 85;
  const spot = spotDraft ?? (w ? spotOf(w) : { x: 1, y: 0 });
  const preview = w && { ...w, opacity: shownOpacity, x: spot.x, y: spot.y };
  const others = w?.logos.filter((l) => l.id !== w.defaultLogoId) ?? [];

  // dragging moves the preview right away; it's saved once the logo stops moving
  const moveTo = (x: number, y: number, at: 'drag' | 'tap') => {
    if (!w) return;
    setSpotDraft({ x, y });
    window.clearTimeout(spotTimer.current);
    spotTimer.current = window.setTimeout(() => save({ x, y }, w).finally(() => setSpotDraft(null)), at === 'drag' ? 400 : 0);
  };

  return (
    <Card className="p-5 sm:p-6">
      <CardHeader title="Logo" description="Upload your logo once and it goes on every new clip, in the spot you choose here." actions={w && !w.locked && status} />
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />

      {w?.locked ? (
        <UpgradeCallout title="Your own logo is on Creator and Pro" cta="Upgrade">
          Clips on the Free plan carry a small CrestClip mark in the corner. Upgrade to remove it and put your logo there instead.
        </UpgradeCallout>
      ) : !w || !preview ? (
        <Skeleton className="h-96" />
      ) : !w.logoUrl ? (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_17rem]">
          {others.length ? (
            <div className="rounded-[22px] bg-row p-4 shadow-flat">
              <b className="block">Pick your main logo</b>
              <span className="mt-0.5 block text-xs text-ink-3">You’ve added these while making clips. The one you pick goes on every new clip.</span>
              <div className="mt-3 flex flex-wrap gap-2">
                {others.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => makeDefault(l.id)}
                    title={`Make “${l.name || 'this logo'}” your main logo`}
                    className={cn('flex items-center gap-2 rounded-2xl p-2 pr-3 shadow-flat transition-transform hover:-translate-y-0.5', checker)}
                  >
                    {l.url && <img src={l.url} alt="" className="size-10 object-contain" />}
                    <span className="max-w-32 truncate text-xs font-bold">{l.name || 'Logo'}</span>
                  </button>
                ))}
              </div>
              <Button size="sm" className="mt-3" loading={busy === 'upload'} onClick={() => fileInput.current?.click()}>
                {busy !== 'upload' && <UploadCloud size={14} />} Upload a new one
              </Button>
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
          <HowItWorks />
        </div>
      ) : (
        <div className="grid gap-8 md:grid-cols-[15rem_minmax(0,1fr)]">
          {/* the preview: the clip exactly as it's exported — drag the logo to move it */}
          <div className="mx-auto flex w-full max-w-60 flex-col items-center gap-3">
            <WatermarkPhone watermark={preview} scene={scene} covers={covers} onMove={w.enabled ? (x, y) => moveTo(x, y, 'drag') : undefined} />
            <p className="flex items-center gap-1.5 text-center text-[13px] font-bold text-ink-2">
              <Move size={14} className="text-accent" /> Drag the logo to move it
            </p>
            <Segmented label="Preview background" size="sm" value={scene} onChange={setScene} options={SCENES} />
            <label className="flex w-full items-center justify-between gap-2 rounded-2xl bg-row px-3 py-2 shadow-flat">
              <span className="text-xs font-bold text-ink-2">Show what apps cover</span>
              <Toggle checked={covers} onChange={setCovers}>
                <span className="sr-only">Show what apps cover</span>
              </Toggle>
            </label>
          </div>

          <div className="flex min-w-0 flex-col gap-5">
            {/* the main logo itself */}
            <div {...drop} className={cn('flex items-center gap-4 rounded-[22px] bg-row p-3.5 shadow-flat transition-shadow', dragging && 'shadow-[0_0_0_3px_var(--tangerine)]')}>
              <span className={cn('relative grid size-20 shrink-0 place-items-center overflow-hidden rounded-2xl p-2 shadow-flat', checker)}>
                <img src={w.logoUrl} alt="Your main logo" className="max-h-full max-w-full object-contain" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-xs font-bold text-ink-3">
                  <Star size={12} className="text-tangerine" fill="currentColor" /> Main logo
                </span>
                <b className="block truncate">{w.name || 'Your logo'}</b>
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

            <div className="divide-y divide-line rounded-[22px] bg-row shadow-flat">
              <Row nowrap label="Put it on every new clip" hint={w.enabled ? 'On — new clips get this logo.' : 'Paused — new clips come out without a logo. Your logo stays saved.'}>
                <Toggle checked={w.enabled} onChange={(v) => save({ enabled: v }, w)}>
                  <span className="sr-only">Put it on every new clip</span>
                </Toggle>
              </Row>
              <div className={cn('divide-y divide-line transition-opacity', !w.enabled && 'pointer-events-none opacity-45')}>
                <Row stack label="Where it goes" hint="The clip is tall (9:16). The logo always keeps a small gap from the edges.">
                  <SpotPicker x={spot.x} y={spot.y} onPick={(x, y) => moveTo(x, y, 'tap')} />
                </Row>
                <Row label="Size" hint="Small stays out of the way. Large is easy to spot.">
                  <Segmented label="Logo size" size="sm" value={w.size} onChange={(v) => save({ size: v }, w)} options={SIZES} />
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
                      aria-label="Logo visibility"
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

            {others.length > 0 && (
              <div className="rounded-[22px] bg-row p-3.5 shadow-flat">
                <b className="block text-sm">Your other logos</b>
                <span className="block text-xs text-ink-3">Added while making clips. Tap one to make it your main logo.</span>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {others.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => makeDefault(l.id)}
                      title={`Make “${l.name || 'this logo'}” your main logo`}
                      className={cn('flex items-center gap-2 rounded-2xl p-1.5 pr-3 shadow-flat transition-transform hover:-translate-y-0.5', checker)}
                    >
                      {l.url && <img src={l.url} alt="" className="size-8 object-contain" />}
                      <span className="max-w-28 truncate text-xs font-bold">{l.name || 'Logo'}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <HowItWorks />
          </div>
        </div>
      )}
    </Card>
  );
}

/** The three things people ask about: what gets it, how to change it for one project, and clips already made. */
function HowItWorks() {
  const steps = [
    ['Every new clip', 'gets your main logo automatically, in the spot, size and visibility set here.'],
    ['One project different?', 'When you make clips, change the logo under “Logo”. It only changes that project — this page stays the same.'],
    ['Clips you already made', 'keep the logo they were made with. To update one, open its ⋯ menu and pick “Render again”.'],
  ];
  return (
    <div className="rounded-[22px] bg-sunken p-4 shadow-well">
      <b className="block text-sm">How it works</b>
      <ol className="mt-2 flex flex-col gap-2">
        {steps.map(([t, d], i) => (
          <li key={t} className="flex gap-2.5 text-[13px] leading-snug text-ink-2">
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface text-[11px] font-black text-ink shadow-flat">{i + 1}</span>
            <span>
              <b className="text-ink">{t}</b> {d}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
