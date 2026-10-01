/** Round score dial (0–100). Colour shows how strong the clip is. */
export function ScoreRing({ value, size = 56, label = 'Crest score' }: { value: number; size?: number; label?: string }) {
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  const color = v >= 80 ? 'var(--mint-d)' : v >= 65 ? 'var(--tangerine)' : v >= 50 ? 'var(--butter-d)' : 'var(--ink-3)';
  return (
    <div className="relative grid shrink-0 place-items-center rounded-full bg-row shadow-flat" style={{ width: size, height: size }} title={`${label}: ${Math.round(v)}`}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth="5" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} />
      </svg>
      <span className="font-display font-bold leading-none" style={{ fontSize: size * 0.32 }}>
        {Math.round(v)}
      </span>
      <span className="sr-only">{label}</span>
    </div>
  );
}
