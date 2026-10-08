import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { withRequiredTags } from './instructions.js';
import { clips as clipDb, projects, type AiUsage, type ClipDefaults, type ClipRow, type ProjectRow } from '../db/index.js';
import { limiter, run } from '../lib/proc.js';
import { projectDir } from '../lib/paths.js';
import { buildAss, wordsInRange, type EmojiCue } from './captions.js';
import { part, uploadToGcs, deleteFromGcs, usage, usageTotals, withUsageLedger } from './gemini.js';
import { removeFromCloud, saveToCloud } from '../infra/cloudStore.js';
import { extractAudio, extractAudioRange, hasLibass, loudnessPerSecond, makeProxy, probe, silences as findSilences, thumbnail } from './media.js';
import { aiScore, describeClips, ensurePeakCandidate, findMoments, junkTitle, rankClips, snapClips, snapRange, startPeakClip } from './moments.js';
import { judgeClips } from './judge.js';
import { contentBand, planReframe } from './reframe.js';
import { concatParts, faceOnFrame, mixMusic, planZooms, renderClip } from './render.js';
import { emojiPng } from './emoji.js';
import { cutTimes, keptLength, planKeep, retimeWords, silencesIn, snapKeep, toFrame } from './pace.js';
import { alignPhrases, phrasesInRange, retimeToWords, speechGaps } from './align.js';
import { crestclipMark, watermarkForRender, watermarkTopBottom } from './watermark.js';
import { BillingError, chargeProject, refundProject, renderRules, settleProject } from '../modules/billing/billing.service.js';
import { resolveMusic } from './music.js';
import { buildSignals, rangeScore } from './signals.js';
import { sampleSpeech, spokenWords, transcribe } from './transcribe.js';
import { findVisualMoments, mostlySilent, snapToShots, tooLittleSpeech, type VisualSource } from './visual.js';
import { download, downloadAudio, fetchComments, fetchInfo, fetchWordTimings, type Comment, type SourceInfo } from './ytdlp.js';
import { downloadPlan, endSectionMode, footageFor, footageSavings, infoJsonPath, prefetchFootage, readFootage, startSectionMode } from './footage.js';
import { draftTranscript } from './asr.js';
import { fetchAudioFast } from './fastparts.js';
import { enqueueRender } from '../infra/queue.js';
import { classifyFileLink, downloadFileLink, fileLinkLabel } from './filelink.js';
import type { CaptionStyle, Layout, ProjectOptions, ReframePlan, Segment, Signals, TimeRange, Word } from '../types.js';
import { BUSY, withClusterLock } from '../infra/shared.js';
import { touch } from '../lib/activity.js';

type Stage = 'fetch' | 'listen' | 'transcribe' | 'moments' | 'render';
const STAGE_RANGE: Record<Stage, [number, number]> = {
  fetch: [0, 22],
  listen: [22, 28],
  transcribe: [28, 55],
  moments: [55, 64],
  render: [64, 100],
};

const progressWrites = new Map<string, Promise<void>>();

// ---------------- "about 2 min left": how long each step usually takes ----------------
// Seconds per step, from measurements; each finished step nudges its number towards what this server just saw, so
// the estimate follows the machine it runs on. The render figure is per clip per render slot.
const STAGE_ORDER: Stage[] = ['fetch', 'listen', 'transcribe', 'moments', 'render'];
const usual: Record<Stage, number> = { fetch: 12, listen: 8, transcribe: 45, moments: 40, render: 50 };
const stageStarted = new Map<string, { s: Stage; at: number }>();
const etaPlan = new Map<string, { clips: number }>();
function budget(id: string, s: Stage) {
  if (s !== 'render') return usual[s];
  const clips = etaPlan.get(id)?.clips ?? 10;
  return usual.render * Math.ceil(clips / Math.max(1, config.renderConcurrency)) + (readFootage(projectDir(id)) ? 25 : 0);
}
/** Seconds still to go: the rest of this step, plus every step after it. */
function etaSeconds(id: string, s: Stage, frac: number) {
  let left = budget(id, s) * (1 - frac);
  for (const later of STAGE_ORDER.slice(STAGE_ORDER.indexOf(s) + 1)) left += budget(id, later);
  return Math.round(left);
}
function learn(id: string, s: Stage, secs: number) {
  if (secs < 1) return; // skipped steps don't count
  const per = s === 'render' ? secs / Math.ceil((etaPlan.get(id)?.clips ?? 10) / Math.max(1, config.renderConcurrency)) : secs;
  usual[s] = Math.max(1, usual[s] * 0.6 + per * 0.4);
}

/** Show progress. Writes go out one after another per project, and never hold up (or break) the work itself. */
function stage(id: string, s: Stage, frac = 0, detail = '') {
  touch(); // progress = the job is alive
  const [a, b] = STAGE_RANGE[s];
  const prev = stageStarted.get(id);
  if (prev?.s !== s) {
    if (prev) {
      learn(id, prev.s, (Date.now() - prev.at) / 1000);
      console.log(`[project ${id}] ${prev.s} took ${((Date.now() - prev.at) / 1000).toFixed(0)}s → ${s} (${sinceStart(id)})`);
    }
    stageStarted.set(id, { s, at: Date.now() });
  }
  const f = Math.max(0, Math.min(1, frac));
  const patch = { stage: s, progress: +(a + (b - a) * f).toFixed(1), stageDetail: detail, etaAt: Date.now() + etaSeconds(id, s, f) * 1000 };
  const write = (progressWrites.get(id) ?? Promise.resolve()).then(() => projects.update(id, patch)).catch((e) => console.warn(`[project ${id}] progress:`, (e as Error).message));
  progressWrites.set(id, write);
  void write.then(() => progressWrites.get(id) === write && progressWrites.delete(id));
}

const jobStart = new Map<string, number>();
const sinceStart = (id: string) => `${((Date.now() - (jobStart.get(id) ?? Date.now())) / 1000).toFixed(0)}s in`;

/** A line for the page's live feed ("what the AI found") — never holds up the work. */
function note(id: string, text: string, kind: 'moment' | 'clip' | 'info' = 'info') {
  const item = { t: Date.now(), text, kind };
  // in line with this process's progress writes (a database that applies updates one document at a time can't lose one)
  const write = (progressWrites.get(id) ?? Promise.resolve()).then(() => projects.note(id, item)).catch(() => {});
  progressWrites.set(id, write);
  void write.then(() => progressWrites.get(id) === write && progressWrites.delete(id));
}


/** Wait for queued progress writes, so the final status isn't overwritten by a late one. */
const progressSaved = (id: string) => progressWrites.get(id) ?? Promise.resolve();

/** Clip a project, keeping a ledger of its AI calls; the totals are saved on the project (aiUsage) and logged. */
export async function processProject(id: string) {
  const { lines } = await withUsageLedger(() => runProject(id));
  if (!lines.length) return;
  const t = usageTotals(lines);
  const byLabel = new Map<string, AiUsage['byLabel'][number]>();
  for (const l of lines) {
    const key = `${l.label}|${l.model}`;
    const row = byLabel.get(key) ?? { label: l.label, model: l.model, calls: 0, text: 0, audio: 0, video: 0, image: 0, cached: 0, output: 0, ms: 0 };
    row.calls++;
    row.text += l.text;
    row.audio += l.audio;
    row.video += l.video;
    row.image += l.image;
    row.cached += l.cached;
    row.output += l.output;
    row.ms += l.ms;
    byLabel.set(key, row);
  }
  const aiUsage: AiUsage = { ...t, byLabel: [...byLabel.values()] };
  await projects.update(id, { aiUsage }).catch(() => {});
  // for the server log only — never shown in the app
  console.log(
    `[project ${id}] AI usage: ${t.calls} calls · in ${(t.text / 1000).toFixed(0)}K text + ${(t.audio / 1000).toFixed(0)}K audio + ${(t.video / 1000).toFixed(0)}K video + ${(t.image / 1000).toFixed(0)}K image tokens · out ${(t.output / 1000).toFixed(1)}K (${(t.thoughts / 1000).toFixed(1)}K thinking)`,
  );
  console.log(`[project ${id}] AI time by step: ${aiUsage.byLabel.map((r) => `${r.label} ×${r.calls} ${(r.ms / 1000).toFixed(0)}s`).join(' · ')}`);
}

