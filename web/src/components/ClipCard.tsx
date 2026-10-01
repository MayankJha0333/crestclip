import { useState } from 'react';
import { CalendarClock, Check, ChevronDown, Combine, Copy, Download, ExternalLink, Hand, Instagram, Music, Pencil, RefreshCw, Send, Sparkles, TriangleAlert, Youtube } from 'lucide-react';
import { PublishModal } from './PublishModal';
import { postLabel } from '../pages/Accounts';
import { api, fmtTime, type Clip } from '../lib/api';
import { CATEGORY_TINT, RubricBars, ScoreRing } from './bits';

export function ClipCard({
  clip,
  rank,
  audienceKind,
  highlighted,
  onEdit,
  onChanged,
}: {
  clip: Clip;
  rank: number;
  audienceKind: 'audience' | 'energy' | 'none';
  highlighted?: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [posting, setPosting] = useState(false);
  const working = clip.status === 'pending' || clip.status === 'rendering';

  const copyPost = async () => {
    const text = `${clip.title}\n\n${clip.description}\n\n${clip.hashtags.join(' ')}`.trim();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <article id={`clip-${clip.id}`} className={`clip-card clay pop-in ${highlighted ? 'is-hl' : ''}`} style={{ animationDelay: `${Math.min(rank, 8) * 60}ms` }}>
      <div className="clip-phone">
        {clip.videoUrl && !working ? (
          <video key={clip.videoUrl} src={clip.videoUrl} poster={clip.thumbUrl ?? undefined} controls preload="none" playsInline />
        ) : (
          <div className="clip-phone-empty">
            {clip.status === 'failed' ? (
              <>
                <TriangleAlert size={28} />
                <span>Render failed</span>
              </>
            ) : (
              <>
                <span className="spinner" />
                <span>{clip.status === 'rendering' ? 'Reframing & rendering…' : 'In the queue…'}</span>
              </>
            )}
          </div>
        )}
        <span className="rank-badge tint-butter">#{rank}</span>
      </div>

      <div className="clip-body">
        <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
          <ScoreRing value={clip.peakScore} size={62} label="Crest score" />
          <div className="grow">
            <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
              <span className={`badge ${CATEGORY_TINT[clip.category] ?? 'tint-sky'}`} style={{ textTransform: 'capitalize' }}>
                {clip.category}
              </span>
              <span className="badge">
                {clip.segments?.length ? (
                  <>
                    <Combine size={12} /> {clip.segments.length} parts
                  </>
                ) : (
                  <>
                    {fmtTime(clip.start)}–{fmtTime(clip.end)}
                  </>
                )}{' '}
                · {Math.round(clip.duration)}s
              </span>
              {clip.source === 'manual' && (
                <span className="badge" title="You picked this part on the graph">
                  <Hand size={12} /> Your pick
                </span>
              )}
              {clip.music && clip.music.track !== 'none' && (
                <span className="badge" title="Background music">
                  <Music size={12} /> {clip.music.track === 'auto' ? 'Auto' : clip.music.track.startsWith('upload:') ? 'Your track' : clip.music.track}
                </span>
              )}
            </div>
            <h3 style={{ fontSize: 20 }}>{clip.title}</h3>
          </div>
        </div>

        <div className="score-split">
          <div>
            <span className="faint">AI virality</span>
            <b>{clip.aiScore}</b>
          </div>
          <div>
            <span className="faint">{audienceKind === 'audience' ? 'Rewatched more than' : 'Energy vs. rest of video'}</span>
            <b>
              {clip.audienceScore == null ? '—' : audienceKind === 'audience' ? `${clip.audienceScore}% of video` : `${clip.audienceScore}/100`}
            </b>
          </div>
        </div>

        {clip.hook && (
          <p className="hook-line">
            <Sparkles size={15} /> “{clip.hook}”
          </p>
        )}
        <p className="muted" style={{ fontSize: 15 }}>
          {clip.reason}
        </p>

        {clip.error && <p style={{ color: 'var(--bad)', fontSize: 14 }}>{clip.error}</p>}

        {clip.posts && clip.posts.length > 0 && (
          <div className="clip-posts">
            {clip.posts.slice(0, 4).map((p) => {
              const L = postLabel(p);
              const Icon = p.platform === 'youtube' ? Youtube : Instagram;
              const body = (
                <>
                  <Icon size={13} /> {L.text}
                  {p.remoteUrl && <ExternalLink size={11} />}
                </>
              );
              return p.remoteUrl ? (
                <a key={p.id} className={`post-status ${L.tone}`} href={p.remoteUrl} target="_blank" rel="noreferrer" title={p.error ?? undefined}>
                  {body}
                </a>
              ) : (
                <span key={p.id} className={`post-status ${L.tone}`} title={p.error ?? undefined}>
                  {body}
                </span>
              );
            })}
          </div>
        )}

        {clip.rubric && (
          <div>
            <button type="button" className="linkish" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              Why this score <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }} />
            </button>
            {open && (
              <div style={{ marginTop: 12 }}>
                <RubricBars rubric={clip.rubric} />
              </div>
            )}
          </div>
        )}

        <div className="row wrap" style={{ gap: 8, marginTop: 'auto', paddingTop: 6 }}>
          {clip.status === 'ready' && clip.videoUrl ? (
            <a className="btn btn-primary btn-sm" href={api.downloadUrl(clip.id)}>
              <Download size={16} /> Download
            </a>
          ) : null}
          {clip.status === 'ready' && clip.videoUrl && (
            <button className="btn btn-sm btn-ink" onClick={() => setPosting(true)} title="Post or schedule to YouTube / Instagram">
              {clip.posts?.some((p) => p.status === 'scheduled') ? <CalendarClock size={16} /> : <Send size={16} />} Post
            </button>
          )}
          {clip.status === 'failed' ? (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(() => api.rerender(clip.id))}>
              <RefreshCw size={16} /> Retry
            </button>
          ) : null}
          <button className="btn btn-sm" onClick={onEdit} disabled={working}>
            <Pencil size={16} /> Edit
          </button>
          <button className="btn btn-sm" onClick={copyPost} title="Copy title, caption and hashtags">
            {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy post'}
          </button>
          <button
            className="btn btn-sm"
            disabled={busy || working}
            onClick={() => act(() => api.variant(clip.id))}
            title="Same moment, new caption style — post variations without duplicate-content flags"
          >
            <Sparkles size={16} /> Variant
          </button>
        </div>
      </div>
      {posting && <PublishModal clip={clip} onClose={() => setPosting(false)} onDone={onChanged} />}
    </article>
  );
}
