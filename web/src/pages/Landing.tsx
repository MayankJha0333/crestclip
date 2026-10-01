import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  AudioLines,
  Captions,
  Check,
  Copy,
  Crop,
  Flame,
  Layers,
  Link2,
  MessageSquareText,
  Scissors,
  Sparkles,
  SplitSquareVertical,
  Target,
  Wand2,
} from 'lucide-react';
import { CaptionSample, Logo, ScoreRing } from '../components/bits';
import type { CaptionStyle } from '../lib/api';

/** A pretty, deterministic "Most replayed" curve for illustrations. */
function demoCurve(n = 80) {
  return Array.from({ length: n }, (_, i) => {
    const x = i / (n - 1);
    const v =
      0.18 +
      0.12 * Math.sin(x * 19) +
      0.75 * Math.exp(-((x - 0.62) ** 2) / 0.0018) +
      0.42 * Math.exp(-((x - 0.27) ** 2) / 0.0025) +
      0.3 * Math.exp(-((x - 0.86) ** 2) / 0.002);
    return Math.max(0.04, Math.min(1, v));
  });
}

function CurveSvg({ w = 420, h = 120, stroke = '#e0643a', fill = 'rgba(255,138,91,.32)', markers = true }: { w?: number; h?: number; stroke?: string; fill?: string; markers?: boolean }) {
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
      {markers && <rect x={peakX - 34} y={4} width={68} height={h - 8} rx={12} fill="rgba(111,224,191,.35)" />}
      {markers && <rect x={0.27 * w - 26} y={4} width={52} height={h - 8} rx={12} fill="rgba(43,33,64,.06)" />}
      <path d={`${d} L${w},${h} L0,${h} Z`} fill={fill} />
      <path d={d} fill="none" stroke={stroke} strokeWidth="3" strokeLinecap="round" />
      {markers && <circle cx={peakX} cy={pts[Math.round(0.62 * (c.length - 1))][1]} r="7" fill="#ffd65c" stroke="#2b2140" strokeWidth="3" />}
    </svg>
  );
}

function HeroPhone() {
  return (
    <div className="hero-art">
      <div className="blob tint-bubble float" style={{ width: 120, height: 120, top: -10, right: 30, animation: 'wobble 9s ease-in-out infinite, floaty 7s ease-in-out infinite' }} />
      <div className="blob tint-mint float" style={{ width: 70, height: 70, bottom: 40, left: -10, animationDelay: '-2s' }} />
      <div className="blob tint-butter float" style={{ width: 44, height: 44, top: 120, left: 40, animationDelay: '-4s' }} />

      <div className="phone clay float" style={{ ['--rot' as string]: '-3deg' }}>
        <div className="phone-screen">
          <div className="scene">
            <div className="scene-person">
              <span className="head" />
              <span className="body" />
              <span className="mic" />
            </div>
            <div className="scene-hook">Nobody tells you this 🤫</div>
            <div className="scene-cap">
              <CaptionSample style="pop" big />
            </div>
            <div className="scene-ui">
              <span />
              <span />
              <span />
            </div>
          </div>
        </div>
      </div>

      <div className="float-card clay-sm float" style={{ top: 30, left: -30, animationDelay: '-1s' }}>
        <ScoreRing value={91} size={54} />
        <div>
          <b>Peak score</b>
          <div className="faint" style={{ fontSize: 13 }}>AI 88 · rewatched 97%</div>
        </div>
      </div>

      <div className="float-card clay-sm heat-mini float" style={{ bottom: 20, right: -24, animationDelay: '-3s' }}>
        <div className="row" style={{ gap: 6, fontWeight: 800, fontSize: 13 }}>
          <Flame size={15} color="var(--tangerine-d)" /> Most replayed · 12:41
        </div>
        <div style={{ height: 64, marginTop: 6 }}>
          <CurveSvg w={220} h={64} />
        </div>
      </div>

      <div className="float-chip badge tint-sky float" style={{ top: 250, right: -34, animationDelay: '-5s' }}>
        <Crop size={14} /> Face tracked
      </div>
    </div>
  );
}

