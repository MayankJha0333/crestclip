import { db, newId, now, parse, type Raw } from './connection.js';
import type { ClipCandidate, Keyword, Motion, MusicSettings, Pace, ReframePlan, Rubric, TimeRange } from '../types.js';

export interface ClipRow {
  id: string;
  projectId: string;
  idx: number;
  createdAt: number;
  updatedAt: number;
  start: number;
  end: number;
  title: string;
  hook: string;
  description: string;
  hashtags: string[];
  reason: string;
  category: string;
  rubric: Rubric | null;
  aiScore: number;
  audienceScore: number | null;
  peakScore: number;
  layout: string;
  captionStyle: string;
  showHook: boolean;
  status: 'pending' | 'rendering' | 'ready' | 'failed';
  error: string | null;
  filePath: string | null;
  thumbPath: string | null;
  reframe: ReframePlan | null;
  version: number;
  /** null = one continuous part (start..end) */
  segments: TimeRange[] | null;
  motion: Motion;
  music: MusicSettings;
  source: 'ai' | 'manual';
  pace: Pace;
  hooks: string[];
  keywords: Keyword[];
  teaser: TimeRange | null;
  emoji: boolean;
  flashForward: boolean;
  /** length of the rendered video; null until rendered */
  outDuration: number | null;
}

const DEFAULT_MUSIC: MusicSettings = { track: 'none', volume: 15, duck: true };

function toClip(r: Raw): ClipRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    idx: r.idx as number,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    start: r.start as number,
    end: r.end as number,
    title: (r.title as string) ?? '',
    hook: (r.hook as string) ?? '',
    description: (r.description as string) ?? '',
    hashtags: parse(r.hashtags_json, [] as string[]),
    reason: (r.reason as string) ?? '',
    category: (r.category as string) ?? '',
    rubric: parse(r.rubric_json, null),
    aiScore: (r.ai_score as number) ?? 0,
    audienceScore: (r.audience_score as number) ?? null,
    peakScore: (r.peak_score as number) ?? 0,
    layout: (r.layout as string) ?? 'auto',
    captionStyle: (r.caption_style as string) ?? 'pop',
    showHook: Boolean(r.show_hook),
    status: r.status as ClipRow['status'],
    error: (r.error as string) ?? null,
    filePath: (r.file_path as string) ?? null,
    thumbPath: (r.thumb_path as string) ?? null,
    reframe: parse(r.reframe_json, null),
    version: (r.version as number) ?? 0,
    segments: parse(r.segments_json, null),
    motion: ((r.motion as string) || 'subtle') as Motion,
    music: { ...DEFAULT_MUSIC, ...parse(r.music_json, {} as Partial<MusicSettings>) },
    source: ((r.source as string) || 'ai') as 'ai' | 'manual',
    pace: ((r.pace as string) || 'off') as Pace,
    hooks: parse(r.hooks_json, [] as string[]),
    keywords: parse(r.keywords_json, [] as Keyword[]),
    teaser: parse(r.teaser_json, null),
    emoji: Boolean(r.emoji),
    flashForward: Boolean(r.flash),
    outDuration: (r.out_duration as number) ?? null,
  };
}

