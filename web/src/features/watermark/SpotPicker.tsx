import { cn } from '../../lib/cn';
import { spotName } from './logoAsk';

const ROWS = [0, 0.5, 1];
const near = (a: number, b: number) => Math.abs(a - b) < 0.02;

/** What Shorts / Reels / TikTok draw over that part of the clip (null = nothing there). */
export function coveredBy(x: number, y: number) {
  if (y >= 0.8) return 'Apps show your name and caption down here, so the logo may get covered.';
  if (x >= 0.8 && y >= 0.4) return 'Apps put the like and comment buttons on this side, so the logo may get covered.';
  return null;
}

/**
 * Nine quick spots on a small 9:16 frame — the same shape as the clip. The dot that's lit is where the logo sits;
 * a spot set by dragging (between dots) lights none, and the name underneath says "Custom spot".
 */
export function SpotPicker({ x, y, onPick, disabled }: { x: number; y: number; onPick: (x: number, y: number) => void; disabled?: boolean }) {
  const onDot = ROWS.some((r) => near(r, x)) && ROWS.some((r) => near(r, y));
  return (
    <div className="flex items-center gap-3">
      <fieldset disabled={disabled} className={cn('shrink-0', disabled && 'opacity-45')}>
        <div role="radiogroup" aria-label="Logo position" className="grid aspect-[9/16] w-16 grid-cols-3 grid-rows-3 place-items-center rounded-xl bg-sunken p-1 shadow-well">
          {ROWS.map((ry) =>
            ROWS.map((rx) => {
              const on = near(x, rx) && near(y, ry);
              const name = spotName(rx, ry);
              return (
                <button
                  key={`${rx}-${ry}`}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={name}
                  title={name}
                  onClick={() => onPick(rx, ry)}
                  className="grid size-full place-items-center rounded-md hover:bg-row-hover"
                >
                  <span className={cn('rounded-full transition-all', on ? 'size-3 bg-tangerine shadow-[0_0_0_3px_color-mix(in_oklab,var(--tangerine)_30%,transparent)]' : 'size-1.5 bg-ink-3')} />
                </button>
              );
            }),
          )}
        </div>
      </fieldset>
      <div className="min-w-0 text-xs text-ink-3">
        <b className="block text-sm text-ink">{onDot ? spotName(x, y) : 'Custom spot'}</b>
        <span className="mt-0.5 block leading-snug">{disabled ? 'Set by your instructions.' : 'Tap a dot, or drag the logo on the preview to put it anywhere.'}</span>
        {coveredBy(x, y) && <span className="mt-1.5 block rounded-lg bg-warn-bg px-2 py-1 leading-snug font-bold text-warn-ink">{coveredBy(x, y)}</span>}
      </div>
    </div>
  );
}