const FEATURES = [
  { icon: Flame, tint: 'tint-tangerine', title: '“Most replayed” detection', text: 'Reads the replay heatmap YouTube shows under popular videos, plus timestamps viewers leave in comments. We cut where people already rewatch.' },
  { icon: Sparkles, tint: 'tint-lilac', title: 'Gemini virality score', text: 'Every clip is scored on 9 things that drive views — hook, payoff, emotion, shareability, pacing and more. You see why, not just a number.' },
  { icon: Crop, tint: 'tint-sky', title: 'Auto-reframe to 9:16', text: 'Gemini finds the speaker in every shot and the crop cuts between people like a human editor — no wobbly auto-pan.' },
  { icon: SplitSquareVertical, tint: 'tint-mint', title: 'Split-screen for two', text: 'Podcast with two hosts? Both faces stacked top and bottom automatically.' },
  { icon: Captions, tint: 'tint-butter', title: 'Word-by-word captions', text: 'Five burned-in styles with the spoken word highlighted, placed inside the TikTok / Reels / Shorts safe zones.' },
  { icon: Target, tint: 'tint-bubble', title: 'Hook headline', text: 'A punchy on-screen line for the first 3 seconds — the moment that decides if people swipe.' },
  { icon: Scissors, tint: 'tint-tangerine', title: 'Clean cuts', text: 'Clips start on the first word of the hook and end right after the payoff. Never mid-word, never mid-thought.' },
  { icon: Layers, tint: 'tint-sky', title: 'One-click variants', text: 'Same moment, new look. Post variations for clipping campaigns without duplicate-content flags.' },
  { icon: Copy, tint: 'tint-mint', title: 'Post-ready text', text: 'Title, caption with a comment-bait question, and hashtags for every clip. Copy, paste, post.' },
];

const STEPS = [
  { n: 1, tint: 'tint-sky', title: 'Drop a video', text: 'Paste a YouTube, Twitch, Vimeo or X link — or upload a podcast, stream or webinar file.' },
  { n: 2, tint: 'tint-butter', title: 'We find the peaks', text: 'Replay data + comments + audio energy show where viewers lean in. Gemini listens and picks moments that stand alone.' },
  { n: 3, tint: 'tint-mint', title: 'Post the winners', text: 'Get vertical 1080×1920 clips with captions, hook and a score — ranked, editable and ready to download.' },
];

const PLANS = [
  { name: 'Starter', price: '$0', per: 'forever', tint: '', points: ['30 min of video / month', '720p exports with watermark', 'All caption styles', 'Peak score + reasons'], cta: 'Start free' },
  { name: 'Creator', price: '$15', per: '/ month', tint: 'tint-tangerine', points: ['300 min of video / month', '1080p, no watermark', '“Most replayed” + comment signals', 'Variants & split-screen'], cta: 'Go Creator', featured: true },
  { name: 'Clipper Pro', price: '$39', per: '/ month', tint: '', points: ['1,200 min of video / month', 'Priority rendering', 'Bulk download', 'Campaign-ready variants'], cta: 'Go Pro' },
];

const FAQ = [
  { q: 'How do you know which part is the most watched?', a: 'For YouTube videos with enough views, YouTube publishes a “Most replayed” graph — 100 points showing where viewers rewind and rewatch. PeakClip reads it, adds timestamps that viewers write in comments (“12:41 😂”), and mixes in audio energy (laughter, raised voices). New videos and uploads have no replay data, so PeakClip leans on Gemini and the audio signal instead — the chart tells you which one you are looking at.' },
  { q: 'Which AI does PeakClip use?', a: 'Only Google Gemini, running on Google Cloud Vertex AI. Transcription, moment-finding, scoring and face finding for reframing all go through Gemini, so usage is billed to your Google Cloud account and credits.' },
  { q: 'What does the Peak score mean?', a: 'It blends two things: the AI virality score (Gemini grading the clip on hook, payoff, emotion, shareability and more) and the audience score (how much more this moment is rewatched than the rest of the video). When there is no audience data, the AI score does most of the work.' },
  { q: 'Can I post clips of other people’s videos?', a: 'Only when you have the rights — your own content, a client’s, or an approved clipping campaign. Platforms also reward original edits over plain re-uploads, which is why every clip gets captions, reframing and a hook.' },
  { q: 'How long can the source video be?', a: 'Up to 4 hours by default. Longer streams work too; just raise MAX_SOURCE_MINUTES in the .env file.' },
];

