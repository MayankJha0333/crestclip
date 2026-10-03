import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { config } from '../../config.js';
import { CREDITS_PER_CLIP, PLAN_ORDER, PLANS } from '../billing/plans.js';

/**
 * What Google sees. The site is a React app (an empty page until JavaScript runs), so for every public address the
 * server fills in the page title, description, share-preview tags and a plain-HTML copy of the main text before
 * sending it. React replaces that text as soon as it starts, so people never see it — search engines and link
 * previews do. Signed-in pages (/app, /receipt) are marked "noindex" so they never show up in search.
 */

const NAME = 'CrestClip';
const OLD_NAME = 'PeakClip';
const TAGLINE = 'clip the moment everyone rewatches';

interface Page {
  title: string;
  description: string;
  /** plain HTML shown to search engines inside the app's root element */
  body: string;
  /** "monthly" etc. for the sitemap */
  changefreq: string;
  priority: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const list = (items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const nav = () =>
  `<nav><a href="/">Home</a> · <a href="/pricing">Pricing</a> · <a href="/crayo-alternative">CrestClip vs Crayo</a> · <a href="/about">About</a> · <a href="/contact">Contact</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/refunds">Refunds</a> · <a href="/signup">Start free</a></nav>`;

const money = (n: number) => (n === 0 ? 'Free' : `$${n}/month`);
const planLines = () => PLAN_ORDER.map((id) => PLANS[id]).map((p) => `<strong>${p.name}</strong> — ${money(p.price)}: ${Math.floor(p.credits / CREDITS_PER_CLIP)} clips a month. ${esc(p.tagline)}`);

const FEATURES = [
  '<strong>“Most replayed” detection</strong> — reads the replay graph YouTube shows under popular videos and the timestamps viewers leave in comments.',
  '<strong>AI virality score</strong> — Google Gemini scores every clip on hook, payoff, emotion, shareability and pacing, and explains why.',
  '<strong>Auto-reframe to 9:16</strong> — finds the speaker in every shot; two-person podcasts get a split screen.',
  '<strong>Word-by-word animated captions</strong> — five caption styles placed inside the TikTok, Reels and Shorts safe zones.',
  '<strong>AI hook headline</strong>, background music and smooth motion for every clip.',
  '<strong>Explore</strong> — search YouTube and Twitch for long videos worth clipping and preview where viewers rewatch.',
  '<strong>Autopilot</strong> — watches channels or a topic, clips new videos and posts to YouTube and Instagram on your schedule.',
  '<strong>Post or schedule</strong> straight to YouTube Shorts and Instagram Reels, with title, caption and hashtags written for you.',
];

function pages(): Record<string, Page> {
  return {
    '/': {
      title: `${NAME} — AI clip maker: ${TAGLINE}`,
      description: `${NAME} (formerly ${OLD_NAME}) is an AI video clipping tool. Paste a long YouTube video, podcast or stream and get vertical clips with captions, hooks and a virality score — picked from the moments viewers actually rewatch.`,
      changefreq: 'weekly',
      priority: '1.0',
      body: `<h1>${NAME} — ${TAGLINE}</h1>
<p>${NAME} (formerly ${OLD_NAME}) is an AI clip maker that turns long videos — podcasts, streams, interviews, webinars — into short vertical clips for YouTube Shorts, Instagram Reels and TikTok. Instead of guessing, it starts from the moments viewers already rewatch.</p>
<h2>How it works</h2>
${list(['<strong>Drop a video</strong> — paste a YouTube, Twitch, Vimeo or Google Drive link, or upload a file.', '<strong>We find the peaks</strong> — replay data, comments and audio energy show where viewers lean in; Gemini picks moments that stand on their own.', '<strong>Post the winners</strong> — 1080×1920 clips with captions, a hook and a score, ranked and ready to post or schedule.'])}
<h2>Features</h2>
${list(FEATURES)}
<h2>Pricing</h2>
${list(planLines())}
<p>Prices in US dollars. Every clip costs ${CREDITS_PER_CLIP} credits; edits and re-renders are free. <a href="/pricing">See full pricing</a>.</p>
${nav()}`,
    },
    '/pricing': {
      title: `Pricing — ${NAME} AI clip maker`,
      description: `${NAME} pricing in US dollars: a free plan, Creator at $${PLANS.creator.price}/month and Pro at $${PLANS.pro.price}/month. Every clip costs ${CREDITS_PER_CLIP} credits; edits are free.`,
      changefreq: 'monthly',
      priority: '0.8',
      body: `<h1>${NAME} pricing</h1><p>Simple monthly plans in US dollars. Start free — no card needed.</p>${list(planLines())}${nav()}`,
    },
    '/crayo-alternative': {
      title: `${NAME} vs Crayo — a Crayo alternative for clipping long videos`,
      description: `Looking for a Crayo alternative? Crayo makes new short videos from scratch; ${NAME} turns your long videos into clips, picked from the moments viewers actually rewatch. Compare features and pricing.`,
      changefreq: 'monthly',
      priority: '0.7',
      body: `<h1>${NAME} vs Crayo</h1>
<p>Crayo (crayo.ai) and ${NAME} both make short-form videos, but they start from different places. Crayo is built for creating new videos — Reddit story videos, fake text videos, AI voiceovers — and also has an Auto Clip tool. ${NAME} does one job: turning long videos you already have into clips, starting from the moments viewers rewatch.</p>
<h2>When ${NAME} is the better fit</h2>
${list(['You have podcasts, streams, interviews or long YouTube videos to clip.', 'You want clips picked from real audience data (YouTube’s “most replayed” graph and timestamped comments), not only AI guesses.', 'You want every clip scored and ranked, with the reasons shown.', 'You want Autopilot to find, clip and post new videos for you.'])}
<h2>When Crayo is the better fit</h2>
${list(['You want to make videos from text — Reddit stories, chat-style stories — with AI voiceovers and gameplay backgrounds.'])}
${nav()}`,
    },
    '/about': {
      title: `About ${NAME} (formerly ${OLD_NAME})`,
      description: `${NAME}, formerly ${OLD_NAME}, turns long videos into short, ready-to-post clips — starting from the moments viewers actually rewatch.`,
      changefreq: 'yearly',
      priority: '0.5',
      body: `<h1>About ${NAME}</h1><p>${NAME} (formerly ${OLD_NAME}) turns long videos into short, ready-to-post clips — starting from the moments viewers actually rewatch.</p>${nav()}`,
    },
    '/contact': {
      title: `Contact — ${NAME}`,
      description: `How to reach the ${NAME} team for support, billing and partnership questions.`,
      changefreq: 'yearly',
      priority: '0.4',
      body: `<h1>Contact ${NAME}</h1>${nav()}`,
    },
    '/terms': { title: `Terms of service — ${NAME}`, description: `The terms for using ${NAME}.`, changefreq: 'yearly', priority: '0.2', body: `<h1>Terms of service</h1>${nav()}` },
    '/privacy': {
      title: `Privacy policy — ${NAME}`,
      description: `How ${NAME} collects, uses and protects your data.`,
      changefreq: 'yearly',
      priority: '0.2',
      body: `<h1>Privacy policy</h1>${nav()}`,
    },
    '/refunds': {
      title: `Refunds & cancellation — ${NAME}`,
      description: `How refunds and cancelling a ${NAME} plan work.`,
      changefreq: 'yearly',
      priority: '0.2',
      body: `<h1>Refunds &amp; cancellation</h1>${nav()}`,
    },
    '/shipping': {
      title: `Shipping & delivery — ${NAME}`,
      description: `${NAME} is software delivered online — nothing is shipped.`,
      changefreq: 'yearly',
      priority: '0.2',
      body: `<h1>Shipping &amp; delivery</h1>${nav()}`,
    },
    '/signup': {
      title: `Start free — ${NAME}`,
      description: `Create a free ${NAME} account and turn your first long video into clips. No card needed.`,
      changefreq: 'yearly',
      priority: '0.6',
      body: `<h1>Start free with ${NAME}</h1>${nav()}`,
    },
    '/login': { title: `Log in — ${NAME}`, description: `Log in to ${NAME}.`, changefreq: 'yearly', priority: '0.3', body: `<h1>Log in to ${NAME}</h1>${nav()}` },
  };
}

/** Facts about the business and product, in the format search engines read (schema.org). Home page only. */
function structuredData(site: string) {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: NAME,
      alternateName: [OLD_NAME, 'Crest Clip'],
      url: site,
      logo: `${site}/logo-512.png`,
      email: config.business.email || undefined,
    },
    { '@context': 'https://schema.org', '@type': 'WebSite', name: NAME, alternateName: [OLD_NAME, 'Crest Clip'], url: site },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: NAME,
      alternateName: OLD_NAME,
      applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Web',
      url: site,
      description: 'AI clip maker that turns long videos into vertical clips with captions, hooks and a virality score, picked from the moments viewers rewatch.',
      offers: PLAN_ORDER.map((id) => ({ '@type': 'Offer', name: PLANS[id].name, price: String(PLANS[id].price), priceCurrency: 'USD' })),
    },
  ];
}

