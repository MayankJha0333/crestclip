import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Flame, Loader2, X } from 'lucide-react';
import { api, type PublicPeek } from '../../lib/api';
import { fmtTime, fmtViews } from '../../lib/format';
import { Badge, buttonClass } from '../../components/ui';
import { HeatChart } from '../media/HeatChart';

/**
 * The landing page's proof, before any account: paste a YouTube link and see its "Most replayed" graph with the
 * top three peaks marked. Computed from YouTube's own data — no AI, nothing spent — so it's free to show everyone.
 */
export function PeakPreview({ url, signedIn, onClose }: { url: string; signedIn: boolean; onClose: () => void }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; data: PublicPeek } | { status: 'error'; message: string }>({ status: 'loading' });
  useEffect(() => {
    let gone = false;
    setState({ status: 'loading' });
    api
      .publicPeek(url)
      .then((data) => !gone && setState({ status: 'ready', data }))
      .catch((e: Error) => !gone && setState({ status: 'error', message: e.message }));
    return () => {
      gone = true;
    };
  }, [url]);

  const appLink = `/app?url=${encodeURIComponent(url)}`;
  const go = signedIn ? appLink : `/signup?next=${encodeURIComponent(appLink)}`;

  if (state.status === 'loading')
    return (
      <div className="mt-4 flex max-w-xl items-center gap-3 rounded-[24px] bg-surface p-4 shadow-clay">
        <Loader2 size={20} className="animate-spin text-accent" />
        <span className="font-bold">Reading where people rewatch this video…</span>
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="mt-4 flex max-w-xl flex-wrap items-center gap-3 rounded-[24px] bg-surface p-4 shadow-clay">
        <span className="min-w-0 flex-1 text-sm font-bold text-ink-2">{state.message}</span>
        <Link to={go} className={buttonClass('primary', 'sm')}>
          Clip it anyway <ArrowRight size={14} />
        </Link>
        <button type="button" onClick={onClose} aria-label="Close preview" className="rounded-full p-1.5 text-ink-3 hover:bg-row hover:text-ink">
          <X size={16} />
        </button>
      </div>
    );

  const { data } = state;
  const peaks = data.peaks;
  return (
    <div className="mt-4 max-w-xl animate-pop-in rounded-[28px] bg-surface p-4 shadow-clay sm:p-5">
      <div className="flex items-start gap-3.5">
        {data.thumbnail && <img src={data.thumbnail} alt="" className="aspect-video w-28 shrink-0 rounded-2xl object-cover" />}
        <div className="min-w-0 flex-1">
          <b className="line-clamp-2 leading-snug">{data.title}</b>
          <p className="mt-1 text-[13px] text-ink-3">
            {data.channel}
            {data.duration ? ` · ${fmtTime(data.duration)}` : ''}
            {data.views ? ` · ${fmtViews(data.views)}` : ''}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close preview" className="rounded-full p-1.5 text-ink-3 hover:bg-row hover:text-ink">
          <X size={16} />
        </button>
      </div>

      {data.curve && peaks.length ? (
        <>
          <div className="mt-4 flex items-center justify-between gap-2">
            <b className="inline-flex items-center gap-1.5 text-sm">
              <Flame size={15} className="text-accent" /> Where viewers rewatch
            </b>
            <Badge tone="mint">{peaks.length} peaks found</Badge>
          </div>
          <div className="mt-2">
            <HeatChart curve={data.curve} duration={data.duration} kind="audience" height={110} bands={peaks.map((p, i) => ({ id: `p${i}`, start: p.start, end: p.end, rank: i + 1 }))} />
          </div>
          <ul className="mt-3 flex flex-col gap-1.5">
            {peaks.map((p, i) => (
              <li key={i} className="flex items-center gap-2.5 rounded-2xl bg-row px-3 py-2 text-sm shadow-flat">
                <Badge tone="butter">#{i + 1}</Badge>
                <b>
                  {fmtTime(p.start)}–{fmtTime(p.end)}
                </b>
                <span className="text-ink-3">{p.times && p.times > 1 ? `rewatched ${p.times}× more than the rest of the video` : 'a moment viewers come back to'}</span>
              </li>
            ))}
          </ul>
          <Link to={go} className={buttonClass('primary', 'md', 'mt-4 w-full')}>
            Make these 3 clips free <ArrowRight size={16} />
          </Link>
          <p className="mt-2 text-center text-xs text-ink-3">{signedIn ? 'Opens New clips with this link filled in.' : 'Sign in with Google · 12 free clips a month · no card'}</p>
        </>
      ) : (
        <>
          <p className="mt-4 rounded-2xl bg-row px-3.5 py-3 text-sm text-ink-2 shadow-flat">
            YouTube hasn’t published a “Most replayed” graph for this video yet (it needs a few thousand views). CrestClip can still clip it: the AI reads the transcript and listens for the loud, funny and surprising moments.
          </p>
          <Link to={go} className={buttonClass('primary', 'md', 'mt-4 w-full')}>
            Clip this video free <ArrowRight size={16} />
          </Link>
        </>
      )}
    </div>
  );
}
