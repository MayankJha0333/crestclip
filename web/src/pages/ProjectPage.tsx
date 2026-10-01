import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, AudioLines, Check, Combine, Download, ExternalLink, Flame, MessageSquareText, MousePointerClick, Play, RotateCcw, Scissors, Trash2, Tv } from 'lucide-react';
import { api, fmtTime, fmtViews, type Clip, type Project, type TimeRange } from '../lib/api';
import { HeatChart, PickBar } from '../components/HeatChart';
import { toast } from '../lib/toast';
import { DeleteProjectModal } from '../components/ConfirmModal';
import { SourcePlayer, youtubeIdOf, type PlayerHandle } from '../components/SourcePlayer';
import { ClipCard } from '../components/ClipCard';
import { ClipEditor } from '../components/ClipEditor';

const STAGES = [
  { key: 'fetch', label: 'Get video' },
  { key: 'listen', label: 'Listen' },
  { key: 'transcribe', label: 'Transcribe' },
  { key: 'moments', label: 'Find peaks' },
  { key: 'render', label: 'Reframe & render' },
];

const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

type SortKey = 'peak' | 'ai' | 'audience' | 'time';

export function ProjectPage() {
  const { id = '' } = useParams();
  const [p, setP] = useState<Project | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Clip | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('peak');
  const [picks, setPicks] = useState<TimeRange[]>([]);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [playT, setPlayT] = useState<number | null>(null);
  const player = useRef<PlayerHandle>(null);
  const nav = useNavigate();
  // the player reports time several times a second — only re-render when it moved noticeably
  const onTime = useCallback((t: number) => setPlayT((prev) => (prev == null || Math.abs(prev - t) >= 0.5 ? t : prev)), []);

  const load = useCallback(() => api.project(id).then(setP).catch((e) => setErr(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);

  const busy = p && (p.status === 'processing' || p.status === 'queued' || p.clips?.some((c) => c.status === 'pending' || c.status === 'rendering'));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [busy, load]);

  const ranked = useMemo(() => {
    const list = [...(p?.clips ?? [])];
    const byPeak = [...list].sort((a, b) => b.peakScore - a.peakScore);
    const rank = new Map(byPeak.map((c, i) => [c.id, i + 1]));
    const sorted =
      sort === 'ai' ? list.sort((a, b) => b.aiScore - a.aiScore)
      : sort === 'audience' ? list.sort((a, b) => (b.audienceScore ?? -1) - (a.audienceScore ?? -1))
      : sort === 'time' ? list.sort((a, b) => a.start - b.start)
      : byPeak;
    return { sorted, rank };
  }, [p?.clips, sort]);

  if (err) return <div className="page"><div className="clay empty">{err}</div></div>;
  if (!p) return <div className="page"><p className="faint">Loading…</p></div>;

  const stageIdx = STAGES.findIndex((s) => s.key === p.stage);
  const sig = p.signals;
  const ready = p.clips?.filter((c) => c.status === 'ready') ?? [];
  const canPick = p.status === 'done' || p.status === 'failed';
  const addPicked = async (join: boolean) => {
    setAdding(true);
    try {
      const made = await api.addClips(p.id, picks, join);
      toast(join ? 'Joining your parts into one clip…' : `Making ${made.length} clip${made.length > 1 ? 's' : ''} from your picks…`);
      setPicks([]);
      setSort('time');
      await load();
      if (made[0]) setTimeout(() => document.getElementById(`clip-${made[0].id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setAdding(false);
    }
  };
  const canWatch = Boolean(youtubeIdOf(p.sourceUrl) || p.sourceVideoUrl || /twitch\.tv\/videos\//.test(p.sourceUrl ?? ''));
  const byTime = [...(p.clips ?? [])].sort((a, b) => a.start - b.start);
  const nowClip = playT == null ? null : byTime.find((c) => (c.segments?.length ? c.segments : [c]).some((r) => playT >= r.start && playT <= r.end));
  const seek = (t: number) => player.current?.playFrom(t);
  const pick = (cid: string) => {
    setActive(cid);
    document.getElementById(`clip-${cid}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="page">
      <Link to="/app/projects" className="linkish" style={{ marginBottom: 18 }}>
        <ArrowLeft size={16} /> All projects
      </Link>

      <header className="proj-head clay">
        {canWatch ? (
          <button
            type="button"
            className="proj-head-thumb well thumb-play"
            onClick={() => {
              document.getElementById('watch')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              setTimeout(() => player.current?.playFrom(playT ?? 0), 450);
            }}
            aria-label="Play the original video"
          >
            {p.thumbUrl ? <img src={p.thumbUrl} alt="" /> : null}
            <span className="thumb-play-btn">
              <Play size={22} fill="currentColor" />
            </span>
          </button>
        ) : (
          <div className="proj-head-thumb well">{p.thumbUrl ? <img src={p.thumbUrl} alt="" /> : null}</div>
        )}
        <div className="grow">
          <h1 style={{ fontSize: 'clamp(24px, 3vw, 34px)' }}>{p.title || 'Untitled video'}</h1>
          <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
            {p.channel && <span className="badge">{p.channel}</span>}
            {p.duration ? <span className="badge">{fmtTime(p.duration)} long</span> : null}
            {p.viewCount ? <span className="badge">{fmtViews(p.viewCount)}</span> : null}
            <span className="badge" style={{ textTransform: 'capitalize' }}>
              For {p.options.platform === 'shorts' ? 'YouTube Shorts' : p.options.platform === 'reels' ? 'Reels' : 'TikTok'}
            </span>
            {p.download && (
              <span className="badge tint-mint" title="CrestClip downloaded the audio plus only the parts that became clips, not the whole video">
                <Download size={13} /> {fmtBytes(p.download.downloaded)}
                {p.download.full && p.download.full > p.download.downloaded ? ` instead of ~${fmtBytes(p.download.full)}` : ' downloaded'}
              </span>
            )}
            {p.sourceUrl && (
              <a className="badge" href={p.sourceUrl} target="_blank" rel="noreferrer">
                Source <ExternalLink size={13} />
              </a>
            )}
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {p.status === 'failed' && (
            <button className="btn btn-primary" onClick={() => api.retry(p.id).then(load)}>
              <RotateCcw size={18} /> Try again
            </button>
          )}
          {p.status !== 'processing' && p.status !== 'queued' && (
            <button className="btn btn-icon" onClick={() => setDeleting(true)} aria-label="Delete project" title="Delete project">
              <Trash2 size={18} />
            </button>
          )}
        </div>
      </header>
      <DeleteProjectModal project={deleting ? p : null} onCancel={() => setDeleting(false)} onDeleted={() => nav('/app/projects')} />

      {(p.status === 'processing' || p.status === 'queued') && (
        <section className="clay progress-card pop-in">
          <div className="stepper">
            {STAGES.map((s, i) => (
              <div key={s.key} className={`step ${i < stageIdx ? 'done' : i === stageIdx ? 'now' : ''}`}>
                <span className="step-dot">{i < stageIdx ? <Check size={16} /> : i + 1}</span>
                <span className="step-label">{s.label}</span>
              </div>
            ))}
          </div>
          <div className="progress well" style={{ marginTop: 22, height: 22 }}>
            <span style={{ width: `${Math.max(3, p.progress)}%` }} />
          </div>
          <p className="muted" style={{ marginTop: 12, fontWeight: 700 }}>
            {p.status === 'queued' ? 'Waiting for a free worker…' : p.stageDetail || 'Working…'} <span className="faint">· {Math.round(p.progress)}%</span>
          </p>
        </section>
      )}

      {p.status === 'failed' && (
        <section className="clay error-card">
          <b>Something went wrong</b>
          <p>{p.error}</p>
        </section>
      )}

      {canWatch && (
        <section className="clay heat-card watch-card" id="watch">
          <div className="row wrap" style={{ justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
            <h2 style={{ fontSize: 22 }} className="row">
              <Tv size={22} color="var(--tangerine-d)" /> Watch the original
            </h2>
            <span className="now-playing">
              {playT != null ? (
                <>
                  ▶ {fmtTime(playT)}
                  {nowClip ? ` · inside clip #${ranked.rank.get(nowClip.id)}` : ''}
                </>
              ) : (
                'Click a moment or the graph to jump there'
              )}
            </span>
          </div>
          <div className="watch-grid">
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
              <div className="moments-head">
                <b style={{ fontFamily: 'var(--font-display)' }}>Moments</b>
                <span className="faint" style={{ fontSize: 12, fontWeight: 700 }}>
                  {byTime.length ? `${byTime.length} clip${byTime.length > 1 ? 's' : ''}, in order` : 'No clips yet'}
                </span>
              </div>
              <div className="moments" role="list">
                {byTime.map((c) => {
                  const first = c.segments?.length ? c.segments[0] : { start: c.start, end: c.end };
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="listitem"
                      className={`moment ${nowClip?.id === c.id ? 'is-now' : ''}`}
                      onClick={() => {
                        setActive(c.id);
                        player.current?.playFrom(first.start, first.end);
                      }}
                      title="Play this moment in the original"
                    >
                      <span className="rank-badge tint-butter">#{ranked.rank.get(c.id)}</span>
                      <span className="moment-txt">
                        <b>{c.title}</b>
                        <span>
                          {fmtTime(c.start)}–{fmtTime(c.end)} · {Math.round(c.duration)}s{c.segments?.length ? ` · ${c.segments.length} parts` : ''}
                        </span>
                      </span>
                      <span className="moment-play" aria-hidden>
                        <Play size={14} fill="currentColor" />
                      </span>
                    </button>
                  );
                })}
                {!byTime.length && <p className="faint" style={{ fontSize: 14 }}>Clips will appear here as CrestClip finds them.</p>}
              </div>
            </div>
          </div>
        </section>
      )}

      {sig && p.duration ? (
        <section className="clay heat-card">
          <div className="row wrap" style={{ justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
            <div>
              <h2 style={{ fontSize: 22 }} className="row">
                {sig.curveKind === 'audience' ? <Flame size={22} color="var(--tangerine-d)" /> : <AudioLines size={22} color="var(--tangerine-d)" />}
                {sig.curveKind === 'audience' ? 'Where viewers rewatch' : 'Where the energy spikes'}
              </h2>
              <p className="faint" style={{ fontSize: 14 }}>
                {sig.curveKind === 'audience'
                  ? `Built from ${[sig.hasHeatmap && 'YouTube “Most replayed”', sig.sources.includes('comments') && 'timestamps in comments', sig.sources.includes('loudness') && 'audio energy'].filter(Boolean).join(' + ')}. Numbered bands are your clips.`
                  : 'No audience data for this video (uploads and newer videos have none), so this shows audio energy — laughs, shouting, excitement.'}
              </p>
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              {sig.sources.map((s) => (
                <span key={s} className="badge">
                  {s === 'heatmap' ? <Flame size={13} /> : s === 'comments' ? <MessageSquareText size={13} /> : <AudioLines size={13} />}
                  {s === 'heatmap' ? 'Most replayed' : s === 'comments' ? 'Comments' : 'Audio energy'}
                </span>
              ))}
            </div>
          </div>
          {canPick && (
            <p className="pick-hint" style={{ marginBottom: 6 }}>
              <MousePointerClick size={15} /> {canWatch ? 'Click the graph to play from there · drag' : 'Drag'} across it to pick your own parts — CrestClip turns them into clips.
            </p>
          )}
          <HeatChart
            curve={sig.curve}
            duration={p.duration}
            kind={sig.curveKind}
            bands={(p.clips ?? []).flatMap((c) =>
              (c.segments?.length ? c.segments : [{ start: c.start, end: c.end }]).map((r) => ({ id: c.id, start: r.start, end: r.end, rank: ranked.rank.get(c.id) ?? 0 })),
            )}
            activeId={active}
            onPick={pick}
            onSeek={canWatch ? seek : undefined}
            playhead={canWatch ? playT : null}
            selections={canPick ? picks : undefined}
            onSelectionsChange={canPick ? setPicks : undefined}
          />
          <PickBar picks={picks} onChange={setPicks}>
            <button className="btn btn-primary btn-sm" disabled={adding} onClick={() => addPicked(false)}>
              {adding ? <span className="spinner" /> : <Scissors size={16} />} {picks.length > 1 ? `Make ${picks.length} clips` : 'Make clip'}
            </button>
            {picks.length > 1 && (
              <button className="btn btn-sm" disabled={adding} onClick={() => addPicked(true)} title="Stitch all picked parts, in time order, into one clip">
                <Combine size={16} /> Join into 1 clip
              </button>
            )}
          </PickBar>
          {p.aiNotes && <p className="muted ai-notes">🤖 {p.aiNotes}</p>}
        </section>
      ) : null}

      {p.clips && p.clips.length > 0 && (
        <section style={{ marginTop: 34 }}>
          <div className="row wrap" style={{ justifyContent: 'space-between', gap: 12, marginBottom: 18 }}>
            <h2 style={{ fontSize: 26 }}>
              {p.clips.length} clips <span className="faint" style={{ fontSize: 18 }}>· {ready.length} ready</span>
            </h2>
            <div className="row wrap" style={{ gap: 10 }}>
              <div className="seg" role="group" aria-label="Sort clips">
                {(
                  [
                    ['peak', 'Crest score'],
                    ['ai', 'AI score'],
                    ['audience', 'Audience'],
                    ['time', 'Timeline'],
                  ] as [SortKey, string][]
                ).map(([k, l]) => (
                  <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)}>
                    {l}
                  </button>
                ))}
              </div>
              {ready.length > 1 && (
                <button
                  className="btn btn-ink btn-sm"
                  onClick={() => ready.forEach((c, i) => setTimeout(() => window.open(api.downloadUrl(c.id), '_blank'), i * 400))}
                >
                  <Download size={16} /> Download all
                </button>
              )}
            </div>
          </div>
          <div className="clip-grid">
            {ranked.sorted.map((c) => (
              <ClipCard
                key={c.id}
                clip={c}
                rank={ranked.rank.get(c.id) ?? 0}
                audienceKind={sig?.curveKind ?? 'none'}
                highlighted={active === c.id}
                onEdit={() => setEditing(c)}
                onChanged={load}
              />
            ))}
          </div>
        </section>
      )}

      {editing && <ClipEditor clip={editing} siblings={p.clips ?? []} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}