async function runProject(id: string) {
  const p = await projects.get(id);
  if (!p) return;
  const dir = projectDir(id);
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });
  await projects.update(id, { status: 'processing', error: null, errorCode: null, startedAt: Date.now(), etaAt: null });
  stageStarted.delete(id);
  jobStart.set(id, Date.now());
  const startedUsage = { ...usage };

  try {
    // Resume: moments already found → only (re)render what's missing.
    const existing = await clipDb.forProject(id);
    if (p.transcript && p.signals && existing.length && ((p.mediaPath && fs.existsSync(p.mediaPath)) || readFootage(dir))) {
      await refreshTranscript(id).catch((e) => console.error(`[project ${id}] transcribing again failed:`, e));
      const todo = (await clipDb.forProject(id)).filter((c) => c.status !== 'ready');
      await renderAll(id, todo);
      await progressSaved(id);
      await projects.update(id, { status: 'done', stage: 'done', progress: 100, stageDetail: '' });
      return;
    }

    await projects.update(id, { feed: [] }); // a fresh run: the page's "what CrestClip is finding" starts empty

    // Parts picked by hand (Explore graph): skip the AI search, fetch + clip exactly those parts.
    if (p.options.ranges?.length && p.sourceType === 'url' && p.sourceUrl) {
      await processPickedParts(id);
      return;
    }

    // ---------- 1. fetch ----------
    stage(id, 'fetch', 0, p.sourceType === 'url' ? 'Reading the link…' : 'Reading your upload…');
    let src = p.mediaPath && fs.existsSync(p.mediaPath) ? p.mediaPath : null;
    // a file link (Google Drive, Dropbox, OneDrive, direct .mp4): download it, then treat it like an upload
    if (!src && p.sourceType === 'upload' && p.sourceUrl) {
      const link = classifyFileLink(p.sourceUrl);
      if (!link || 'error' in link) throw new Error(link && 'error' in link ? link.error : 'That link isn’t a video file.');
      const where = fileLinkLabel[link.kind];
      stage(id, 'fetch', 0.02, `Downloading from ${where}…`);
      const got = await downloadFileLink(link, dir, (pct, detail) => stage(id, 'fetch', 0.02 + (pct / 100) * 0.9, `Downloading from ${where} · ${detail}`));
      src = got.file;
      const title = got.name
        .replace(/\.[^.]+$/, '')
        .replace(/[_-]+/g, ' ')
        .trim()
        .slice(0, 120);
      await projects.update(id, { mediaPath: src, ...(title && title !== 'video' ? { title } : {}) });
    }
    let info: SourceInfo | null = null;
    let commentsP: Promise<Comment[]> = Promise.resolve([]);
    // "captions first": the site's own speech recognition stands in for the transcript, so the moments of a long
    // video are found without downloading its audio or transcribing it (see asr.ts)
    let captions: { segments: Segment[]; silences: { s: number; e: number }[] } | null = null;
    if (p.sourceType === 'url' && p.sourceUrl) {
      info = await fetchInfo(p.sourceUrl, infoJsonPath(dir));
      assertNotLive(info);
      if (info.duration && info.duration > config.maxSourceMinutes * 60)
        throw new Error(`This video is ${Math.round(info.duration / 60)} min long. The limit is ${config.maxSourceMinutes} min (MAX_SOURCE_MINUTES).`);
      // pay before downloading anything big (5 credits per clip asked for; checks the plan's length limit too)
      if (info.duration) await chargeProject(id, info.duration, `Clipping “${info.title}”`);
      await projects.update(id, {
        title: info.title,
        channel: info.channel,
        description: info.description,
        duration: info.duration,
        viewCount: info.viewCount,
      });
      note(id, `Read the link · “${info.title}” · ${formatClock(info.duration)} long`);
      if (info.isYouTube && p.options.useAudienceData) commentsP = fetchComments(info.webpageUrl);
      if (!src) {
        const smart = config.downloadMode === 'smart' && info.duration >= config.smartMinMinutes * 60 && info.liveStatus !== 'is_live';
        const fetchStage = (label: string) => (pct: number, detail: string) => stage(id, 'fetch', 0.1 + (pct / 100) * 0.85, `${label} · ${detail}`);
        if (config.captionsFirst && info.isYouTube && info.duration && info.liveStatus !== 'is_live' && !p.noSpeech) {
          stage(id, 'fetch', 0.1, 'Reading the video’s captions…');
          const words = await fetchWordTimings(info.webpageUrl, work, infoJsonPath(dir)).catch((e) => (console.warn('[captions first]', (e as Error).message), null));
          const draft = words ? draftTranscript(words, info.duration) : null;
          if (draft && !tooLittleSpeech(draft.segments, info.duration)) {
            captions = draft;
            note(id, `${spokenWords(draft.segments).toLocaleString('en')} words in the video’s own captions — no transcription needed first`);
          }
        }
        if (captions && smart) {
          // nothing else is needed before the moments: the video is fetched later, just for the clip parts
          startSectionMode(dir, info.webpageUrl, info.fullSizeEstimate);
        } else if (smart) {
          // Long video: grab only the audio now. Video is fetched later, just for the clip parts.
          try {
            src =
              (await fetchAudioFast(infoJsonPath(dir), path.join(dir, 'source-audio.m4a'), fetchStage('Downloading the audio'))) ??
              (await downloadAudio(info.webpageUrl, dir, fetchStage('Downloading the audio'), infoJsonPath(dir)));
            startSectionMode(dir, info.webpageUrl, info.fullSizeEstimate);
          } catch (e) {
            console.warn(`[project ${id}] audio-only download failed, downloading the full video instead:`, (e as Error).message);
            src = null;
          }
        }
        if (!src && !readFootage(dir)) src = await download(info.webpageUrl, dir, fetchStage('Downloading'), infoJsonPath(dir));
      }
    }
    if (!src && !readFootage(dir)) throw new Error('No video file to work with.');
    const pr = src ? await probe(src, { audioOnlyOk: true }) : { width: 0, height: 0, duration: 0, hasAudio: true };
    if (!pr.width && !readFootage(dir)) throw new Error('This file has no video track.');
    if (pr.width && readFootage(dir)) endSectionMode(dir); // the "audio" download turned out to be a full video — use it as is
    const duration = pr.duration || info?.duration || 0;
    if (!duration) throw new Error('Could not read the video length.');
    await chargeProject(id, duration, `Clipping “${(await projects.get(id))?.title ?? 'your video'}”`); // uploads / file links (links were charged above)
    const thumb = path.join(dir, 'thumb.jpg');
    if (src && pr.width) await thumbnail(src, Math.min(duration * 0.15, 60), thumb).catch(() => {});
    else if (info?.thumbnail) await remoteThumbnail(info.thumbnail, thumb, work).catch(() => {});
    await projects.update(id, {
      mediaPath: src,
      duration,
      width: pr.width || info?.width || null,
      height: pr.height || info?.height || null,
      thumbPath: fs.existsSync(thumb) ? thumb : null,
    });
    void saveToCloud(fs.existsSync(thumb) ? thumb : null);
    stage(id, 'fetch', 1, pr.width ? 'Video ready' : captions ? 'Captions read — video will be fetched only for the clips' : 'Audio ready — video will be fetched only for the clips');

    // ---------- 2. listen ----------
    // No talking (no audio track, near-silent, or music only) → "no-speech mode": the AI watches the video instead.
    let noSpeech = Boolean(p.noSpeech) || !pr.hasAudio;
    const audio = path.join(work, 'audio.mp3');
    const silPath = path.join(work, 'silences.json');
    const rmsPath = path.join(work, 'rms.json');
    let sil: { s: number; e: number }[] = [];
    let rms: number[] | null = null;
    if (captions && !src) {
      // the pauses come from the captions' word times; there's no audio file to measure energy on
      sil = captions.silences;
      fs.writeFileSync(silPath, JSON.stringify(sil));
      stage(id, 'listen', 1, 'Pauses read from the captions');
    } else if (!pr.hasAudio) {
      stage(id, 'listen', 1, 'No sound track — CrestClip will watch the video instead');
    } else if (fs.existsSync(audio) && fs.existsSync(silPath) && fs.existsSync(rmsPath)) {
      sil = JSON.parse(fs.readFileSync(silPath, 'utf8'));
      rms = JSON.parse(fs.readFileSync(rmsPath, 'utf8'));
    } else {
      stage(id, 'listen', 0, 'Pulling out the audio…');
      await extractAudio(src!, audio);
      stage(id, 'listen', 0.5, 'Measuring energy and pauses…');
      [rms, sil] = await Promise.all([loudnessPerSecond(audio, work).catch((e) => (console.warn('[loudness]', e.message), null)), findSilences(audio).catch(() => [] as { s: number; e: number }[])]);
      fs.writeFileSync(silPath, JSON.stringify(sil));
      fs.writeFileSync(rmsPath, JSON.stringify(rms));
    }

    // ---------- 3. transcribe (reuse a saved transcript on retry) ----------
    let segments: Segment[] = noSpeech ? [] : (p.transcript ?? []);
    if (captions && !noSpeech && !segments.length) {
      segments = captions.segments;
      // only the clip parts get the proper transcript (clean phrasing, the chosen script), just before they render
      fs.writeFileSync(coveredPath(dir), '[]');
      await projects.update(id, { transcript: segments, transcriptRev: TRANSCRIPT_REV, noSpeech: false });
      stage(id, 'transcribe', 1, 'Using the video’s captions for now');
    } else if (!noSpeech && !segments.length) {
      if (mostlySilent(sil, duration)) {
        noSpeech = true;
      } else if (duration > 10 * 60) {
        // long video: listen to a few short slices first, so a 3-hour music/gameplay video isn't transcribed for nothing
        stage(id, 'transcribe', 0, 'Checking for talking…');
        if ((await sampleSpeech(audio, duration, work)) < 4) noSpeech = true;
      }
      if (!noSpeech) {
        stage(id, 'transcribe', 0, 'Listening to the video…');
        const got = await transcribe(audio, duration, work, (d, t) => stage(id, 'transcribe', d / t, `Transcribing · part ${d} of ${t}`), sil, p.options.captionLanguage ?? 'auto');
        if (tooLittleSpeech(got.segments, duration)) noSpeech = true;
        else segments = await withMeasuredTimes(got.segments, info?.webpageUrl, dir);
        if (!noSpeech) note(id, `Transcribed · ${spokenWords(segments).toLocaleString('en')} words`);
      }
      if (noSpeech) {
        segments = [];
        console.log(`[project ${id}] no talking found — switching to no-speech mode`);
        note(id, 'No talking found — CrestClip will watch the video for its moments');
      }
      await projects.update(id, { transcript: segments, transcriptRev: TRANSCRIPT_REV, noSpeech });
    } else if (noSpeech && !p.noSpeech) {
      await projects.update(id, { transcript: [], transcriptRev: TRANSCRIPT_REV, noSpeech });
    }
    const tr = { segments };

    // ---------- 4. find moments ----------
    stage(id, 'moments', 0.05, 'Reading the audience heatmap…');
    // the comments are a hint, not a must: a slow fetch doesn't hold the moments up for more than a few seconds
    const t0 = Date.now();
    const comments = await Promise.race([commentsP, new Promise<Comment[]>((res) => setTimeout(() => res([]), 12_000))]);
    if (Date.now() - t0 > 2000) console.log(`[project ${id}] waited ${((Date.now() - t0) / 1000).toFixed(0)}s for the comments${comments.length ? '' : ' — going on without them'}`);
    const signals: Signals = buildSignals({
      duration,
      heatmap: info?.heatmap ?? null,
      chapters: info?.chapters ?? [],
      comments,
      rmsPerSecond: rms,
      useAudience: p.options.useAudienceData,
    });
    await projects.update(id, { signals });

    let cands: Awaited<ReturnType<typeof findMoments>>['clips'];
    let notes: string;
    let videoTitle: string | null = null;
    const source: VisualSource | null = info?.isYouTube ? { kind: 'youtube', url: info.webpageUrl } : pr.width && src ? { kind: 'file', src } : null;
    if (noSpeech) {
      if (!source) throw new Error('This video has no talking, and the picture isn’t available to watch.');
      stage(id, 'moments', 0.1, 'No talking — watching the video for moments…');
      const found = await findVisualMoments({
        id,
        source,
        duration,
        work,
        title: info?.title ?? p.title ?? 'Untitled',
        channel: info?.channel ?? '',
        description: info?.description ?? '',
        signals,
        options: p.options,
        onProgress: (frac, detail) => stage(id, 'moments', 0.1 + frac * 0.85, detail),
      });
      cands = found.clips;
      videoTitle = found.videoTitle;
      notes = ['No talking in this video — CrestClip picked the moments by watching it.', found.notes].filter(Boolean).join(' ');
    } else {
      let videoPart = null;
      let gcsObject: string | null = null;
      if (config.sendVideoToGemini && !config.fakeAi && duration <= 45 * 60) {
        try {
          if (info?.isYouTube) {
            videoPart = part.uri(info.webpageUrl, 'video/mp4', { fps: 0.5 });
          } else if (config.gcsBucket && pr.width && src) {
            stage(id, 'moments', 0.15, 'Uploading a preview to Cloud Storage…');
            const proxy = path.join(work, 'proxy.mp4');
            await makeProxy(src, proxy);
            gcsObject = `crestclip/tmp/${id}/proxy.mp4`; // temporary — deleted right after Gemini has watched it
            videoPart = part.uri(await uploadToGcs(proxy, gcsObject, 'video/mp4'), 'video/mp4', { fps: 0.5 });
          }
        } catch {
          videoPart = null;
        }
      }

      stage(id, 'moments', 0.35, 'Hunting for viral moments…');
      // the #1 audience peak gets its own small search at the same time (used only if the main search skips it)
      const peakP = startPeakClip({ segments: tr.segments, duration, title: info?.title ?? p.title ?? 'Untitled', channel: info?.channel ?? '', signals, options: p.options });
      // a long video is searched in parallel stretches (one request each, all at once), each asked
      // for its own best moments; the judge then grades them all together, so the long ones take no longer than
      // a short one. Short videos stay as one request.
      // (~20-minute stretches, up to 6: most of a request's time is writing out its clips, so fewer clips per request
      // answer sooner; one 30-minute stretch was measured at 60–120 s)
      const windows = videoPart || duration <= 25 * 60 ? 1 : Math.min(6, Math.ceil(duration / (20 * 60)));
      const askEach = Math.max(2, Math.ceil(Math.max(1, Math.min(30, p.options.clipCount)) / windows));
      if (windows > 1) note(id, `Long video: searching ${windows} stretches of it at the same time`);
      const parts = await Promise.all(
        Array.from({ length: windows }, (_, i) => {
          const win = windows > 1 ? { start: (duration * i) / windows, end: (duration * (i + 1)) / windows } : null;
          const inWin = (t: number) => !win || (t >= win.start && t < win.end);
          return findMoments({
            segments: win ? tr.segments.filter((sg) => inWin((sg.s + sg.e) / 2)) : tr.segments,
            duration,
            title: info?.title ?? p.title ?? 'Untitled',
            channel: info?.channel ?? '',
            description: info?.description ?? '',
            signals: win && signals ? { ...signals, hotspots: signals.hotspots.filter((h) => inWin((h.start + h.end) / 2)), chapters: signals.chapters.filter((c) => inWin(c.start_time)) } : signals,
            options: win ? { ...p.options, clipCount: askEach } : p.options,
            videoPart,
            window: win,
          });
        }),
      ).finally(() => {
        if (gcsObject) deleteFromGcs(gcsObject);
      });
      const found = { clips: parts.flatMap((x) => x.clips), notes: parts.map((x) => x.notes).filter(Boolean).join(' '), videoTitle: parts.find((x) => x.videoTitle)?.videoTitle ?? null };
      // the tallest replay peak always gets a candidate, so the graph and the clips agree
      cands = ensurePeakCandidate(found.clips, await peakP, signals);
      notes = found.notes;
      videoTitle = found.videoTitle;
      for (const c of cands.slice(0, 6)) note(id, `${formatClock(c.start)} — “${(c.hook || c.title).slice(0, 90)}”`, 'moment');
      if (cands.length > 6) note(id, `…and ${cands.length - 6} more candidates`);
    }
    // an upload named "6AA26DA6 8EC2 404C…" or "IMG 4021" gets the AI's title for the video (a link keeps its real title)
    if (videoTitle && !info && junkTitle(p.title)) await projects.update(id, { title: videoTitle });
    console.log(`[project ${id}] ${cands.length} candidates found (${sinceStart(id)})`);
    let picked = snapClips(cands, tr.segments, sil, duration, p.options);
    if (noSpeech && pr.width && src) picked = await snapToShots(picked, src, duration); // start and end on a camera cut
    // a separate, blind judge grades the clips (the picker marks its own picks far too kindly)
    stage(id, 'moments', 0.96, 'Grading the clips…');
    picked = await judgeClips({
      clips: picked,
      duration,
      title: info?.title ?? p.title ?? 'Untitled',
      channel: info?.channel ?? '',
      options: p.options,
      segments: tr.segments,
      visual: noSpeech && source ? { source, work, id } : null,
      label: `project ${id}`,
    });
    const final = rankClips(picked, signals, duration, p.options).map((c) => ({ ...c, hashtags: withRequiredTags(c.hashtags, p.options) }));
    if (!final.length) throw new Error('No clip-worthy moments were found in this video.');
    const saved = await clipDb.replaceForProject(id, final, clipDefaults(p.options, noSpeech));
    await projects.update(id, { aiNotes: notes });
    await settleProject(id, saved.length, `Clipping “${(await projects.get(id))?.title ?? 'your video'}”`); // fewer clips than asked → credits back
    note(id, `The judge kept ${saved.length} of ${cands.length} candidates`);
    stage(id, 'moments', 1, `Found ${saved.length} moments`);

    // ---------- 5. each clip: fetch its part (section mode), reframe + render — best clip first ----------
    await renderAll(id, saved);
    const used = { calls: usage.calls - startedUsage.calls, input: usage.input - startedUsage.input, output: usage.output - startedUsage.output };
    await progressSaved(id);
    // AI usage and download savings are for the server log only — never shown in the app
    if (used.calls)
      console.log(`[project ${id}] ${used.calls} AI calls · ${(used.input / 1000).toFixed(0)}K in / ${(used.output / 1000).toFixed(1)}K out tokens${savingsText(dir) ? ` · ${savingsText(dir)}` : ''}`);
    await projects.update(id, { status: 'done', stage: 'done', progress: 100, stageDetail: '' });
    fs.rmSync(path.join(work, 'frames'), { recursive: true, force: true });
    for (const f of fs.readdirSync(work)) if (f.startsWith('chunk_')) fs.rmSync(path.join(work, f), { force: true });
  } catch (e) {
    console.error(`[project ${id}]`, e instanceof BillingError ? e.message : e);
    await refundProject(id); // nothing usable came out of it, so the credits go back
    await progressSaved(id);
    await projects.update(id, { status: 'failed', error: (e as Error).message || String(e), errorCode: e instanceof BillingError ? e.code : null });
  }
}

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
function savingsText(dir: string) {
  const s = footageSavings(dir);
  if (!s || !s.full || s.full <= s.downloaded) return '';
  return `Downloaded ${mb(s.downloaded)} instead of ~${mb(s.full)}`;
}

