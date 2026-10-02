import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, AudioLines, Check, Flame, Link2, MessageSquareText, Plus, Sparkles, Wand2 } from 'lucide-react';
import { api, type CaptionStyle, type PlansInfo } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Badge, Button, buttonClass } from '../../components/ui';
import { Logo } from '../../components/brand/Logo';
import { ScoreRing } from '../../components/brand/ScoreRing';
import { CaptionSample } from '../clip-settings/CaptionPicker';
import { CurveSvg, HeroArt } from './art';
import { FAQ, FEATURES, SAMPLE_CLIPS, STEPS } from './content';
import { useAuth } from '../auth/auth';
import { money } from '../billing/money';
import { PlanCards } from '../billing/PlanCards';
import { SiteFooter } from '../../components/SiteFooter';

function SectionTitle({ eyebrow, title, sub, left }: { eyebrow: string; title: React.ReactNode; sub?: string; left?: boolean }) {
  return (
    <div className={left ? 'text-left' : 'text-center'}>
      <p className="mb-3 text-[13px] font-black tracking-[.12em] text-accent uppercase">{eyebrow}</p>
      <h2 className="text-[clamp(32px,4.2vw,52px)] font-bold tracking-tight">{title}</h2>
      {sub && <p className="mx-auto mt-4 max-w-2xl text-lg text-ink-2">{sub}</p>}
    </div>
  );
}

const SIGNALS = [
  { Icon: Flame, tint: 'clay-tangerine', t: 'Most replayed graph', d: '100 points of replay intensity from YouTube itself.' },
  { Icon: MessageSquareText, tint: 'clay-sky', t: 'Timestamp comments', d: '“23:10 I’m dying 😂” — weighted by likes.' },
  { Icon: AudioLines, tint: 'clay-mint', t: 'Audio energy', d: 'Laughter, raised voices and excitement spikes.' },
  { Icon: Sparkles, tint: 'clay-lilac', t: 'Gemini’s 9-point rubric', d: 'Hook, stands alone, payoff, emotion, shareability…' },
];