/** The tracker IDs for the browser (only well-formed ones, so nothing odd can be written into the page). */
function analyticsTag() {
  const ga = /^G-[A-Z0-9]{4,20}$/.test(config.analytics.gaId ?? '') ? config.analytics.gaId : undefined;
  const clarity = /^[a-z0-9]{6,20}$/i.test(config.analytics.clarityId ?? '') ? config.analytics.clarityId : undefined;
  if (!ga && !clarity) return '';
  return `<script>window.__CC_ANALYTICS__=${JSON.stringify({ ga, clarity })}</script>`;
}

let template: string | null = null;
const indexHtml = () => (template ??= fs.readFileSync(path.join(config.webDist, 'index.html'), 'utf8'));

/** Paths React handles that are private (signed in) — served, but never indexed. */
const PRIVATE = /^\/(app|receipt)(\/|$)/;
const REDIRECTS: Record<string, string> = { '/refund-policy': '/refunds' };

/** Sends the app page for any non-API address, with the right title, tags and search-engine text filled in. */
export function sendAppPage(req: Request, res: Response) {
  const site = config.publicUrl;
  const p = req.path.length > 1 ? req.path.replace(/\/+$/, '') : '/';
  if (REDIRECTS[p]) return res.redirect(301, REDIRECTS[p]);
  const page = pages()[p];
  const isPrivate = PRIVATE.test(p);
  // an address that isn't a page: say so (status 404), so search engines don't index it as a copy of the home page
  if (!page && !isPrivate) res.status(404);

  let html = indexHtml().replace('</head>', `    ${analyticsTag()}\n  </head>`);
  res.setHeader('Cache-Control', 'no-cache');
  if (!page) {
    html = html.replace('</head>', '    <meta name="robots" content="noindex" />\n  </head>');
    return res.type('html').send(html);
  }

  const url = site + (p === '/' ? '/' : p);
  const image = `${site}/og.png`;
  const tags = [
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${NAME}" />`,
    `<meta property="og:title" content="${esc(page.title)}" />`,
    `<meta property="og:description" content="${esc(page.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(page.title)}" />`,
    `<meta name="twitter:description" content="${esc(page.description)}" />`,
    `<meta name="twitter:image" content="${image}" />`,
    ...(p === '/' ? [`<script type="application/ld+json">${JSON.stringify(structuredData(site)).replace(/</g, '\\u003c')}</script>`] : []),
  ];
  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(page.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${esc(page.description)}" />`)
    .replace('</head>', `    ${tags.join('\n    ')}\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root"><main style="max-width:760px;margin:40px auto;padding:0 16px;font-family:system-ui,sans-serif">${page.body}</main></div>`);
  res.type('html').send(html);
}

export function robotsTxt(_req: Request, res: Response) {
  res
    .type('text/plain')
    .send(['User-agent: *', 'Allow: /', 'Disallow: /app', 'Disallow: /api/', 'Disallow: /media/', 'Disallow: /receipt/', '', `Sitemap: ${config.publicUrl}/sitemap.xml`, ''].join('\n'));
}

export function sitemapXml(_req: Request, res: Response) {
  const site = config.publicUrl;
  const entries = Object.entries(pages())
    .filter(([p]) => p !== '/login')
    .map(([p, page]) => `  <url><loc>${site}${p === '/' ? '/' : p}</loc><changefreq>${page.changefreq}</changefreq><priority>${page.priority}</priority></url>`);
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`);
}