export interface ClipDefaults {
  layout: string;
  captionStyle: string;
  showHook: boolean;
  motion: Motion;
  music: MusicSettings;
  pace: Pace;
  emoji: boolean;
  flashForward: boolean;
}
export const clips = {
  replaceForProject(projectId: string, list: (ClipCandidate & { aiScore: number; audienceScore: number | null; peakScore: number })[], defaults: ClipDefaults, source: 'ai' | 'manual' = 'ai') {
    db.prepare('DELETE FROM clips WHERE project_id = ?').run(projectId);
    this.insert(projectId, list, defaults, 0, source);
    return this.forProject(projectId);
  },
  /** Add clips (keeps existing ones). Returns the new rows. */
  insert(
    projectId: string,
    list: (ClipCandidate & { aiScore: number; audienceScore: number | null; peakScore: number; segments?: TimeRange[] | null })[],
    defaults: ClipDefaults,
    startIdx?: number,
    source: 'ai' | 'manual' = 'ai',
  ): ClipRow[] {
    const maxIdx = (db.prepare('SELECT MAX(idx) AS m FROM clips WHERE project_id = ?').get(projectId) as Raw).m as number | null;
    const base = startIdx ?? (maxIdx ?? -1) + 1;
    const stmt = db.prepare(
      `INSERT INTO clips (id, project_id, idx, created_at, updated_at, start, end, title, hook, description, hashtags_json,
        reason, category, rubric_json, ai_score, audience_score, peak_score, layout, caption_style, show_hook, status,
        segments_json, motion, music_json, source, pace, hooks_json, keywords_json, teaser_json, emoji, flash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: string[] = [];
    list.forEach((c, j) => {
      const i = base + j;
      const id = newId();
      ids.push(id);
      stmt.run(
        id,
        projectId,
        i,
        now(),
        now(),
        c.start,
        c.end,
        c.title,
        c.hook,
        c.description,
        JSON.stringify(c.hashtags),
        c.reason,
        c.category,
        JSON.stringify(c.rubric),
        c.aiScore,
        c.audienceScore,
        c.peakScore,
        defaults.layout,
        defaults.captionStyle,
        defaults.showHook ? 1 : 0,
        c.segments && c.segments.length > 1 ? JSON.stringify(c.segments) : null,
        defaults.motion,
        JSON.stringify(defaults.music),
        source,
        defaults.pace,
        JSON.stringify(c.hooks?.length ? c.hooks : c.hook ? [c.hook] : []),
        JSON.stringify(c.keywords ?? []),
        c.teaser ? JSON.stringify(c.teaser) : null,
        defaults.emoji ? 1 : 0,
        defaults.flashForward && c.teaser ? 1 : 0,
      );
    });
    return ids.map((id) => this.get(id)!).filter(Boolean);
  },
  /** every rendered clip (for copying older clips to the cloud) */
  allReady(): ClipRow[] {
    return (db.prepare("SELECT * FROM clips WHERE status = 'ready' AND file_path IS NOT NULL").all() as Raw[]).map(toClip);
  },
  forProject(projectId: string): ClipRow[] {
    return (db.prepare('SELECT * FROM clips WHERE project_id = ? ORDER BY peak_score DESC, idx').all(projectId) as Raw[]).map(toClip);
  },
  get(id: string): ClipRow | null {
    const r = db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as Raw | undefined;
    return r ? toClip(r) : null;
  },
  update(id: string, patch: Partial<Omit<ClipRow, 'id' | 'projectId' | 'createdAt'>>) {
    const map: Record<string, [string, (v: unknown) => unknown]> = {
      start: ['start', (v) => v],
      end: ['end', (v) => v],
      title: ['title', (v) => v],
      hook: ['hook', (v) => v],
      description: ['description', (v) => v],
      hashtags: ['hashtags_json', (v) => JSON.stringify(v)],
      layout: ['layout', (v) => v],
      captionStyle: ['caption_style', (v) => v],
      showHook: ['show_hook', (v) => (v ? 1 : 0)],
      status: ['status', (v) => v],
      error: ['error', (v) => v],
      filePath: ['file_path', (v) => v],
      thumbPath: ['thumb_path', (v) => v],
      reframe: ['reframe_json', (v) => JSON.stringify(v)],
      version: ['version', (v) => v],
      audienceScore: ['audience_score', (v) => v],
      peakScore: ['peak_score', (v) => v],
      aiScore: ['ai_score', (v) => v],
      category: ['category', (v) => v],
      reason: ['reason', (v) => v],
      rubric: ['rubric_json', (v) => JSON.stringify(v)],
      segments: ['segments_json', (v) => JSON.stringify(v)],
      motion: ['motion', (v) => v],
      music: ['music_json', (v) => JSON.stringify(v)],
      pace: ['pace', (v) => v],
      hooks: ['hooks_json', (v) => JSON.stringify(v)],
      keywords: ['keywords_json', (v) => JSON.stringify(v)],
      teaser: ['teaser_json', (v) => JSON.stringify(v)],
      emoji: ['emoji', (v) => (v ? 1 : 0)],
      flashForward: ['flash', (v) => (v ? 1 : 0)],
      outDuration: ['out_duration', (v) => v],
    };
    const sets: string[] = ['updated_at = ?'];
    const vals: unknown[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m) continue;
      sets.push(`${m[0]} = ?`);
      vals.push(v === undefined || v === null ? null : m[1](v));
    }
    vals.push(id);
    db.prepare(`UPDATE clips SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  },
  unfinished(): ClipRow[] {
    return (db.prepare(`SELECT * FROM clips WHERE status IN ('pending','rendering')`).all() as Raw[]).map(toClip);
  },
  /** Copy a clip (same moment) with a different look — posting variations avoids duplicate-content flags. */
  duplicate(id: string, o: { captionStyle: string; titleSuffix: string }): ClipRow | null {
    const c = this.get(id);
    if (!c) return null;
    const nid = newId();
    const maxIdx = (db.prepare('SELECT MAX(idx) AS m FROM clips WHERE project_id = ?').get(c.projectId) as Raw).m as number;
    db.prepare(
      `INSERT INTO clips (id, project_id, idx, created_at, updated_at, start, end, title, hook, description, hashtags_json, reason, category,
        rubric_json, ai_score, audience_score, peak_score, layout, caption_style, show_hook, status, reframe_json, segments_json, motion, music_json, source,
        pace, hooks_json, keywords_json, teaser_json, emoji, flash)
       SELECT ?, project_id, ?, ?, ?, start, end, title || ?, hook, description, hashtags_json, reason, category, rubric_json, ai_score,
        audience_score, peak_score - 0.01, layout, ?, show_hook, 'pending', reframe_json, segments_json, motion, music_json, source,
        pace, hooks_json, keywords_json, teaser_json, emoji, flash FROM clips WHERE id = ?`,
    ).run(nid, (maxIdx ?? 0) + 1, now(), now(), o.titleSuffix, o.captionStyle, id);
    return this.get(nid);
  },
};
