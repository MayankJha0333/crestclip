import type {
  AutopilotDetail,
  AutopilotInput,
  AutopilotSource,
  AutopilotSummary,
  Clip,
  Connections,
  DiscoverSection,
  ExploreChannel,
  ExploreItem,
  ExploreSource,
  Health,
  MusicLibrary,
  Peek,
  PostItem,
  Project,
  ProjectOptions,
  SchedulerStatus,
  TimeRange,
} from './types';

/** Every API error is `{ error: "<friendly message>" }` — surface that message. */
async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  return body as T;
}
const json = (method: string, data: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

export const api = {
  health: (refresh = false) => req<Health>(`/api/health${refresh ? '?refresh=1' : ''}`),
  refreshTools: () => req<unknown>('/api/tools/refresh', { method: 'POST' }),
  projects: () => req<Project[]>('/api/projects'),
  project: (id: string) => req<Project>(`/api/projects/${id}`),
  createFromUrl: (url: string, options: ProjectOptions) => req<Project>('/api/projects', json('POST', { url, options })),
  createFromUrls: (urls: string[], options: ProjectOptions) =>
    req<{ project: Project; projects: Project[]; understood: { minSeconds: number | null; maxSeconds: number | null; tags: string[]; rules: string[] } }>(
      '/api/projects/batch',
      json('POST', { urls, options }),
    ),
  retry: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/retry`, { method: 'POST' }),
  remove: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  updateClip: (id: string, patch: Partial<Pick<Clip, 'title' | 'hook' | 'description' | 'hashtags' | 'start' | 'end' | 'layout' | 'captionStyle' | 'showHook' | 'motion' | 'music'>>) =>
    req<Clip>(`/api/clips/${id}`, json('PATCH', patch)),
  connections: () => req<Connections>('/api/connections'),
  connectUrl: (platform: 'youtube' | 'instagram') => `/api/connect/${platform}/start`,
  disconnect: (id: string) => req<{ ok: boolean }>(`/api/connections/${id}`, { method: 'DELETE' }),
  // autopilot
  schedulerStatus: () => req<SchedulerStatus>('/api/autopilot/status'),
  resolveChannel: (input: string) => req<{ channelId: string; label: string; url: string }>('/api/autopilot/resolve-channel', json('POST', { input })),
  previewSource: (s: AutopilotSource & { maxAgeDays?: number }) =>
    req<{ count: number; newest: number | null; sample: { title: string; views: number | null }[] }>('/api/autopilot/preview-source', json('POST', s)),
  autopilots: () => req<AutopilotSummary[]>('/api/autopilots'),
  autopilot: (id: string) => req<AutopilotDetail>(`/api/autopilots/${id}`),
  createAutopilot: (body: AutopilotInput) => req<AutopilotSummary>('/api/autopilots', json('POST', body)),
  updateAutopilot: (id: string, body: AutopilotInput) => req<AutopilotSummary>(`/api/autopilots/${id}`, json('PUT', body)),
  pauseAutopilot: (id: string) => req<AutopilotSummary>(`/api/autopilots/${id}/pause`, { method: 'POST' }),
  resumeAutopilot: (id: string) => req<AutopilotSummary>(`/api/autopilots/${id}/resume`, { method: 'POST' }),
  scanAutopilot: (id: string) => req<{ ok: boolean }>(`/api/autopilots/${id}/scan`, { method: 'POST' }),
  deleteAutopilot: (id: string) => req<{ ok: boolean }>(`/api/autopilots/${id}`, { method: 'DELETE' }),
  skipSlot: (id: string, key: string) => req<{ ok: boolean }>(`/api/autopilots/${id}/slots/${encodeURIComponent(key)}/skip`, { method: 'POST' }),
  restoreSlot: (id: string, key: string) => req<{ ok: boolean }>(`/api/autopilots/${id}/slots/${encodeURIComponent(key)}/restore`, { method: 'POST' }),
  apClip: (id: string, itemId: string, action: 'approve' | 'reject') => req<{ ok: boolean }>(`/api/autopilots/${id}/clips/${itemId}/${action}`, { method: 'POST' }),
  createPosts: (body: { clipId: string; targets: { connectionId: string; title?: string; caption?: string; privacy?: 'public' | 'unlisted' | 'private' }[]; scheduledAt?: number | null }) =>
    req<PostItem[]>('/api/posts', json('POST', body)),
  posts: (clipId?: string) => req<PostItem[]>(`/api/posts${clipId ? `?clipId=${encodeURIComponent(clipId)}` : ''}`),
  retryPost: (id: string) => req<PostItem>(`/api/posts/${id}/retry`, { method: 'POST' }),
  cancelPost: (id: string) => req<PostItem>(`/api/posts/${id}/cancel`, { method: 'POST' }),
  addClips: (projectId: string, ranges: TimeRange[], join: boolean) => req<Clip[]>(`/api/projects/${projectId}/clips`, json('POST', { ranges, join })),
  music: () => req<MusicLibrary>('/api/music'),
  makeMood: (id: string, fresh = false) => req<MusicLibrary>(`/api/music/moods/${id}${fresh ? '?fresh=1' : ''}`, { method: 'POST' }),
  removeMusic: (id: string) => req<MusicLibrary>(`/api/music/uploads/${id}`, { method: 'DELETE' }),
  async uploadMusic(file: File): Promise<MusicLibrary & { added: string }> {
    const fd = new FormData();
    fd.append('file', file);
    return req<MusicLibrary & { added: string }>('/api/music/uploads', { method: 'POST', body: fd });
  },
  rerender: (id: string) => req<Clip>(`/api/clips/${id}/render`, { method: 'POST' }),
  variant: (id: string) => req<Clip>(`/api/clips/${id}/variant`, { method: 'POST' }),
  transcript: (id: string) => req<{ start: number; end: number; duration: number; segments: { s: number; e: number; text: string; speaker?: string }[] }>(`/api/clips/${id}/transcript`),
  downloadUrl: (id: string) => `/api/clips/${id}/download`,
  exploreSearch: (p: Record<string, string>) => req<{ items: ExploreItem[]; twitchApi: boolean }>(`/api/explore/search?${new URLSearchParams(p)}`),
  exploreChannel: (url: string, tab: string) => req<{ channel: ExploreChannel; items: ExploreItem[] }>(`/api/explore/channel?${new URLSearchParams({ url, tab })}`),
  peek: (url: string) => req<Peek>(`/api/explore/peek?${new URLSearchParams({ url })}`),
  exploreDiscover: (source: ExploreSource, category: string) => req<{ sections: DiscoverSection[] }>(`/api/explore/discover?${new URLSearchParams({ source, category })}`),
  exploreCategories: () => req<{ youtube: { id: string; label: string }[]; twitch: string[] }>('/api/explore/categories'),

  /** Upload with progress (fetch has no upload progress, so XHR). */
  upload(file: File, options: ProjectOptions, onProgress: (pct: number, loaded: number, total: number) => void, signal?: AbortSignal): Promise<Project> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      signal?.addEventListener('abort', () => {
        xhr.abort();
        reject(new Error('Upload cancelled'));
      });
      const fd = new FormData();
      fd.append('options', JSON.stringify(options));
      fd.append('file', file);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress((e.loaded / e.total) * 100, e.loaded, e.total);
      xhr.onload = () => {
        let body: { error?: string } = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* ignore */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as Project);
        else reject(new Error(body.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed — is the CrestClip server running?'));
      xhr.open('POST', '/api/projects/upload');
      xhr.send(fd);
    });
  },
};
