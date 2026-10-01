import { db, newId, now, parse, type Raw } from './connection.js';
import type { ProjectOptions, Segment, Signals } from '../types.js';

export interface ProjectRow {
  id: string;
  createdAt: number;
  updatedAt: number;
  sourceType: 'url' | 'upload' | 'group';
  sourceUrl: string | null;
  title: string | null;
  channel: string | null;
  description: string | null;
  /** set when this video is part of a multi-video project */
  parentId: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  viewCount: number | null;
  status: 'queued' | 'processing' | 'done' | 'failed';
  stage: string | null;
  stageDetail: string | null;
  progress: number;
  error: string | null;
  options: ProjectOptions;
  signals: Signals | null;
  transcript: Segment[] | null;
  mediaPath: string | null;
  thumbPath: string | null;
  aiNotes: string | null;
}

function toProject(r: Raw): ProjectRow {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    sourceType: r.source_type as ProjectRow['sourceType'],
    sourceUrl: (r.source_url as string) ?? null,
    parentId: (r.parent_id as string) ?? null,
    title: (r.title as string) ?? null,
    channel: (r.channel as string) ?? null,
    description: (r.description as string) ?? null,
    duration: (r.duration as number) ?? null,
    width: (r.width as number) ?? null,
    height: (r.height as number) ?? null,
    viewCount: (r.view_count as number) ?? null,
    status: r.status as ProjectRow['status'],
    stage: (r.stage as string) ?? null,
    stageDetail: (r.stage_detail as string) ?? null,
    progress: (r.progress as number) ?? 0,
    error: (r.error as string) ?? null,
    options: parse(r.options_json, {} as ProjectOptions),
    signals: parse(r.signals_json, null),
    transcript: parse(r.transcript_json, null),
    mediaPath: (r.media_path as string) ?? null,
    thumbPath: (r.thumb_path as string) ?? null,
    aiNotes: (r.ai_notes as string) ?? null,
  };
}

export const projects = {
  create(p: { sourceType: 'url' | 'upload' | 'group'; sourceUrl?: string; title?: string; options: ProjectOptions; parentId?: string | null }) {
    const id = newId();
    // a group only holds its videos; its status is worked out from them
    const status = p.sourceType === 'group' ? 'done' : 'queued';
    db.prepare(
      `INSERT INTO projects (id, created_at, updated_at, source_type, source_url, title, options_json, status, stage, progress, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(id, now(), now(), p.sourceType, p.sourceUrl ?? null, p.title ?? null, JSON.stringify(p.options), status, status, p.parentId ?? null);
    return this.get(id)!;
  },
  get(id: string): ProjectRow | null {
    const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Raw | undefined;
    return r ? toProject(r) : null;
  },
  list(): (ProjectRow & { clipCount: number; readyCount: number; bestScore: number | null })[] {
    const rows = db
      .prepare(
        `SELECT p.id, p.created_at, p.updated_at, p.source_type, p.source_url, p.title, p.channel, p.duration, p.width, p.height,
                p.view_count, p.status, p.stage, p.stage_detail, p.progress, p.error, p.options_json, p.thumb_path, p.parent_id,
                (SELECT COUNT(*) FROM clips c WHERE c.project_id = p.id) AS clip_count,
                (SELECT COUNT(*) FROM clips c WHERE c.project_id = p.id AND c.status='ready') AS ready_count,
                (SELECT MAX(peak_score) FROM clips c WHERE c.project_id = p.id) AS best_score
         FROM projects p WHERE p.parent_id IS NULL ORDER BY created_at DESC`,
      )
      .all() as Raw[];
    return rows.map((r) => ({
      ...toProject(r),
      clipCount: r.clip_count as number,
      readyCount: r.ready_count as number,
      bestScore: (r.best_score as number) ?? null,
    }));
  },
  update(id: string, patch: Partial<Omit<ProjectRow, 'id' | 'createdAt'>>) {
    const map: Record<string, [string, (v: unknown) => unknown]> = {
      sourceUrl: ['source_url', (v) => v],
      title: ['title', (v) => v],
      channel: ['channel', (v) => v],
      description: ['description', (v) => v],
      duration: ['duration', (v) => v],
      width: ['width', (v) => v],
      height: ['height', (v) => v],
      viewCount: ['view_count', (v) => v],
      status: ['status', (v) => v],
      stage: ['stage', (v) => v],
      stageDetail: ['stage_detail', (v) => v],
      progress: ['progress', (v) => v],
      error: ['error', (v) => v],
      options: ['options_json', (v) => JSON.stringify(v)],
      signals: ['signals_json', (v) => JSON.stringify(v)],
      transcript: ['transcript_json', (v) => JSON.stringify(v)],
      mediaPath: ['media_path', (v) => v],
      thumbPath: ['thumb_path', (v) => v],
      aiNotes: ['ai_notes', (v) => v],
    };
    const sets: string[] = ['updated_at = ?'];
    const vals: unknown[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m) continue;
      sets.push(`${m[0]} = ?`);
      vals.push(v === undefined ? null : m[1](v));
    }
    vals.push(id);
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  },
  remove(id: string) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  },
  /** the videos inside a multi-video project, in the order they were added */
  children(parentId: string): ProjectRow[] {
    return (db.prepare('SELECT * FROM projects WHERE parent_id = ? ORDER BY created_at, rowid').all(parentId) as Raw[]).map(toProject);
  },
  unfinished(): ProjectRow[] {
    return (db.prepare(`SELECT * FROM projects WHERE status IN ('queued','processing') ORDER BY created_at`).all() as Raw[]).map(
      toProject,
    );
  },
};
