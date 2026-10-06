import { useState } from 'react';
import { CalendarClock, ChevronDown, Combine, Copy, Download, ExternalLink, Hand, Music, Pencil, RefreshCw, Send, Sparkles } from 'lucide-react';
import { api, type Clip } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtTime } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Badge, Button, buttonClass, Menu } from '../../components/ui';
import { ScoreRing } from '../../components/brand/ScoreRing';
import { postLabel, SOCIAL, TONE_BADGE } from '../schedule/postStatus';
import { ClipVideo } from './ClipVideo';
import { PublishDialog } from './PublishDialog';
import { CATEGORY_TONE, RubricBars, scoreDrivers } from './scoreBits';
import { track } from '../../lib/analytics';

/**
 * One clip: the video, why it was picked, and what you can do with it.
 * Main actions stay visible (Download, Post, Edit); the rest live in the "More" menu.
 */
export function ClipCard({
  clip,
  rank,
  audienceKind,
  highlighted,
  partLabel,
  onEdit,
  onChanged,
}: {
  clip: Clip;
  rank: number;
  audienceKind: 'audience' | 'energy' | 'none';
  highlighted?: boolean;
  partLabel?: string;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [why, setWhy] = useState(false);
  const [detail, setDetail] = useState(false);
  const [posting, setPosting] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = clip.status === 'pending' || clip.status === 'rendering';
  const ready = clip.status === 'ready' && Boolean(clip.videoUrl);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const copyPost = () =>
    navigator.clipboard
      .writeText(`${clip.title}\n\n${clip.description}\n\n${clip.hashtags.join(' ')}`.trim())
      .then(() => toast('Title, caption and hashtags copied'))
      .catch(() => toast('Your browser blocked copying', 'error'));

  return (
    <article
      id={`clip-${clip.id}`}
      className={cn(
        'grid animate-pop-in gap-5 rounded-[26px] bg-surface p-4 shadow-clay transition-shadow sm:grid-cols-[170px_minmax(0,1fr)] sm:gap-4 sm:p-5',
        highlighted && 'shadow-[0_0_0_4px_var(--mint),var(--shadow-clay)]',
      )}
      style={{ animationDelay: `${Math.min(rank, 8) * 50}ms` }}
    >
      <ClipVideo clip={clip} rank={rank} className="mx-auto max-w-[240px] sm:max-w-none" />

      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-start gap-3">
          <ScoreRing value={clip.peakScore} size={52} />
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {partLabel && <Badge tone="ink">{partLabel}</Badge>}
              <Badge tone={CATEGORY_TONE[clip.category] ?? 'sky'} className="capitalize">
                {clip.category}
              </Badge>
              <Badge>
                {clip.segments?.length ? (
                  <>
                    <Combine size={12} /> {clip.segments.length} parts
                  </>
                ) : (
                  `${fmtTime(clip.start)}–${fmtTime(clip.end)}`
                )}{' '}
                · {Math.round(clip.duration)}s
              </Badge>
              {clip.source === 'manual' && (
                <Badge title="You picked this part on the graph">
                  <Hand size={12} /> Your pick
                </Badge>
              )}
              {clip.music && clip.music.track !== 'none' && (
                <Badge title="Background music">
                  <Music size={12} /> {clip.music.track === 'auto' ? 'Auto' : clip.music.track.startsWith('upload:') ? 'Your track' : clip.music.track}
                </Badge>
              )}
            </div>
            <h3 className="text-lg leading-snug">{clip.title}</h3>
          </div>
        </div>

        {clip.hook && (
          <p className="flex items-baseline gap-1.5 rounded-xl bg-warn-bg px-3 py-2 text-[15px] font-extrabold">
            <Sparkles size={15} className="shrink-0 translate-y-0.5" /> “{clip.hook}”
          </p>
        )}
        <p className="line-clamp-3 text-[15px] text-ink-2">{clip.reason}</p>
        {clip.error && <p className="text-sm font-bold text-bad">{clip.error}</p>}

        {clip.posts && clip.posts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {clip.posts.slice(0, 4).map((p) => {
              const L = postLabel(p);
              const Icon = SOCIAL[p.platform].Icon;
              const inner = (
                <>
                  <Icon size={12} /> {L.text}
                  {p.remoteUrl && <ExternalLink size={11} />}
                </>
              );
              return p.remoteUrl ? (
                <a key={p.id} href={p.remoteUrl} target="_blank" rel="noreferrer" title={p.error ?? undefined} className="no-underline">
                  <Badge tone={TONE_BADGE[L.tone]}>{inner}</Badge>
                </a>
              ) : (
                <Badge key={p.id} tone={TONE_BADGE[L.tone]} title={p.error ?? undefined}>
                  {inner}
                </Badge>
              );
            })}
          </div>
        )}

        <div>
          <button type="button" onClick={() => setWhy((o) => !o)} aria-expanded={why} className="inline-flex items-center gap-1 text-sm font-extrabold text-ink-2 hover:text-ink">
            Why this score <ChevronDown size={15} className={cn('transition-transform', why && 'rotate-180')} />
          </button>
          {why && (
            <div className="mt-3 flex flex-col gap-3">
              {clip.rubric && (
                <div className="flex flex-col gap-1.5 text-sm">
                  {scoreDrivers(clip.rubric).strong.length > 0 && (
                    <p className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-bold text-ink-3">Works:</span>
                      {scoreDrivers(clip.rubric).strong.map((d) => (
                        <Badge key={d} tone="good">
                          {d}
                        </Badge>
                      ))}
                      {clip.audienceScore != null && audienceKind === 'audience' && clip.audienceScore >= 70 && <Badge tone="orange">Rewatched more than {clip.audienceScore}% of the video</Badge>}
                    </p>
                  )}
                  {(clip.weakest || scoreDrivers(clip.rubric).weak) && (
                    <p className="text-ink-2">
                      <span className="text-xs font-bold text-ink-3">Holding it back: </span>
                      {clip.weakest ?? scoreDrivers(clip.rubric).weak}
                    </p>
                  )}
                </div>
              )}
              <button type="button" onClick={() => setDetail((o) => !o)} aria-expanded={detail} className="self-start text-xs font-extrabold text-ink-3 hover:text-ink">
                {detail ? 'Hide the numbers' : 'See the numbers'}
              </button>
              {detail && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-xl bg-row px-3 py-2 shadow-flat">
                      <span className="block text-xs font-bold text-ink-3">Clip quality (AI judge)</span>
                      <b className="font-display text-xl">{clip.aiScore}</b>
                    </div>
                    <div className="rounded-xl bg-row px-3 py-2 shadow-flat">
                      <span className="block text-xs font-bold text-ink-3">{audienceKind === 'audience' ? 'Rewatched more than' : 'Energy vs. the rest'}</span>
                      <b className="font-display text-xl">{clip.audienceScore == null ? '—' : audienceKind === 'audience' ? `${clip.audienceScore}% of video` : `${clip.audienceScore}/100`}</b>
                    </div>
                  </div>
                  {clip.rubric && <RubricBars rubric={clip.rubric} />}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3.5 sm:col-span-2">
        {ready && (
          <a className={buttonClass('primary', 'sm')} href={api.downloadUrl(clip.id)} onClick={() => track('download_clip')}>
            <Download size={16} /> Download
          </a>
        )}
        {ready && (
          <Button variant="ink" size="sm" onClick={() => setPosting(true)} title="Post now or schedule to YouTube / Instagram">
            {clip.posts?.some((p) => p.status === 'scheduled') ? <CalendarClock size={16} /> : <Send size={16} />} Post
          </Button>
        )}
        {clip.status === 'failed' && (
          <Button variant="primary" size="sm" loading={busy} onClick={() => act(() => api.rerender(clip.id))}>
            <RefreshCw size={16} /> Try again
          </Button>
        )}
        <Button size="sm" onClick={onEdit} disabled={working}>
          <Pencil size={16} /> Edit
        </Button>
        <Menu
          items={[
            { label: 'Copy title & caption', icon: <Copy size={15} />, onSelect: copyPost },
            {
              label: 'Make a variant',
              icon: <Sparkles size={15} />,
              disabled: busy || working,
              title: 'Same moment, next caption style — post variations without duplicate-content flags',
              onSelect: () => act(() => api.variant(clip.id), 'Making a variant with a new caption style…'),
            },
            {
              label: 'Render again',
              icon: <RefreshCw size={15} />,
              disabled: busy || working,
              title: 'Rebuild this clip with your current watermark',
              onSelect: () => act(() => api.rerender(clip.id), 'Rendering again with your current watermark…'),
            },
          ]}
        />
      </div>
      {posting && <PublishDialog clip={clip} onClose={() => setPosting(false)} onDone={onChanged} />}
    </article>
  );
}
