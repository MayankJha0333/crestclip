import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { api, type Clip } from '../../lib/api';
import { Button, Segmented } from '../../components/ui';
import { ClipCard } from '../clips/ClipCard';
import { ClipEditor } from '../clips/ClipEditor';
import { track } from '../../lib/analytics';

export type ClipSort = 'peak' | 'ai' | 'audience' | 'time' | 'video';

/** Rank = position by crest score (stays the same whatever the sort). */
export function rankClips(clips: Clip[]) {
  return new Map([...clips].sort((a, b) => b.peakScore - a.peakScore).map((c, i) => [c.id, i + 1]));
}

/** All clips of a project: sort, download all, edit. */
export function ClipList({
  clips,
  sort,
  onSort,
  sorts,
  audienceKind,
  highlight,
  showPart,
  onChanged,
}: {
  clips: Clip[];
  sort: ClipSort;
  onSort: (s: ClipSort) => void;
  sorts: { value: ClipSort; label: string }[];
  audienceKind: 'audience' | 'energy' | 'none';
  highlight?: string | null;
  showPart?: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<Clip | null>(null);
  const rank = useMemo(() => rankClips(clips), [clips]);
  const sorted = useMemo(() => {
    const list = [...clips];
    if (sort === 'ai') return list.sort((a, b) => b.aiScore - a.aiScore);
    if (sort === 'audience') return list.sort((a, b) => (b.audienceScore ?? -1) - (a.audienceScore ?? -1));
    if (sort === 'time') return list.sort((a, b) => a.start - b.start);
    if (sort === 'video') return list.sort((a, b) => (a.part ?? 0) - (b.part ?? 0) || a.start - b.start);
    return list.sort((a, b) => b.peakScore - a.peakScore);
  }, [clips, sort]);
  const ready = clips.filter((c) => c.status === 'ready');

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Sort clips" size="sm" value={sort} onChange={onSort} options={sorts} />
        {ready.length > 1 && (
          <Button
            variant="ink"
            size="sm"
            onClick={() => {
              track('download_all', { clips: ready.length });
              ready.forEach((c, i) => setTimeout(() => window.open(api.downloadUrl(c.id), '_blank'), i * 400));
            }}
          >
            <Download size={16} /> Download all {ready.length}
          </Button>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,520px),1fr))] gap-5">
        {sorted.map((c) => (
          <ClipCard
            key={c.id}
            clip={c}
            rank={rank.get(c.id) ?? 0}
            audienceKind={audienceKind}
            highlighted={highlight === c.id}
            partLabel={showPart ? `Video ${c.part ?? 1}` : undefined}
            onEdit={() => setEditing(c)}
            onChanged={onChanged}
          />
        ))}
      </div>
      {editing && <ClipEditor clip={editing} siblings={clips.filter((c) => c.projectId === editing.projectId)} onClose={() => setEditing(null)} onSaved={onChanged} />}
    </>
  );
}
