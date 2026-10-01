import { Captions, Copy, Crop, Flame, Layers, Scissors, Sparkles, SplitSquareVertical, Target, type LucideIcon } from 'lucide-react';

type Tint = 'clay-tangerine' | 'clay-lilac' | 'clay-sky' | 'clay-mint' | 'clay-butter' | 'clay-bubble';

export const FEATURES: { icon: LucideIcon; tint: Tint; title: string; text: string }[] = [
  {
    icon: Flame,
    tint: 'clay-tangerine',
    title: '“Most replayed” detection',
    text: 'Reads the replay graph YouTube shows under popular videos, plus timestamps viewers leave in comments. We cut where people already rewatch.',
  },
  {
    icon: Sparkles,
    tint: 'clay-lilac',
    title: 'Gemini virality score',
    text: 'Every clip is scored on 9 things that drive views — hook, payoff, emotion, shareability, pacing and more. You see why, not just a number.',
  },
  { icon: Crop, tint: 'clay-sky', title: 'Auto-reframe to 9:16', text: 'Gemini finds the speaker in every shot and the crop cuts between people like a human editor — no wobbly auto-pan.' },
  { icon: SplitSquareVertical, tint: 'clay-mint', title: 'Split-screen for two', text: 'Podcast with two hosts? Both faces stacked top and bottom automatically.' },
  { icon: Captions, tint: 'clay-butter', title: 'Word-by-word captions', text: 'Five burned-in styles with the spoken word highlighted, placed inside the TikTok / Reels / Shorts safe zones.' },
  { icon: Target, tint: 'clay-bubble', title: 'Hook headline', text: 'A punchy on-screen line for the first 3 seconds — the moment that decides if people swipe.' },
  { icon: Scissors, tint: 'clay-tangerine', title: 'Clean cuts', text: 'Clips start on the first word of the hook and end right after the payoff. Never mid-word, never mid-thought.' },
  { icon: Layers, tint: 'clay-sky', title: 'One-click variants', text: 'Same moment, new look. Post variations for clipping campaigns without duplicate-content flags.' },
  { icon: Copy, tint: 'clay-mint', title: 'Post-ready text', text: 'Title, caption and hashtags for every clip — or post straight to YouTube and Instagram.' },
];

export const STEPS: { tint: Tint; title: string; text: string }[] = [
  { tint: 'clay-sky', title: 'Drop a video', text: 'Paste a YouTube, Twitch, Vimeo or Drive link — or upload a podcast, stream or webinar file.' },
  { tint: 'clay-butter', title: 'We find the peaks', text: 'Replay data, comments and audio energy show where viewers lean in. Gemini picks moments that stand on their own.' },
  { tint: 'clay-mint', title: 'Post the winners', text: 'Get vertical 1080×1920 clips with captions, a hook and a score — ranked, editable, and ready to post or schedule.' },
];

export const PLANS = [
  { name: 'Starter', price: '$0', per: 'forever', points: ['30 min of video / month', '720p exports with watermark', 'All caption styles', 'Crest score + reasons'], cta: 'Start free' },
  {
    name: 'Creator',
    price: '$15',
    per: '/ month',
    points: ['300 min of video / month', '1080p, no watermark', '“Most replayed” + comment signals', 'Variants & split-screen'],
    cta: 'Go Creator',
    featured: true,
  },
  { name: 'Clipper Pro', price: '$39', per: '/ month', points: ['1,200 min of video / month', 'Priority rendering', 'Autopilot posting', 'Campaign-ready variants'], cta: 'Go Pro' },
];

export const FAQ = [
  {
    q: 'How do you know which part is the most watched?',
    a: 'For YouTube videos with enough views, YouTube publishes a “Most replayed” graph — 100 points showing where viewers rewind and rewatch. CrestClip reads it, adds timestamps viewers write in comments (“12:41 😂”), and mixes in audio energy (laughter, raised voices). New videos and uploads have no replay data, so CrestClip leans on Gemini and the audio instead — the chart tells you which one you’re looking at.',
  },
  {
    q: 'Which AI does CrestClip use?',
    a: 'Google Gemini on Google Cloud Vertex AI. Transcription, moment-finding, scoring and face finding all go through Gemini, so usage is billed to your Google Cloud account and credits.',
  },
  {
    q: 'What does the Crest score mean?',
    a: 'It blends the AI virality score (Gemini grading hook, payoff, emotion, shareability and more) with the audience score (how much more this moment is rewatched than the rest of the video). With no audience data, the AI score does most of the work.',
  },
  {
    q: 'Can I post clips of other people’s videos?',
    a: 'Only when you have the rights — your own content, a client’s, or an approved clipping campaign. Platforms also reward original edits over plain re-uploads, which is why every clip gets captions, reframing and a hook.',
  },
  { q: 'How long can the source video be?', a: 'Up to 4 hours by default. Longer streams work too; raise MAX_SOURCE_MINUTES in the .env file.' },
];

export const SAMPLE_CLIPS = [
  { t: '12:03 – 12:48', title: '“We stopped selling and started teaching”', s: 91 },
  { t: '5:21 – 5:58', title: 'The ad campaign that burned $40K', s: 84 },
  { t: '17:40 – 18:12', title: 'Why the first 100 users are the hardest', s: 77 },
];