/** Project thumbnail from the video's poster image (section mode has no local video yet). */
async function remoteThumbnail(url: string, out: string, work: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`thumbnail ${res.status}`);
  const tmp = path.join(work, 'poster.img');
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  await run(config.ffmpeg, ['-y', '-v', 'error', '-i', tmp, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', out], { timeoutMs: 30_000 });
  fs.rmSync(tmp, { force: true });
}

/**
 * Render the clips, best first, each as soon as its part of the video is here: the parts download several at a
 * time (section mode), and every render goes on the shared render queue, so all the workers pitch in and the first
 * clip shows up long before the last part has landed.
 */
async function renderAll(projectId: string, list: ClipRow[]) {
  if (!list.length) return;
  const p = (await projects.get(projectId))!;
  const dir = projectDir(projectId);
  const sections = Boolean(readFootage(dir));
  const total = list.length;
  const order = [...list].sort((a, b) => (b.peakScore ?? 0) - (a.peakScore ?? 0));
  etaPlan.set(projectId, { clips: total });
  stage(projectId, 'render', 0, sections ? `Downloading the clip parts · 0 of ${total} started` : `Reframing & rendering 0 of ${total}`);
  if (sections) note(projectId, `Downloading only the clip parts — ${Math.min(config.sectionDownloads, total)} at a time, best clip first`);

  // the padded download ranges (nearby clips share one); each clip waits only for the range it needs
  const plan = sections ? downloadPlan(order.flatMap(clipParts), p.duration ?? 0) : [];
  const rangeFor = (r: TimeRange) => plan.find((x) => x.start <= r.start + 0.01 && x.end >= r.end - 0.01) ?? r;
  const fetched = new Map<string, Promise<void>>();
  const fetchSlot = limiter(config.sectionDownloads);
  const prepSlot = limiter(5); // clips whose transcript is being made at once (each is 2–4 AI requests)
  let started = 0;
  const fetchRange = (r: TimeRange) => {
    const key = `${r.start}-${r.end}`;
    let job = fetched.get(key);
    if (!job) {
      job = fetchSlot(async () => {
        started++;
        stage(projectId, 'render', (0.3 * started) / Math.max(1, plan.length), `Downloading the clip parts · ${started} of ${plan.length} started`);
        await prefetchFootage(p, dir, [r], undefined, { exact: true });
      });
      fetched.set(key, job);
    }
    return job;
  };

  let done = 0;
  const finished = new Set<string>();
  const onDone = (c: ClipRow) => {
    if (finished.has(c.id)) return;
    finished.add(c.id);
    done++;
    if (done === 1) console.log(`[project ${projectId}] first clip ${c.status} ${sinceStart(projectId)}`);
    if (done === total) console.log(`[project ${projectId}] all ${total} clips done ${sinceStart(projectId)}`);
    stage(projectId, 'render', 0.3 + 0.7 * (done / total), `Rendering · ${done} of ${total} ready`);
  };

  await Promise.all(
    order.map(async (c) => {
      try {
        if (sections) await Promise.all(clipParts(c).map((r) => fetchRange(rangeFor(r))));
        // its proper transcript while the other parts download — not inside an encode slot
        await prepSlot(() => prepareClipText(c.id));
      } catch (e) {
        // not fatal: the render fetches its own part again, and shows an error if that fails too
        console.warn(`[project ${projectId}] part download failed for clip ${c.id}:`, (e as Error).message);
      }
      await enqueueRender(c.id, true);
    }),
  );
  if (!done) stage(projectId, 'render', 0.3, `Rendering · 0 of ${total} ready`);
  // the renders run on the shared queue (every worker helps); wait here until each clip is ready or gave up
  const deadline = Date.now() + Math.max(15, config.renderMaxMinutes * Math.ceil(total / config.renderConcurrency)) * 60_000;
  for (;;) {
    const rows = await clipDb.forProject(projectId);
    for (const c of rows) if (c.status === 'ready' || c.status === 'failed') onDone(c);
    const open = rows.filter((c) => c.status !== 'ready' && c.status !== 'failed');
    if (!open.length) break;
    if (Date.now() > deadline) {
      console.warn(`[project ${projectId}] ${open.length} clip(s) still rendering after the time limit — finishing the project without them`);
      break;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  etaPlan.delete(projectId);
}

const inflight = new Map<string, Promise<void>>();
const again = new Set<string>();
/** Clip renders are the heavy part (CPU + memory): at most RENDER_CONCURRENCY at once across ALL projects, however
 *  many videos (JOB_CONCURRENCY) are being worked on in parallel. */
const renderSlot = limiter(config.renderConcurrency);

/** Reframe (face tracking via Gemini) + captions + encode one clip. Safe to call again after edits:
 *  a call that arrives mid-render is coalesced into one re-render after the current one finishes. */
export function renderClipJob(clipId: string): Promise<void> {
  const cur = inflight.get(clipId);
  if (cur) {
    again.add(clipId);
    return cur;
  }
  const job = (async () => {
    try {
      // one render of a clip at a time across every worker (they share the clip's files); a second one waits its turn.
      // The clip's AI prep (its proper transcript) runs before it takes an encode slot: waiting on the AI must not
      // keep the CPU idle while other clips queue for that slot.
      await withClusterLock(
        `render:${clipId}`,
        async () => {
          await prepareClipText(clipId);
          return renderSlot(() => renderOnce(clipId));
        },
        { wait: true },
      );
    } finally {
      inflight.delete(clipId);
      if (again.delete(clipId)) await renderClipJob(clipId);
    }
  })();
  inflight.set(clipId, job);
  return job;
}

/**
 * "Captions first" projects: a clip's part gets its proper transcript (clean phrasing, the chosen script) before it
 * renders, a little wider than the clip so trims in the editor read well too. Bounded: when the AI is slow the
 * captions use the site's own words rather than hold the clip up. Done once per part (later calls find it covered).
 */
async function prepareClipText(clipId: string, maxMs = 60_000) {
  const c = await clipDb.get(clipId);
  if (!c) return;
  const p = await projects.get(c.projectId);
  if (!p || p.noSpeech || readCovered(projectDir(p.id)) === null) return;
  const pad = 8;
  const want = clipParts(c).map((r) => ({ start: Math.max(0, r.start - pad), end: Math.min(p.duration || r.end + pad, r.end + pad) }));
  const t0 = Date.now();
  try {
    const done = await Promise.race([ensureTranscript(p.id, want).then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), maxMs))]);
    if (!done) console.warn(`[clip ${clipId}] transcribing its part is taking too long — captions use the site's words`);
    else if (Date.now() - t0 > 1000) console.log(`[clip ${clipId}] part transcribed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } catch (e) {
    console.warn(`[clip ${clipId}] transcribing its part failed — captions use the site's words:`, (e as Error).message);
  }
}

/**
 * A stream that's still going (a Twitch broadcast in progress, a YouTube live): its recording keeps growing, so
 * "only the clip parts" can't work and the whole download would never end. Nothing is charged yet at this point.
 */
function assertNotLive(info: SourceInfo) {
  if (info.liveStatus === 'is_live' || info.liveStatus === 'is_upcoming')
    throw new Error('This stream is still live. Clip it once it has ended — the full recording is ready a few minutes after the stream stops.');
}

const near = (a: number | undefined, b: number) => a != null && Math.abs(a - b) < 0.05;

/** A reframe plan re-timed to start `by` seconds later (for rendering a piece from the middle of a part). */
function shiftPlan(plan: ReframePlan, by: number): ReframePlan {
  const before = plan.holds.filter((h) => h.t <= by).pop();
  const after = plan.holds.filter((h) => h.t > by).map((h) => ({ ...h, t: +(h.t - by).toFixed(3) }));
  return { ...plan, holds: [...(before ? [{ ...before, t: 0 }] : []), ...after] };
}

/** Parts of a clip: one continuous range, or several joined together. */
export const clipParts = (c: Pick<ClipRow, 'start' | 'end' | 'segments'>): TimeRange[] => (c.segments?.length ? c.segments : [{ start: c.start, end: c.end }]);

async function renderOnce(clipId: string) {
  const asked = await clipDb.get(clipId);
  if (!asked) return;
  const moved = await refreshTranscript(asked.projectId).catch((e) => (console.error(`[project ${asked.projectId}] transcribing again failed:`, e), [] as string[]));
  for (const id of moved) if (id !== clipId) void renderClipJob(id);
  const c = (await clipDb.get(clipId))!;
  const p = await projects.get(c.projectId);
  if (!p?.mediaPath && !readFootage(projectDir(c.projectId))) return;
  await clipDb.update(clipId, { status: 'rendering', error: null });
  const dir = projectDir(p!.id);
  const work = path.join(dir, 'work', `clip_${c.id}_${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    const parts = clipParts(c);
    const style = (c.captionStyle || 'pop') as CaptionStyle;
    const wantsText = !(style === 'none' && !c.showHook);
    const canText = wantsText && (await hasLibass());
    const oldPlans = c.reframe?.parts ?? (c.reframe ? [c.reframe] : []);
    const version = (c.version ?? 0) + 1;
    const out = path.join(dir, 'clips', `${c.id}_v${version}.mp4`);
    const needsPost = parts.length > 1 || c.music.track !== 'none' || Boolean(c.flashForward && c.teaser);

    const plans: ReframePlan[] = [];
    const files: string[] = [];
    // the owner's plan decides the watermark (Free: the CrestClip mark; paid: the project's logo, else the Settings one) and the export size
    const rules = await renderRules(p!.userId);
    const watermark = rules.crestclipWatermark ? crestclipMark() : rules.customLogo && p!.userId ? watermarkForRender(p!.userId, p!.options?.logo) : null;
    const silences = c.pace !== 'off' ? silencesFor(p!.id) : [];
    const gentle = c.category === 'story' || c.category === 'emotional'; // let these breathe
    let hasVoice = false;
    let total = 0;
    for (const [i, seg] of parts.entries()) {
      // where the pixels come from: the full video, or just the downloaded part around this piece
      const foot = await footageFor((await projects.get(p!.id)) ?? p!, dir, seg.start, seg.end);
      const ls = seg.start - foot.offset;
      const le = seg.end - foot.offset;
      let plan = oldPlans.find((pl) => near(pl.start, seg.start) && near(pl.end, seg.end)) ?? null;
      if (!plan) {
        const fresh = await planReframe({ src: foot.src, start: ls, end: le, width: foot.width, height: foot.height, workDir: work, layout: c.layout as Layout });
        plan = { ...fresh, start: seg.start, end: seg.end };
      }
      let want = c.layout === 'auto' ? (plan.suggested ?? plan.layout) : (c.layout as typeof plan.layout);
      if (want === 'split' && !plan.splitCenters) want = 'fit'; // fewer than two faces found
      plan = { ...plan, layout: want };
      // empty dark borders above/below the picture (letterbox, a face-cam circle on a plain background): find them
      // once per plan, so "fill" zooms in and cuts them away (older plans get checked on their next render)
      if (plan.layout === 'fill' && plan.band === undefined)
        plan = { ...plan, band: await contentBand({ src: foot.src, start: ls, end: le, width: foot.width, height: foot.height, holds: plan.holds, workDir: work }).catch(() => null) };
      plans.push(plan);

      const dur = seg.end - seg.start;
      const words = await captionWords(p!.transcript ?? [], foot.src, ls, seg.start, seg.end);
      const first = i === 0;
      const hookY = watermark && watermarkTopBottom(watermark) ? watermarkTopBottom(watermark)! + 30 : undefined;
      // captions go under the face: a bit lower when the face sits low in the frame, never into the apps' bottom area
      const face = faceOnFrame(plan, foot.height);
      const captionY = face == null ? undefined : Math.round(Math.min(1360, Math.max(1180, face * 1920 + 380)));
      const captions = (w: Word[], d: number, withHook: boolean) =>
        canText
          ? buildAss({ words: w, duration: d, style, layout: plan.layout, hook: withHook ? c.hook : '', showHook: withHook && c.showHook, keywords: c.keywords, emoji: c.emoji, hookY, captionY })
          : null;
      const emojiImages = (cues: EmojiCue[] = []) =>
        cues.flatMap((em) => {
          const file = emojiPng(em.emoji);
          return file ? [{ file, s: em.s, e: em.e }] : [];
        });

      // flash-forward: the tease line rendered as its own short piece, punched in, played before the story
      if (first && c.flashForward && c.teaser && c.teaser.start >= seg.start && c.teaser.end <= seg.end) {
        // on the frame grid, so the tease and the story join without the sound slipping
        const t0 = toFrame(c.teaser.start - seg.start);
        const tLen = Math.max(1 / 30, toFrame(c.teaser.end - c.teaser.start));
        const tAbs = seg.start + t0;
        const tWords = await captionWords(p!.transcript ?? [], foot.src, ls + t0, tAbs, tAbs + tLen);
        const tCap = captions(tWords, tLen, false);
        const teaserOut = path.join(work, 'teaser.mp4');
        await renderClip({
          src: foot.src,
          start: ls + t0,
          end: ls + t0 + tLen,
          width: foot.width,
          height: foot.height,
          hasAudio: foot.hasAudio,
          plan: shiftPlan(plan, t0),
          assContent: tCap?.ass ?? null,
          workDir: path.join(work, 'teaser'),
          out: teaserOut,
          motion: c.motion,
          zooms: [{ t: 0, z: 1.16 }],
          watermark,
          exportHeight: rules.exportHeight,
          emojis: emojiImages(tCap?.emojis),
          captionY: tCap?.captionY,
        });
        files.push(teaserOut);
        total += tLen;
      }

      // pieces to keep: long pauses shortened (and a lone "um" between pauses dropped)
      const keep = snapKeep(planKeep({ dur, silences: silencesIn(silences, seg), words, pace: c.pace, gentle }), dur);
      const cut = keep.length > 1 || keep[0].s > 0 || keep[0].e < toFrame(dur) - 1e-6;
      const outWords = cut ? retimeWords(words, keep) : words;
      const outDur = cut ? keptLength(keep) : dur;
      const cap = captions(outWords, outDur, first);
      const partOut = needsPost ? path.join(work, `part_${i}.mp4`) : out;
      await renderClip({
        src: foot.src,
        start: ls,
        end: le,
        width: foot.width,
        height: foot.height,
        hasAudio: foot.hasAudio,
        plan,
        assContent: cap?.ass ?? null,
        workDir: path.join(work, `r${i}`),
        out: partOut,
        motion: c.motion,
        zooms: planZooms(outWords, outDur, c.motion, cut ? cutTimes(keep) : []),
        introZoom: c.motion === 'dynamic' && first,
        watermark,
        exportHeight: rules.exportHeight,
        keep: cut ? keep : undefined,
        emojis: emojiImages(cap?.emojis),
        captionY: cap?.captionY,
      });
      files.push(partOut);
      hasVoice ||= foot.hasAudio;
      total += Math.round(outDur * 30) / 30; // the rendered part is a whole number of frames
    }

    let current = files[0];
    if (files.length > 1) {
      current = path.join(work, 'joined.mp4');
      await concatParts(files, current, work);
    }
    const notes: string[] = [];
    if (wantsText && !canText) notes.push('Captions were skipped: the custom ffmpeg set in FFMPEG_PATH can’t draw text. Remove FFMPEG_PATH from .env to use the built-in one, then re-render.');
    if (c.music.track !== 'none') {
      try {
        const m = await resolveMusic(c.music.track, c.category, p!.userId);
        if (m) {
          const mixed = path.join(work, 'music.mp4');
          await mixMusic({
            input: current,
            music: m.file,
            volume: c.music.volume,
            duck: c.music.duck,
            hasVoice,
            duration: total,
            out: mixed,
            sourceVolume: p!.noSpeech ? 0.8 : 1, // no talking: the clip's own sound (unboxing, clicks) sits a little under the music
          });
          current = mixed;
        }
      } catch (e) {
        notes.push(`Music skipped — ${(e as Error).message}`);
      }
    }
    if (current !== out) fs.renameSync(current, out);

    const thumbOut = path.join(dir, 'clips', `${c.id}_v${version}.jpg`);
    await thumbnail(out, Math.min(1.2, total / 3), thumbOut, 540).catch(() => {});

    // the clip is served from this disk right away; its cloud copy is made in the background (a slow or flaky
    // upload used to hold the clip at "rendering" for a minute — and the storage pass copies any file it misses)
    void Promise.all([saveToCloud(out), saveToCloud(fs.existsSync(thumbOut) ? thumbOut : null)]);
    for (const old of [c.filePath, c.thumbPath])
      if (old && old !== out && old !== thumbOut) {
        fs.rmSync(old, { force: true });
        void removeFromCloud(old);
      }
    const aud = partsScore(p!, parts);
    await clipDb.update(clipId, {
      status: 'ready',
      error: notes.join(' ') || null,
      filePath: out,
      thumbPath: fs.existsSync(thumbOut) ? thumbOut : null,
      outDuration: +total.toFixed(2),
      version,
      reframe: plans.length > 1 ? { ...plans[0], parts: plans } : plans[0],
      ...(aud != null ? { audienceScore: aud } : {}),
    });
    if (p!.status === 'processing') note(p!.id, `Clip ready — “${(c.title || c.hook || '').slice(0, 80)}”`, 'clip');
  } catch (e) {
    console.error(`[clip ${clipId}]`, e);
    await clipDb.update(clipId, { status: 'failed', error: (e as Error).message || String(e) });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Audience score of a (multi-part) clip = length-weighted average of its parts. */
function partsScore(p: ProjectRow, parts: TimeRange[]) {
  let sum = 0;
  let w = 0;
  for (const r of parts) {
    const v = rangeScore(p.signals, p.duration ?? 0, r.start, r.end);
    if (v == null) continue;
    sum += v * (r.end - r.start);
    w += r.end - r.start;
  }
  return w ? Math.round(sum / w) : null;
}

/** `noSpeech`: keep the clip's own sound and every frame (no pause-cutting, emoji or flash-forward — they hang off words). */
function clipDefaults(o: ProjectOptions, noSpeech = false): ClipDefaults {
  if (noSpeech)
    return {
      layout: o.layout,
      captionStyle: o.captionStyle,
      showHook: o.showHook,
      motion: o.motion ?? 'subtle',
      // background music stays on (it's what makes a silent clip watchable), a bit louder, and never ducked —
      // there's no voice to make room for, only the clip's own sound
      music: { track: o.music ?? 'auto', volume: Math.max(o.musicVolume ?? 15, 25), duck: false },
      pace: 'off',
      emoji: false,
      flashForward: false,
    };
  return {
    layout: o.layout,
    captionStyle: o.captionStyle,
    showHook: o.showHook,
    motion: o.motion ?? 'subtle',
    music: { track: o.music ?? 'none', volume: o.musicVolume ?? 15, duck: true },
    pace: o.pace ?? 'natural',
    emoji: o.emoji ?? false,
    flashForward: o.flashForward ?? false,
  };
}

// ---------------- parts picked by hand ----------------
const coveredPath = (dir: string) => path.join(dir, 'work', 'covered.json');
/** Which time ranges have a transcript. null = the whole video. */
function readCovered(dir: string): TimeRange[] | null {
  try {
    return JSON.parse(fs.readFileSync(coveredPath(dir), 'utf8'));
  } catch {
    return null;
  }
}

/** Bumped when older transcripts can't be trusted: before 2 they were made from 8-minute chunks and drifted seconds
 *  (up to minutes) away from the voice. */
const TRANSCRIPT_REV = 2;
const transcriptCurrent = (p: ProjectRow) => (p.transcriptRev ?? 0) >= TRANSCRIPT_REV || Boolean(p.transcript?.some((s) => s.timed));
const MOVE_BAND = 180; // seconds: how far an old transcript's times may be off

const refreshing = new Map<string, Promise<string[]>>();
/**
 * A project transcribed the old way: transcribe it again, and move its AI clips onto the corrected times.
 * Runs once per project however many clips ask; the first caller gets the clips that now need rendering again.
 */
function refreshTranscript(projectId: string): Promise<string[]> {
  const cur = refreshing.get(projectId);
  if (cur) return cur.then(() => []);
  const job = redoTranscript(projectId).finally(() => refreshing.delete(projectId));
  refreshing.set(projectId, job);
  return job;
}

async function redoTranscript(projectId: string): Promise<string[]> {
  const p = await projects.get(projectId);
  if (!p?.transcript?.length || transcriptCurrent(p) || !p.duration) return [];
  console.log(`[project ${projectId}] transcript made the old way — transcribing again`);
  const dir = projectDir(projectId);
  const work = path.join(dir, 'work');
  const old = p.transcript;
  let segs: Segment[];
  const covered = readCovered(dir);
  if (covered) {
    // picked parts: only those were transcribed — do the same parts again
    fs.writeFileSync(coveredPath(dir), '[]');
    await projects.update(projectId, { transcript: [] });
    segs = await ensureTranscript(projectId, covered);
  } else {
    const audio = path.join(work, 'audio.mp3');
    if (!fs.existsSync(audio)) {
      if (!p.mediaPath || !fs.existsSync(p.mediaPath)) return [];
      fs.mkdirSync(work, { recursive: true });
      await extractAudio(p.mediaPath, audio);
    }
    const tr = await transcribe(audio, p.duration, work, () => {}, silencesFor(projectId), p.options.captionLanguage ?? 'auto');
    for (const f of fs.readdirSync(work)) if (f.startsWith('chunk_')) fs.rmSync(path.join(work, f), { force: true });
    if (!tr.segments.length) return [];
    segs = await withMeasuredTimes(tr.segments, p.sourceUrl, dir);
    await projects.update(projectId, { transcript: segs, transcriptRev: TRANSCRIPT_REV });
  }

  // AI clips were cut on the old transcript's clock (so were trims made against its lines); picked parts were not
  const sil = silencesFor(projectId);
  const again: string[] = [];
  for (const c of await clipDb.forProject(projectId)) {
    if (c.source === 'ai') {
      const parts = clipParts(c).map((r) => {
        const m = moveRange(r, old, segs);
        return m ? snapRange(m.start, m.end, segs, sil, p.duration!) : r;
      });
      const t = c.teaser && moveRange(c.teaser, old, segs);
      await clipDb.update(c.id, {
        start: +parts[0].start.toFixed(3),
        end: +parts[parts.length - 1].end.toFixed(3),
        segments: c.segments?.length ? parts.map((r) => ({ start: +r.start.toFixed(3), end: +r.end.toFixed(3) })) : null,
        teaser: t && t.start >= parts[0].start && t.end <= parts[0].end ? { start: +t.start.toFixed(3), end: +t.end.toFixed(3) } : null,
        reframe: null,
      });
    }
    // every clip's captions came from the old times
    if (c.status === 'ready') {
      await clipDb.update(c.id, { status: 'pending' });
      again.push(c.id);
    }
  }
  return again;
}

/** Where a range on one transcript's clock is on another's: the words inside it, found in the other transcript. */
function moveRange(r: TimeRange, from: Segment[], to: Segment[]): TimeRange | null {
  const inside = from.map((s) => ({ ...s, words: s.words.filter((w) => (w.s + w.e) / 2 >= r.start && (w.s + w.e) / 2 <= r.end) })).filter((s) => s.words.length);
  const near = to.filter((s) => s.e > r.start - MOVE_BAND && s.s < r.end + MOVE_BAND).flatMap((s) => s.words);
  const moved = inside.length && near.length ? retimeToWords(inside, near, MOVE_BAND) : null;
  return moved?.length ? { start: moved[0].s, end: moved[moved.length - 1].e } : null;
}

/** The transcript's times moved onto the video's measured word times (YouTube's own speech recognition), if it has them. */
async function withMeasuredTimes(segs: Segment[], url: string | null | undefined, dir: string, range?: TimeRange): Promise<Segment[]> {
  if (!url || !segs.length) return segs;
  try {
    let words = await fetchWordTimings(url, path.join(dir, 'work'), infoJsonPath(dir));
    if (words && range) words = words.filter((w) => w.s >= range.start - 5 && w.s <= range.end + 5);
    return (words?.length && retimeToWords(segs, words)) || segs;
  } catch (e) {
    console.warn('[word timings]', (e as Error).message);
    return segs;
  }
}

/**
 * Caption words for [start, end] of the video (times from `start`; `fileStart` is `start` in `src`'s own time).
 * Measured word times are used as they are; otherwise each phrase is pinned to where talking starts and stops in the
 * audio and its words are spread over the spoken bits.
 */
async function captionWords(segs: Segment[], src: string, fileStart: number, start: number, end: number): Promise<Word[]> {
  const here = segs.filter((s) => s.e > start && s.s < end);
  if (!here.length) return []; // nothing said here (no-speech mode) — no captions
  if (here.length && here.every((s) => s.timed)) return wordsInRange(segs, start, end);
  const gaps = await speechGaps(src, fileStart, end - start).catch(() => null);
  return gaps ? alignPhrases(phrasesInRange(segs, start, end), gaps, end - start) : wordsInRange(segs, start, end);
}

/** Make sure these ranges have a transcript (projects built from picked parts only transcribe what they need). */
async function ensureTranscript(projectId: string, ranges: TimeRange[], onProgress?: (done: number, total: number) => void): Promise<Segment[]> {
  const p = (await projects.get(projectId))!;
  const dir = projectDir(projectId);
  const covered = readCovered(dir);
  const segs = p.transcript ?? [];
  if (covered === null && segs.length) return segs;
  const fresh = !segs.length || transcriptCurrent(p); // nothing older mixed in
  const cov = covered ?? [];
  const missing = ranges.filter((r) => !cov.some((c) => c.start <= r.start + 0.5 && c.end >= r.end - 0.5));
  if (!missing.length) return segs;
  // transcribe outside the lock (several clips do this at once, on different workers), merge under it
  const pieces: { s0: number; e0: number; segs: Segment[] }[] = [];
  for (const [i, r] of missing.entries()) {
    const s0 = Math.max(0, r.start - 1.5);
    const e0 = Math.min(p.duration || r.end + 1.5, r.end + 1.5);
    const foot = await footageFor((await projects.get(projectId)) ?? p, dir, s0, e0);
    const sub = path.join(dir, 'work', `tr_${Math.round(s0)}_${Math.round(e0)}_${process.pid}`);
    fs.mkdirSync(sub, { recursive: true });
    try {
      const audio = path.join(sub, 'audio.mp3');
      await extractAudioRange(foot.src, s0 - foot.offset, e0 - s0, audio);
      const tr = await transcribe(audio, e0 - s0, sub, (d, t) => onProgress?.(i + d / t, missing.length), [], p.options.captionLanguage ?? 'auto');
      const shifted = tr.segments.map((sg) => ({ ...sg, s: sg.s + s0, e: sg.e + s0, words: sg.words.map((w) => ({ ...w, s: w.s + s0, e: w.e + s0 })) }));
      // onto the measured word times (the site's speech recognition) for this stretch, when it has them
      pieces.push({ s0, e0, segs: await withMeasuredTimes(shifted, p.sourceUrl, dir, { start: s0, end: e0 }) });
    } finally {
      fs.rmSync(sub, { recursive: true, force: true });
    }
  }
  const merged = await withClusterLock(
    `transcript:${projectId}`,
    async () => {
      const now = (await projects.get(projectId))!;
      let all = now.transcript ?? [];
      const have = readCovered(dir) ?? [];
      for (const pc of pieces) {
        all = [...all.filter((sg) => sg.e <= pc.s0 || sg.s >= pc.e0), ...pc.segs].sort((a, b) => a.s - b.s);
        have.push({ start: pc.s0, end: pc.e0 });
      }
      await projects.update(projectId, { transcript: all, ...(fresh ? { transcriptRev: TRANSCRIPT_REV } : {}) });
      fs.writeFileSync(coveredPath(dir), JSON.stringify(have));
      return all;
    },
    { wait: true, ttlMs: 60_000 },
  );
  return merged === BUSY ? segs : merged;
}

/** Tidy picked ranges: clamp to the video, merge overlaps, snap to sentence edges. */
function tidyRanges(ranges: TimeRange[], segs: Segment[], sil: { s: number; e: number }[], duration: number): TimeRange[] {
  const sorted = ranges
    .map((r) => ({ start: Math.max(0, Math.min(r.start, r.end)), end: Math.min(duration || Infinity, Math.max(r.start, r.end)) }))
    .filter((r) => r.end - r.start >= 1)
    .sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged.map((r) => {
    if (!segs.length) return r;
    const s = snapRange(r.start, r.end, segs, sil, duration);
    return s.end - s.start >= Math.min(3, (r.end - r.start) * 0.7) ? { start: +s.start.toFixed(3), end: +s.end.toFixed(3) } : r;
  });
}

/** Group ranges into clips (each range its own clip, or all joined into one) and write their packaging with Gemini. */
async function packagePicked(p: ProjectRow, groups: TimeRange[][], segs: Segment[]) {
  const described = await describeClips({
    title: p.title ?? 'Untitled',
    channel: p.channel ?? '',
    options: p.options,
    clips: groups.map((g) => ({ parts: g, segments: segs.filter((s) => g.some((r) => s.e > r.start && s.s < r.end)) })),
  });
  return groups.map((g, i) => {
    const d = described[i];
    const ai = aiScore(d.rubric);
    const aud = partsScore(p, g);
    return {
      ...d,
      start: g[0].start,
      end: g[g.length - 1].end,
      segments: g.length > 1 ? g : null,
      aiScore: ai,
      audienceScore: aud,
      peakScore: aud == null ? ai : Math.round(ai * 0.6 + aud * 0.4),
    };
  });
}

function groupRanges(ranges: TimeRange[], join: boolean): TimeRange[][] {
  const capped: TimeRange[][] = join ? [ranges] : ranges.map((r) => [r]);
  // keep every clip within 3 minutes
  return capped.map((g) => {
    let total = 0;
    const out: TimeRange[] = [];
    for (const r of g) {
      const room = 180 - total;
      if (room < 1) break;
      const e = Math.min(r.end, r.start + room);
      out.push({ start: r.start, end: e });
      total += e - r.start;
    }
    return out;
  });
}

/** Explore → "Clip the parts I picked": fetch only those parts, transcribe them, package + render. */
async function processPickedParts(id: string) {
  const p0 = (await projects.get(id))!;
  const dir = projectDir(id);
  const work = path.join(dir, 'work');
  stage(id, 'fetch', 0, 'Reading the link…');
  const info = await fetchInfo(p0.sourceUrl!, infoJsonPath(dir));
  assertNotLive(info);
  const duration = info.duration || 0;
  await projects.update(id, { title: info.title, channel: info.channel, description: info.description, duration, viewCount: info.viewCount });
  const thumb = path.join(dir, 'thumb.jpg');
  if (info.thumbnail && !fs.existsSync(thumb)) await remoteThumbnail(info.thumbnail, thumb, work).catch(() => {});
  if (fs.existsSync(thumb)) {
    await projects.update(id, { thumbPath: thumb });
    void saveToCloud(thumb);
  }

  const picked = (p0.options.ranges ?? []).map((r) => ({ start: Math.max(0, r.start), end: duration ? Math.min(duration, r.end) : r.end })).filter((r) => r.end - r.start >= 1);
  if (!picked.length) throw new Error('The picked parts are outside this video.');
  // 5 credits per clip: each picked part is a clip (or one clip when they're joined). Only the picked minutes are
  // processed, so they're what the plan's length limit applies to.
  await chargeProject(
    id,
    picked.reduce((a, r) => a + r.end - r.start, 0),
    `Picked parts of “${info.title}”`,
    p0.options.joinRanges ? 1 : picked.length,
  );

  // only the picked parts of the video are downloaded
  if (!readFootage(dir) && !(p0.mediaPath && fs.existsSync(p0.mediaPath))) startSectionMode(dir, info.webpageUrl, info.fullSizeEstimate);
  stage(id, 'fetch', 0.2, 'Downloading only the parts you picked…');
  await prefetchFootage((await projects.get(id))!, dir, picked, (done, total, detail) => stage(id, 'fetch', 0.2 + (done / total) * 0.75, `Downloading only the parts you picked · ${detail}`));
  const first = await footageFor((await projects.get(id))!, dir, picked[0].start, picked[0].end);
  await projects.update(id, { mediaPath: first.src, width: first.width, height: first.height });
  stage(id, 'fetch', 1, 'Parts ready');

  stage(id, 'transcribe', 0, 'Transcribing your parts…');
  const segs = await ensureTranscript(id, picked, (d, t) => stage(id, 'transcribe', d / t, `Transcribing part ${Math.min(t, Math.floor(d) + 1)} of ${t}`));

  stage(id, 'moments', 0.2, 'Writing titles and hooks…');
  const signals: Signals = buildSignals({ duration, heatmap: info.heatmap, chapters: info.chapters, comments: [], rmsPerSecond: null, useAudience: true });
  await projects.update(id, { signals });
  const p = (await projects.get(id))!;
  const ranges = tidyRanges(picked, segs, [], duration);
  const list = await packagePicked(p, groupRanges(ranges, Boolean(p.options.joinRanges)), segs);
  const saved = await clipDb.replaceForProject(id, list, clipDefaults(p.options, Boolean(p.noSpeech)), 'manual');
  await settleProject(id, saved.length, `Picked parts of “${info.title}”`);
  stage(id, 'moments', 1, `${saved.length} clip${saved.length > 1 ? 's' : ''} ready to render`);

  await renderAll(id, saved);
  await progressSaved(id);
  await projects.update(id, { status: 'done', stage: 'done', progress: 100, stageDetail: '' });
}

/** Project page → "clip the parts I selected on the graph". Creates the clips now; `prepare` fills them in. */
export async function createPickedClips(projectId: string, ranges: TimeRange[], join: boolean): Promise<ClipRow[]> {
  const p = await projects.get(projectId);
  if (!p) throw new Error('Project not found');
  const dur = p.duration || Infinity;
  const clean = ranges
    .map((r) => ({ start: Math.max(0, Math.min(r.start, r.end)), end: Math.min(dur, Math.max(r.start, r.end)) }))
    .filter((r) => r.end - r.start >= 1)
    .sort((a, b) => a.start - b.start);
  if (!clean.length) throw new Error('Pick at least one part that is 1 second or longer.');
  const groups = groupRanges(clean, join);
  const rows = groups.map((g, i) => ({
    start: g[0].start,
    end: g[g.length - 1].end,
    segments: g.length > 1 ? g : null,
    title: `Your pick${groups.length > 1 ? ` #${i + 1}` : ''} · ${formatClock(g[0].start)}`,
    hook: '',
    description: '',
    hashtags: [] as string[],
    reason: 'Picked by you on the graph — writing the title and hook…',
    category: 'insight',
    rubric: { hook: 5, standalone: 5, payoff: 5, emotion: 5, shareability: 5, pacing: 5, loop: 5, lengthFit: 5, trend: 5 },
    aiScore: 50,
    audienceScore: partsScore(p, g),
    peakScore: 50,
  }));
  return await clipDb.insert(projectId, rows, clipDefaults(p.options, Boolean(p.noSpeech)), undefined, 'manual');
}

/** Fill in picked clips: transcript for any new part, snap edges, Gemini titles/hooks/scores. Then they're ready to render. */
export async function preparePickedClips(projectId: string, clipIds: string[]) {
  const dir = projectDir(projectId);
  const found = new Map((await clipDb.getMany(clipIds)).map((c) => [c.id, c]));
  const list = clipIds.map((id) => found.get(id)).filter((c): c is ClipRow => Boolean(c));
  if (!list.length) return;
  try {
    const all = list.flatMap((c) => clipParts(c));
    if (readFootage(dir)) await prefetchFootage((await projects.get(projectId))!, dir, all);
    const segs = await ensureTranscript(projectId, all);
    const p = (await projects.get(projectId))!;
    const sil = silencesFor(projectId);
    const groups = list.map((c) => tidyRanges(clipParts(c), segs, sil, p.duration ?? 0));
    const packaged = await packagePicked(p, groups, segs);
    for (const [i, c] of list.entries()) {
      const k = packaged[i];
      await clipDb.update(c.id, {
        start: k.start,
        end: k.end,
        segments: k.segments,
        title: k.title,
        hook: k.hook,
        hooks: k.hooks ?? (k.hook ? [k.hook] : []),
        keywords: k.keywords ?? [],
        description: k.description,
        hashtags: k.hashtags,
        reason: k.reason,
        category: k.category,
        rubric: k.rubric,
        aiScore: k.aiScore,
        peakScore: k.peakScore,
        ...(k.audienceScore != null ? { audienceScore: k.audienceScore } : {}),
      });
    }
  } catch (e) {
    for (const c of list) await clipDb.update(c.id, { status: 'failed', error: `Couldn’t prepare this clip: ${(e as Error).message}` });
    throw e;
  }
}

const formatClock = (t: number) => {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

function silencesFor(projectId: string): { s: number; e: number }[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir(projectId), 'work', 'silences.json'), 'utf8'));
  } catch {
    return [];
  }
}
