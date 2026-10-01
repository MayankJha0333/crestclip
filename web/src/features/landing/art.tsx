import { useMemo } from 'react';
import { Crop, Flame } from 'lucide-react';
import { ScoreRing } from '../../components/brand/ScoreRing';
import { CaptionSample } from '../clip-settings/CaptionPicker';

/** A pretty, deterministic "Most replayed" curve for illustrations. */
function demoCurve(n = 80) {
  return Array.from({ length: n }, (_, i) => {
    const x = i / (n - 1);
    const v = 0.18 + 0.12 * Math.sin(x * 19) + 0.75 * Math.exp(-((x - 0.62) ** 2) / 0.0018) + 0.42 * Math.exp(-((x - 0.27) ** 2) / 0.0025) + 0.3 * Math.exp(-((x - 0.86) ** 2) / 0.002);
    return Math.max(0.04, Math.min(1, v));
  });
}

export function CurveSvg({ w = 420, h = 120 }: { w?: number; h?: number }) {
  const c = useMemo(() => demoCurve(), []);
  const pts = c.map((v, i) => [(i / (c.length - 1)) * w, h - 8 - v * (h - 20)] as const);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const mx = (pts[i - 1][0] + pts[i][0]) / 2;
    d += ` C${mx},${pts[i - 1][1]} ${mx},${pts[i][1]} ${pts[i][0]},${pts[i][1]}`;
  }
  const peakX = 0.62 * w;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="100%" aria-hidden preserveAspectRatio="none">
      <rect x={peakX - 34} y={4} width={68} height={h - 8} rx={12} fill="rgba(111,224,191,.35)" />
      <rect x={0.27 * w - 26} y={4} width={52} height={h - 8} rx={12} fill="var(--muted-bg)" />
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="rgba(255,138,91,.32)" />
      <path d={d} fill="none" stroke="#e0643a" strokeWidth="3" strokeLinecap="round" />
      <circle cx={peakX} cy={pts[Math.round(0.62 * (c.length - 1))][1]} r="7" fill="#ffd65c" stroke="#2b2140" strokeWidth="3" />
    </svg>
  );
}

/** Hero illustration: a clay phone playing a clip, with floating score + replay cards. */
export function HeroArt() {
  return (
    <div className="relative grid h-[540px] scale-90 place-items-center sm:h-[600px] sm:scale-100">
      <div className="absolute top-0 right-8 size-30 animate-[wobble_9s_ease-in-out_infinite,floaty_7s_ease-in-out_infinite] clay-bubble" aria-hidden />
      <div className="absolute bottom-10 -left-2 size-18 animate-float rounded-full clay-mint [animation-delay:-2s]" aria-hidden />
      <div className="absolute top-30 left-10 size-11 animate-float rounded-full clay-butter [animation-delay:-4s]" aria-hidden />

      <div className="relative z-[2] h-[560px] w-[300px] animate-float rounded-[48px] bg-surface p-3 shadow-clay [--rot:-3deg]">
        <div className="relative size-full overflow-hidden rounded-[38px] bg-[radial-gradient(circle_at_70%_18%,#ffd1b8_0_18%,transparent_19%),linear-gradient(170deg,#ffb48f_0%,#ff8fb8_48%,#9c86ff_100%)]">
          {/* a clay podcaster */}
          <div className="absolute bottom-0 left-1/2 h-[330px] w-[220px] -translate-x-1/2" aria-hidden>
            <span className="absolute top-10 left-1/2 h-30 w-27 -translate-x-1/2 rounded-[50%_50%_46%_46%] bg-[#ffcfa8] shadow-[inset_-10px_-12px_18px_#e7a57a,inset_8px_8px_14px_rgba(255,255,255,.5)] before:absolute before:-top-3 before:-right-1 before:-left-1 before:h-15 before:rounded-[60px_60px_20px_20px] before:bg-[#3b2a4f] before:shadow-[inset_-6px_-6px_10px_#24182f] before:content-['']" />
            <span className="absolute bottom-0 left-1/2 h-40 w-[220px] -translate-x-1/2 rounded-t-[110px] bg-mint shadow-[inset_-12px_-12px_20px_var(--mint-d),inset_10px_10px_18px_rgba(255,255,255,.45)]" />
            <span className="absolute right-4.5 bottom-22 h-20 w-8.5 -rotate-[18deg] rounded-[18px] bg-[#2b2140] shadow-[inset_-4px_-4px_8px_#140e20,inset_3px_3px_6px_rgba(255,255,255,.2)]" />
          </div>
          <div className="absolute top-14 left-1/2 -translate-x-1/2 -rotate-2 rounded-[10px] bg-white px-3 py-1.5 font-[Poppins] text-[15px] font-extrabold whitespace-nowrap text-[#1e1b2b] shadow-lift">
            Nobody tells you this 🤫
          </div>
          <div className="absolute inset-x-0 top-[60%] grid place-items-center px-4 text-center">
            <CaptionSample style="pop" scale={1.35} />
          </div>
          <div className="absolute right-3 bottom-9 flex flex-col gap-3" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-8.5 rounded-full bg-white/55 shadow-[inset_-3px_-3px_6px_rgba(0,0,0,.1)]" />
            ))}
          </div>
        </div>
      </div>

      <div className="absolute top-8 -left-2 z-[3] flex animate-float items-center gap-3 rounded-[22px] bg-surface px-4 py-3 shadow-float [animation-delay:-1s] sm:-left-8">
        <ScoreRing value={91} size={54} />
        <div>
          <b>Crest score</b>
          <div className="text-[13px] text-ink-3">AI 88 · rewatched 97%</div>
        </div>
      </div>
      <div className="absolute right-0 bottom-5 z-[3] w-56 animate-float rounded-[22px] bg-surface px-4 py-3 shadow-float [animation-delay:-3s] sm:-right-6 sm:w-62">
        <div className="flex items-center gap-1.5 text-[13px] font-extrabold">
          <Flame size={15} className="text-accent" /> Most replayed · 12:41
        </div>
        <div className="mt-1.5 h-16">
          <CurveSvg w={220} h={64} />
        </div>
      </div>
      <div className="absolute top-64 right-0 z-[3] inline-flex animate-float items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-extrabold text-[#103552] clay-sky [animation-delay:-5s] sm:-right-8">
        <Crop size={14} /> Face tracked
      </div>
    </div>
  );
}
