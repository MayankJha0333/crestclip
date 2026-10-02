import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { AudioLines, Combine, Flame, MessageSquareText, MousePointerClick, Play, Scissors, Tv } from 'lucide-react';
import { api, type Project, type TimeRange } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtTime } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Badge, Button, Card, CardHeader } from '../../components/ui';
import { HeatChart, PickBar } from '../media/HeatChart';
import { SourcePlayer, youtubeIdOf, type PlayerHandle } from '../media/SourcePlayer';
import { useAccount, useAuth } from '../auth/auth';

export const canWatchSource = (p: Project) => Boolean(youtubeIdOf(p.sourceUrl) || p.sourceVideoUrl || /twitch\.tv\/videos\//.test(p.sourceUrl ?? ''));

export interface SourceTabHandle {
  play: (t: number) => void;
}

/**
 * The original video: watch it, jump to each clip's moment, see where viewers rewatch,
 * and drag on the graph to make clips from parts you choose.
 */
export const SourceTab = forwardRef<SourceTabHandle, { p: Project; rank: Map<string, number>; onOpenClip: (id: string) => void; onClipsAdded: (firstId?: string) => void }>(function SourceTab(
  { p, rank, onOpenClip, onClipsAdded },
  ref,
) {
  const player = useRef<PlayerHandle>(null);
  const [playT, setPlayT] = useState<number | null>(null);
  const [picks, setPicks] = useState<TimeRange[]>([]);
  const [adding, setAdding] = useState(false);
  const perClip = useAccount().credits.perClip;
  const { refresh } = useAuth();
  // the player reports time several times a second — only re-render when it moved noticeably
  const onTime = useCallback((t: number) => setPlayT((prev) => (prev == null || Math.abs(prev - t) >= 0.5 ? t : prev)), []);
  useImperativeHandle(ref, () => ({ play: (t) => player.current?.playFrom(t) }), []);

  const clips = p.clips ?? [];
  const byTime = [...clips].sort((a, b) => a.start - b.start);
  const canWatch = canWatchSource(p);
  const canPick = p.status === 'done' || p.status === 'failed';
  const sig = p.signals;
  const nowClip = playT == null ? null : byTime.find((c) => (c.segments?.length ? c.segments : [c]).some((r) => playT >= r.start && playT <= r.end));

  const addPicked = async (join: boolean) => {
    setAdding(true);
    try {
      const made = await api.addClips(p.id, picks, join);
      toast(join ? 'Joining your parts into one clip…' : `Making ${made.length} clip${made.length > 1 ? 's' : ''} from your picks…`);
      setPicks([]);
      onClipsAdded(made[0]?.id);
      refresh(); // credits changed
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {canWatch && (
        <Card className="p-5">
          <CardHeader
            icon={<Tv size={20} />}
            title="Watch the original"
            actions={
              <span className="text-[13px] font-extrabold text-ink-3">
                {playT != null ? `▶ ${fmtTime(playT)}${nowClip ? ` · inside clip #${rank.get(nowClip.id)}` : ''}` : 'Pick a moment to jump there'}
              </span>
            }
          />
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(260px,1fr)]">
            <SourcePlayer
              ref={player}
              sourceUrl={p.sourceUrl}
              fileUrl={p.sourceVideoUrl ?? null}
              poster={p.thumbUrl}
              vertical={Boolean(p.width && p.height && p.height > p.width)}
              title={p.title ?? 'Original video'}
              onTime={onTime}
            />
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <b className="font-display">Moments</b>
                <span className="text-xs font-bold text-ink-3">{byTime.length ? `${byTime.length} clips, in order` : 'No clips yet'}</span>
              </div>
              <div role="list" className="flex max-h-[420px] flex-col gap-2 overflow-y-auto p-1">
                {byTime.map((c) => {
                  const first = c.segments?.length ? c.segments[0] : { start: c.start, end: c.end };
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="listitem"
                      title="Play this moment in the original"
                      onClick={() => player.current?.playFrom(first.start, first.end)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-2xl px-2.5 py-2 text-left transition-transform hover:translate-x-0.5',
                        nowClip?.id === c.id ? 'bg-good-bg shadow-[inset_0_0_0_2px_var(--mint-d)]' : 'bg-row shadow-flat',
                      )}
                    >
                      <Badge tone="butter">#{rank.get(c.id)}</Badge>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <b className="truncate text-sm">{c.title}</b>
                        <span className="text-xs font-bold text-ink-3">
                          {fmtTime(c.start)}–{fmtTime(c.end)} · {Math.round(c.duration)}s{c.segments?.length ? ` · ${c.segments.length} parts` : ''}
                        </span>
                      </span>
                      <span className="grid size-7.5 shrink-0 place-items-center rounded-full bg-tangerine text-white" aria-hidden>
                        <Play size={13} fill="currentColor" />
                      </span>
                    </button>
                  );
                })}
                {!byTime.length && <p className="text-sm text-ink-3">Clips appear here as CrestClip finds them.</p>}
              </div>
            </div>
          </div>
        </Card>
      )}

      {sig && p.duration ? (
        <Card className="p-5">
          <CardHeader
            icon={sig.curveKind === 'audience' ? <Flame size={20} /> : <AudioLines size={20} />}
            title={sig.curveKind === 'audience' ? 'Where viewers rewatch' : 'Where the energy spikes'}
            description={
              sig.curveKind === 'audience'
                ? `Built from ${[sig.hasHeatmap && 'YouTube “Most replayed”', sig.sources.includes('comments') && 'timestamps in comments', sig.sources.includes('loudness') && 'audio energy'].filter(Boolean).join(' + ')}. Numbered bands are your clips.`
                : 'This video has no audience data (uploads and new videos don’t), so this shows audio energy — laughs, shouting, excitement.'
            }
            actions={sig.sources.map((s) => (
              <Badge key={s}>
                {s === 'heatmap' ? <Flame size={12} /> : s === 'comments' ? <MessageSquareText size={12} /> : <AudioLines size={12} />}
                {s === 'heatmap' ? 'Most replayed' : s === 'comments' ? 'Comments' : 'Audio energy'}
              </Badge>
            ))}
          />
          {canPick && (
            <p className="mb-2 flex items-center gap-1.5 text-[13px] font-bold text-warn-ink">
              <MousePointerClick size={15} /> {canWatch ? 'Click the graph to play from there · drag' : 'Drag'} across it to pick your own parts — CrestClip turns them into clips.
            </p>
          )}
          <HeatChart
            curve={sig.curve}
            duration={p.duration}
            kind={sig.curveKind}
            bands={clips.flatMap((c) => (c.segments?.length ? c.segments : [{ start: c.start, end: c.end }]).map((r) => ({ id: c.id, start: r.start, end: r.end, rank: rank.get(c.id) ?? 0 })))}
            onPick={onOpenClip}
            onSeek={canWatch ? (t) => player.current?.playFrom(t) : undefined}
            playhead={canWatch ? playT : null}
            selections={canPick ? picks : undefined}
            onSelectionsChange={canPick ? setPicks : undefined}
          />
          <PickBar picks={picks} onChange={setPicks}>
            <Button variant="primary" size="sm" loading={adding} onClick={() => addPicked(false)}>
              {!adding && <Scissors size={16} />} {picks.length > 1 ? `Make ${picks.length} clips` : 'Make clip'} · {picks.length * perClip} credits
            </Button>
            {picks.length > 1 && (
              <Button size="sm" disabled={adding} onClick={() => addPicked(true)} title="Stitch all picked parts, in time order, into one clip">
                <Combine size={16} /> Join into 1 clip · {perClip} credits
              </Button>
            )}
          </PickBar>
          {p.aiNotes && <p className="mt-4 text-[15px] text-ink-2">🤖 {p.aiNotes}</p>}
        </Card>
      ) : null}
    </div>
  );
});
