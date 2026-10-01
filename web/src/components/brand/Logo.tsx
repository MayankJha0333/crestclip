/** The CrestClip mark: a wave cresting — the moment everyone rewatches. */
export function Logo({ size = 40, withText = true }: { size?: number; withText?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="grid shrink-0 place-items-center clay-tangerine" style={{ width: size, height: size, borderRadius: size * 0.34 }} aria-hidden>
        <svg width={size * 0.64} height={size * 0.64} viewBox="0 0 40 40">
          <path
            d="M3.5 29 C9.5 29 12 21.5 16 16.5 C20 11.5 26.5 7.5 31.8 10 C35.8 11.9 36 17.4 32.2 18.6 C29.4 19.5 27.4 17 28.9 15"
            fill="none"
            stroke="#fff"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M5 36 C9 33.5 13 33.5 17 36 C21 38.5 25 38.5 29 36 C31.5 34.5 33.5 34 35.5 34.6" fill="none" stroke="#fff" strokeOpacity=".6" strokeWidth="3" strokeLinecap="round" />
          <circle cx="34.6" cy="5" r="3.4" fill="#FFD65C" />
        </svg>
      </span>
      {withText && (
        <span className="font-display font-bold tracking-tight text-ink" style={{ fontSize: size * 0.6 }}>
          Crest<span className="text-accent">Clip</span>
        </span>
      )}
    </span>
  );
}
