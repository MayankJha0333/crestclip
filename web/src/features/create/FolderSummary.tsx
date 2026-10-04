import { useEffect, useState } from 'react';
import { AlertTriangle, FileText, Film, FolderOpen, Image, Layers, Sparkles } from 'lucide-react';
import { api, type FolderPreview } from '../../lib/api';
import { Badge, Spinner } from '../../components/ui';

export type FolderState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: FolderPreview };

/** Look inside a pasted Drive folder link (waits a moment while the link is still being typed). */
export function useFolderPreview(url: string | null): FolderState {
  const [state, setState] = useState<FolderState>({ status: 'idle' });
  useEffect(() => {
    if (!url) return setState({ status: 'idle' });
    setState({ status: 'loading' });
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api
        .folderPreview(url, ctrl.signal)
        .then((data) => setState({ status: 'ready', data }))
        .catch((e: Error) => {
          if (!ctrl.signal.aborted) setState({ status: 'error', message: e.message });
        });
    }, 400);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [url]);
  return state;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What's in the folder and what the AI will do with it — shown before anything is spent. */
export function FolderSummary({ state, mixed }: { state: FolderState; mixed: boolean }) {
  if (mixed)
    return (
      <p className="mt-3 flex items-start gap-2 rounded-2xl bg-warn-bg px-3.5 py-2.5 text-[13px] font-bold text-warn-ink">
        <AlertTriangle size={15} className="mt-px shrink-0" />A Drive folder link goes on its own — remove the other links, or clip them in a separate project.
      </p>
    );
  if (state.status === 'idle') return null;
  if (state.status === 'loading')
    return (
      <p className="mt-3 flex items-center gap-2 rounded-2xl bg-row px-3.5 py-3 text-[13px] font-bold text-ink-2 shadow-flat">
        <Spinner className="size-4 border-2" /> Looking inside the folder…
      </p>
    );
  if (state.status === 'error')
    return (
      <p className="mt-3 flex items-start gap-2 rounded-2xl bg-bad-bg px-3.5 py-2.5 text-[13px] font-bold text-bad-ink">
        <AlertTriangle size={15} className="mt-px shrink-0" />
        {state.message}
      </p>
    );

  const f = state.data;
  return (
    <div className="mt-3 rounded-[22px] bg-row p-4 shadow-flat">
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl clay-butter text-[#3d2a00]">
          <FolderOpen size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <b className="block truncate font-display text-lg leading-6">{f.name}</b>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge tone={f.videos ? 'good' : 'bad'}>
              <Film size={12} /> {plural(f.videos, 'video')}
            </Badge>
            {f.duplicates > 0 && (
              <Badge title="The same take saved twice (for example 16x9 and 9x16) — only one is clipped">{plural(f.duplicates, 'repeat', 'repeats')} left out</Badge>
            )}
            <Badge tone={f.docs.length ? 'info' : 'neutral'} title={f.docs.join('\n') || undefined}>
              <FileText size={12} /> {f.docs.length ? plural(f.docs.length, 'brief file') : 'No brief file'}
            </Badge>
            {f.images > 0 && (
              <Badge title="Images give the AI context but aren’t clipped">
                <Image size={12} /> {plural(f.images, 'image')}
              </Badge>
            )}
            {f.subfolders.length > 0 && (
              <Badge title={f.subfolders.join(', ')}>
                <Layers size={12} /> {plural(f.subfolders.length, 'subfolder')}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {f.videos > 0 ? (
        <p className="mt-3 flex items-start gap-2 text-[13px] text-ink-2">
          <Sparkles size={15} className="mt-px shrink-0 text-tangerine" />
          <span>
            The AI reads {f.docs.length ? 'the brief, ' : ''}the folder and file names{f.docs.length ? '' : ' and your instructions below'}, then picks{' '}
            <b>{f.videos > f.willClip ? `the best ${f.willClip}` : f.willClip === 1 ? 'the video' : `all ${f.willClip}`}</b>
            {f.videos > f.willClip ? ` of ${f.videos} videos (your plan holds ${f.max} per project)` : ''} to clip.
            {!f.docs.length && ' Tell it below what the clips are for — it helps a lot.'}
          </span>
        </p>
      ) : (
        <p className="mt-3 text-[13px] font-bold text-bad-ink">There are no videos in this folder or its subfolders.</p>
      )}
      {f.truncated && <p className="mt-1.5 text-xs text-ink-3">This folder is very big — only the first part of it was read.</p>}
    </div>
  );
}