export function LandingPage() {
  const nav = useNavigate();
  const { me } = useAuth();
  const [url, setUrl] = useState('');
  const [pricing, setPricing] = useState<PlansInfo | null>(null);
  useEffect(() => {
    api
      .plans()
      .then(setPricing)
      .catch(() => {});
  }, []);
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    nav(url.trim() ? `/app?url=${encodeURIComponent(url.trim())}` : '/app');
  };

  return (
    <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-8 sm:px-6 sm:pt-5">
      <header className="sticky top-3 z-20 flex items-center justify-between gap-4 rounded-full bg-surface py-3 pr-3.5 pl-4 shadow-clay sm:top-4 sm:pl-5">
        <Link to="/" className="no-underline">
          <Logo size={34} />
        </Link>
        <nav className="hidden gap-1 lg:flex">
          {[
            ['#how', 'How it works'],
            ['#engine', 'The peak engine'],
            ['#features', 'Features'],
            ['#pricing', 'Pricing'],
            ['#faq', 'FAQ'],
          ].map(([h, t]) => (
            <a key={h} href={h} className="rounded-full px-3.5 py-2 font-extrabold text-ink-2 no-underline transition-colors hover:bg-row hover:text-ink">
              {t}
            </a>
          ))}
        </nav>
        {me ? (
          <Link to="/app" className={buttonClass('ink', 'sm')}>
            Open app <ArrowRight size={16} />
          </Link>
        ) : (
          <span className="flex items-center gap-1">
            <Link to="/login" className="hidden rounded-full px-3.5 py-2 font-extrabold text-ink-2 no-underline hover:bg-row hover:text-ink sm:block">
              Log in
            </Link>
            <Link to="/signup" className={buttonClass('ink', 'sm')}>
              Start free <ArrowRight size={16} />
            </Link>
          </span>
        )}
      </header>

      {/* hero */}
      <section className="grid items-center gap-10 pt-10 pb-10 lg:grid-cols-[1.05fr_.95fr] lg:pt-18">
        <div className="animate-pop-in">
          <Badge className="mb-5">
            <Flame size={14} className="text-accent" /> Reads YouTube’s “Most replayed” data
          </Badge>
          <h1 className="text-[clamp(46px,6.4vw,86px)] leading-[.98] font-bold tracking-[-.03em]">
            Clip the moment{' '}
            <span className="relative whitespace-nowrap text-accent">
              everyone
              <span aria-hidden className="absolute -inset-x-[2%] -bottom-[.08em] -z-10 h-[.28em] -rotate-[1.5deg] rounded-full clay-butter" />
            </span>{' '}
            rewatches.
          </h1>
          <p className="mt-6 max-w-xl text-xl text-ink-2">
            Paste a long video. CrestClip finds the parts viewers already replay, has Gemini pick the ones that stand on their own, and hands you vertical clips with captions, a hook and a score.
          </p>
          <form onSubmit={go} className="mt-8 flex max-w-xl flex-wrap items-center gap-2.5 rounded-[28px] bg-surface p-2 shadow-clay sm:flex-nowrap sm:rounded-full">
            <Link2 size={22} className="ml-2 shrink-0 text-ink-3" />
            <input
              aria-label="Video link"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste a YouTube or podcast link…"
              className="min-w-0 flex-1 basis-[calc(100%-50px)] bg-transparent px-1 py-3 text-[17px] font-semibold text-ink outline-none placeholder:text-ink-3 sm:basis-auto"
            />
            <Button type="submit" variant="primary" className="w-full sm:w-auto">
              <Wand2 size={18} /> Find the peaks
            </Button>
          </form>
          <div className="mt-5 flex flex-wrap gap-4.5">
            {['No editing skills needed', 'Clips in minutes', 'You own every export'].map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5 text-sm font-bold text-ink-2">
                <Check size={16} className="text-mint-d" /> {t}
              </span>
            ))}
          </div>
        </div>
        <HeroArt />
      </section>

      <div className="flex flex-wrap items-center justify-center gap-2.5 pt-2.5 pb-5 font-extrabold">
        <span className="text-ink-3">Works with</span>
        {['YouTube', 'Podcasts', 'Twitch VODs', 'Google Drive', 'Zoom & webinars', 'Your uploads'].map((s) => (
          <Badge key={s}>{s}</Badge>
        ))}
      </div>

      {/* how */}
      <section id="how" className="mx-auto max-w-[1180px] pt-20">
        <SectionTitle eyebrow="How it works" title="Three steps. Zero timeline scrubbing." />
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.title} className="rounded-[28px] bg-surface p-7 shadow-clay">
              <span className={cn('grid size-16 animate-[wobble_10s_ease-in-out_infinite] place-items-center font-display text-3xl font-bold text-[#2b2140]', s.tint)}>{i + 1}</span>
              <h3 className="mt-4.5 mb-2 text-2xl">{s.title}</h3>
              <p className="text-ink-2">{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* engine */}
      <section id="engine" className="mx-auto grid max-w-[1180px] items-center gap-12 pt-24 lg:grid-cols-[1fr_1.05fr]">
        <div>
          <SectionTitle
            left
            eyebrow="The peak engine"
            title={
              <>
                Other tools guess what’s viral. <br />
                <span className="text-accent">We start from what people rewatched.</span>
              </>
            }
          />
          <p className="mt-4 text-lg text-ink-2">
            Short-video feeds reward one thing above all: people who stop, watch to the end, rewatch and share. So CrestClip stacks real audience signals under Gemini’s judgment.
          </p>
          <div className="mt-7 grid gap-3.5 sm:grid-cols-2">
            {SIGNALS.map(({ Icon, tint, t, d }) => (
              <div key={t} className="flex items-start gap-3 rounded-[22px] bg-surface p-3.5 shadow-clay-sm">
                <span className={cn('grid size-10.5 shrink-0 place-items-center rounded-2xl text-[#2b2140]', tint)}>
                  <Icon size={20} />
                </span>
                <div>
                  <b>{t}</b>
                  <p className="text-sm text-ink-2">{d}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="rotate-1 rounded-[28px] bg-surface p-6 shadow-clay">
          <div className="flex items-center justify-between">
            <b className="flex items-center gap-2 font-display text-lg">
              <Flame size={18} className="text-accent" /> Where viewers rewatch
            </b>
            <Badge tone="mint">3 peaks found</Badge>
          </div>
          <div className="mt-3.5 h-44">
            <CurveSvg w={560} h={180} />
          </div>
          <div className="mt-4.5 flex flex-col gap-3">
            {SAMPLE_CLIPS.map((c, i) => (
              <div key={c.t} className="flex items-center gap-3.5 rounded-2xl bg-row px-3.5 py-3 shadow-flat">
                <Badge tone="butter">#{i + 1}</Badge>
                <div className="min-w-0 flex-1">
                  <b className="text-[15px]">{c.title}</b>
                  <div className="text-[13px] text-ink-3">{c.t}</div>
                </div>
                <ScoreRing value={c.s} size={44} />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* features */}
      <section id="features" className="mx-auto max-w-[1180px] pt-24">
        <SectionTitle eyebrow="Everything a clip needs" title="From long video to post-ready in one pass" />
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-[28px] bg-surface p-7 shadow-clay transition-transform duration-300 ease-(--ease-squish) hover:-translate-y-1.5 hover:-rotate-[.6deg]">
              <span className={cn('grid size-14 place-items-center rounded-[20px] text-[#2b2140]', f.tint)}>
                <f.icon size={24} />
              </span>
              <h3 className="mt-4.5 mb-2 text-[21px]">{f.title}</h3>
              <p className="text-ink-2">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* captions */}
      <section className="mx-auto max-w-[1180px] pt-24">
        <SectionTitle eyebrow="Caption styles" title="Captions people actually read" sub="Most people scroll with the sound off. Every clip gets word-by-word captions that follow the voice." />
        <div className="mt-12 flex flex-wrap justify-center gap-5.5">
          {(['pop', 'clay', 'neon', 'comic', 'minimal'] as CaptionStyle[]).map((s, i) => (
            <div
              key={s}
              className="w-[150px] rounded-[30px] bg-surface p-2 shadow-clay transition-transform duration-300 ease-(--ease-squish) hover:!-translate-y-2 hover:!rotate-0 sm:w-[170px]"
              style={{ transform: `rotate(${[-4, 2, -1, 3, -2][i]}deg)` }}
            >
              <div
                className={cn(
                  'grid aspect-[9/16] place-items-center rounded-3xl p-2.5 text-center',
                  [
                    'bg-[linear-gradient(160deg,#5a4b7a,#2b2140)]',
                    'bg-[linear-gradient(160deg,#ffb48f,#ff84b8)]',
                    'bg-[linear-gradient(160deg,#1d1638,#3a2a6b)]',
                    'bg-[linear-gradient(160deg,#86c9ff,#6fe0bf)]',
                    'bg-[linear-gradient(160deg,#7a6a60,#3c2f2a)]',
                  ][i],
                )}
              >
                <CaptionSample style={s} />
              </div>
              <span className="mt-2.5 mb-1 block text-center font-display font-semibold capitalize">{s}</span>
            </div>
          ))}
        </div>
      </section>

      {/* pricing */}
      <section id="pricing" className="mx-auto max-w-[1180px] pt-24">
        <SectionTitle
          eyebrow="Pricing"
          title="Simple plans that grow with your channel"
          sub={`Prices in US dollars. Every clip costs ${pricing?.creditsPerClip ?? 5} credits; edits and re-renders are free, and clips that don’t come out give their credits back.`}
        />
        <div className="mt-12">
          {pricing ? (
            <PlanCards
              plans={pricing.plans}
              action={(p) => (
                <Link to={p.id === 'free' ? '/signup' : '/signup?next=%2Fapp%2Fbilling'} className={buttonClass(p.id === 'creator' ? 'primary' : 'secondary', 'md', 'w-full')}>
                  {p.id === 'free' ? 'Start free' : `Start with ${p.name}`}
                </Link>
              )}
            />
          ) : (
            <div className="h-96" />
          )}
          {pricing && (
            <p className="mt-6 text-center text-ink-3">
              Need more in a busy month? Add {pricing.topup.credits} credits ({Math.floor(pricing.topup.credits / pricing.creditsPerClip)} clips) for {money(pricing.topup.price)} — on any plan.
            </p>
          )}
        </div>
      </section>

      {/* faq */}
      <section id="faq" className="mx-auto max-w-[860px] pt-24">
        <SectionTitle eyebrow="FAQ" title="Good questions" />
        <div className="mt-8 flex flex-col gap-3.5">
          {FAQ.map((f) => (
            <details key={f.q} className="group rounded-[22px] bg-surface px-5.5 py-4.5 shadow-clay-sm">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-display text-lg font-semibold [&::-webkit-details-marker]:hidden">
                {f.q}
                <Plus size={22} className="shrink-0 text-accent transition-transform duration-300 group-open:rotate-45" />
              </summary>
              <p className="mt-3 text-ink-2">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="mx-auto mt-24 mb-10 flex max-w-[1180px] flex-wrap items-center justify-between gap-7 rounded-[44px] p-8 text-[#2b1407] clay-tangerine sm:p-12">
        <div>
          <h2 className="max-w-2xl text-[clamp(28px,3.4vw,42px)]">Your next viral clip is already in your last video.</h2>
          <p className="mt-2 text-lg font-bold">Let CrestClip find it.</p>
        </div>
        <Link to="/app" className={buttonClass('ink', 'lg')}>
          Find my peaks <ArrowRight size={20} />
        </Link>
      </section>

      <SiteFooter />
    </div>
  );
}