export function Landing() {
  const nav = useNavigate();
  const [url, setUrl] = useState('');
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    nav(url.trim() ? `/app?url=${encodeURIComponent(url.trim())}` : '/app');
  };

  return (
    <div className="landing">
      <header className="lnav clay">
        <Link to="/" style={{ textDecoration: 'none' }}>
          <Logo size={36} />
        </Link>
        <nav className="lnav-links">
          <a href="#how">How it works</a>
          <a href="#engine">The peak engine</a>
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
        </nav>
        <Link to="/app" className="btn btn-ink btn-sm">
          Open app <ArrowRight size={16} />
        </Link>
      </header>

      {/* HERO */}
      <section className="hero">
        <div className="hero-copy pop-in">
          <span className="badge" style={{ marginBottom: 22 }}>
            <Flame size={14} color="var(--tangerine-d)" /> Reads YouTube’s “Most replayed” data
          </span>
          <h1 className="hero-title">
            Clip the moment <span className="squiggle">everyone</span> rewatches.
          </h1>
          <p className="hero-sub">
            Paste a long video. PeakClip finds the parts viewers already replay, has Gemini pick the ones that stand on their own, and hands you vertical clips with
            captions, a hook and a score.
          </p>
          <form className="hero-input clay" onSubmit={go}>
            <Link2 size={22} className="faint" style={{ marginLeft: 8, flex: 'none' }} />
            <input aria-label="Video link" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a YouTube or podcast link…" />
            <button className="btn btn-primary" type="submit">
              <Wand2 size={18} /> Find peaks
            </button>
          </form>
          <div className="row wrap" style={{ gap: 18, marginTop: 18 }}>
            {['No editing skills needed', 'Clips in minutes', 'You own every export'].map((t) => (
              <span key={t} className="row muted" style={{ gap: 6, fontWeight: 700, fontSize: 14 }}>
                <Check size={16} color="var(--mint-d)" /> {t}
              </span>
            ))}
          </div>
        </div>
        <HeroPhone />
      </section>

      <div className="source-strip">
        <span className="faint">Works with</span>
        {['YouTube', 'Podcasts', 'Twitch VODs', 'Zoom & webinars', 'Vimeo', 'Your uploads'].map((s) => (
          <span key={s} className="badge">
            {s}
          </span>
        ))}
      </div>

      {/* HOW */}
      <section id="how" className="lsection">
        <p className="eyebrow">How it works</p>
        <h2 className="lh2">Three steps. Zero timeline scrubbing.</h2>
        <div className="steps">
          {STEPS.map((s) => (
            <div key={s.n} className="step-card clay">
              <span className={`step-num ${s.tint}`}>{s.n}</span>
              <h3>{s.title}</h3>
              <p className="muted">{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ENGINE */}
      <section id="engine" className="lsection engine">
        <div className="engine-copy">
          <p className="eyebrow">The peak engine</p>
          <h2 className="lh2" style={{ textAlign: 'left' }}>
            Other tools guess what’s viral. <br />
            <span style={{ color: 'var(--tangerine-d)' }}>We start from what people rewatched.</span>
          </h2>
          <p className="muted" style={{ fontSize: 18, marginTop: 16 }}>
            Short-video feeds reward one thing above all: people who stop, watch to the end, rewatch and share. So PeakClip stacks real audience signals under
            Gemini’s judgment.
          </p>
          <div className="signal-list">
            <div className="signal clay-sm">
              <span className="tint-tangerine sig-ico"><Flame size={20} /></span>
              <div>
                <b>Most replayed graph</b>
                <p className="muted">100 points of replay intensity from YouTube itself.</p>
              </div>
            </div>
            <div className="signal clay-sm">
              <span className="tint-sky sig-ico"><MessageSquareText size={20} /></span>
              <div>
                <b>Timestamp comments</b>
                <p className="muted">“23:10 I’m dying 😂” — weighted by likes.</p>
              </div>
            </div>
            <div className="signal clay-sm">
              <span className="tint-mint sig-ico"><AudioLines size={20} /></span>
              <div>
                <b>Audio energy</b>
                <p className="muted">Laughter, raised voices and excitement spikes.</p>
              </div>
            </div>
            <div className="signal clay-sm">
              <span className="tint-lilac sig-ico"><Sparkles size={20} /></span>
              <div>
                <b>Gemini’s 9-point rubric</b>
                <p className="muted">Hook, stands alone, payoff, emotion, shareability…</p>
              </div>
            </div>
          </div>
        </div>
        <div className="engine-art clay">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b className="row" style={{ gap: 8, fontFamily: 'var(--font-display)', fontSize: 18 }}>
              <Flame size={18} color="var(--tangerine-d)" /> Where viewers rewatch
            </b>
            <span className="badge tint-mint">3 peaks found</span>
          </div>
          <div style={{ height: 180, marginTop: 14 }}>
            <CurveSvg w={560} h={180} />
          </div>
          <div className="engine-clips">
            {[
              { t: '12:03 – 12:48', title: '“We stopped selling and started teaching”', s: 91 },
              { t: '5:21 – 5:58', title: 'The ad campaign that burned $40K', s: 84 },
              { t: '17:40 – 18:12', title: 'Why the first 100 users are the hardest', s: 77 },
            ].map((c, i) => (
              <div key={c.t} className="engine-clip clay-sm">
                <span className="rank-badge tint-butter" style={{ position: 'static' }}>#{i + 1}</span>
                <div className="grow">
                  <b style={{ fontSize: 15 }}>{c.title}</b>
                  <div className="faint" style={{ fontSize: 13 }}>{c.t}</div>
                </div>
                <ScoreRing value={c.s} size={44} />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="lsection">
        <p className="eyebrow">Everything a clip needs</p>
        <h2 className="lh2">From long video to post-ready in one pass</h2>
        <div className="feat-grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="feat clay">
              <span className={`feat-ico ${f.tint}`}>
                <f.icon size={24} />
              </span>
              <h3>{f.title}</h3>
              <p className="muted">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CAPTIONS */}
      <section className="lsection">
        <p className="eyebrow">Caption styles</p>
        <h2 className="lh2">Captions people actually read</h2>
        <p className="lsub">Most people scroll with the sound off. Every clip gets word-by-word captions that follow the voice.</p>
        <div className="cap-show">
          {(['pop', 'clay', 'neon', 'comic', 'minimal'] as CaptionStyle[]).map((s, i) => (
            <div key={s} className="mini-phone clay" style={{ transform: `rotate(${[-4, 2, -1, 3, -2][i]}deg)` }}>
              <div className={`mini-screen g${i}`}>
                <CaptionSample style={s} />
              </div>
              <span className="mini-name">{s[0].toUpperCase() + s.slice(1)}</span>
            </div>
          ))}
        </div>
      </section>

      {/* PRICING */}
      <section id="pricing" className="lsection">
        <p className="eyebrow">Pricing</p>
        <h2 className="lh2">Simple plans that grow with your channel</h2>
        <div className="plans">
          {PLANS.map((p) => (
            <div key={p.name} className={`plan clay ${p.featured ? 'featured' : ''}`}>
              {p.featured && <span className="badge tint-butter plan-flag">Most popular</span>}
              <h3>{p.name}</h3>
              <div className="plan-price">
                <b>{p.price}</b> <span className="faint">{p.per}</span>
              </div>
              <ul>
                {p.points.map((pt) => (
                  <li key={pt}>
                    <Check size={16} color="var(--mint-d)" /> {pt}
                  </li>
                ))}
              </ul>
              <Link to="/app" className={`btn ${p.featured ? 'btn-primary' : ''}`} style={{ width: '100%' }}>
                {p.cta}
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="lsection" style={{ maxWidth: 860 }}>
        <p className="eyebrow">FAQ</p>
        <h2 className="lh2">Good questions</h2>
        <div className="stack" style={{ gap: 14, marginTop: 30 }}>
          {FAQ.map((f) => (
            <details key={f.q} className="faq clay-sm">
              <summary>{f.q}</summary>
              <p className="muted">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="cta-band tint-tangerine">
        <div>
          <h2>Your next viral clip is already in your last video.</h2>
          <p>Let PeakClip find it.</p>
        </div>
        <Link to="/app" className="btn btn-ink btn-lg">
          Find my peaks <ArrowRight size={20} />
        </Link>
      </section>

      <footer className="lfooter">
        <Logo size={30} />
        <span className="faint">Made for creators and clippers · AI by Gemini on Google Cloud</span>
      </footer>
    </div>
  );
}
