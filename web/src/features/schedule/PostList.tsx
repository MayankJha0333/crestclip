import { Link } from 'react-router-dom';
import { Bot, CalendarClock, Check, ExternalLink, Loader2, RotateCcw, X, XCircle } from 'lucide-react';
import { api, type PostItem } from '../../lib/api';
import { cn } from '../../lib/cn';
import { timeAgo } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Badge, Button, buttonClass } from '../../components/ui';
import { postLabel, SOCIAL, TONE_BADGE } from './postStatus';

const ICON = { busy: Loader2, ok: Check, bad: XCircle, sched: CalendarClock, muted: CalendarClock } as const;

/** Rows of posts with their status and the one action that makes sense (retry / cancel / open). */
export function PostList({ items, onChange, showTime }: { items: PostItem[]; onChange: () => void; showTime?: boolean }) {
  const run = (p: Promise<unknown>) => p.then(onChange).catch((e: Error) => toast(e.message, 'error'));
  return (
    <div className="flex flex-col gap-2.5">
      {items.map((p) => {
        const L = postLabel(p);
        const P = SOCIAL[p.platform];
        const StatusIcon = ICON[L.tone];
        const when = showTime && p.scheduledAt ? new Date(p.scheduledAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : null;
        const fromAutopilot = Boolean(p.autopilotId);
        return (
          <div
            key={p.id}
            className={cn(
              'flex flex-wrap items-center gap-3.5 rounded-2xl bg-row py-2.5 pr-3.5 pl-2.5 shadow-flat sm:flex-nowrap',
              L.tone === 'bad' && 'shadow-[var(--shadow-flat),inset_3px_0_0_var(--bad)]',
            )}
          >
            {when && <span className="w-full font-display text-[15px] font-semibold sm:w-18">{when}</span>}
            <span className="relative shrink-0">
              {p.clip?.thumbUrl ? <img src={p.clip.thumbUrl} alt="" className="h-17 w-10 rounded-[10px] bg-media object-cover" /> : <span className="block h-17 w-10 rounded-[10px] bg-media" />}
              <span className={cn('absolute -right-1.5 -bottom-1.5 grid size-5.5 place-items-center rounded-full text-white shadow-[0_0_0_2px_var(--row)]', P.color)}>
                <P.Icon size={11} />
              </span>
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <b className="truncate">{p.title || p.clip?.title || 'Clip'}</b>
              <span className="truncate text-xs text-ink-3">
                {p.account?.handle ?? p.account?.name ?? P.name}
                {!showTime && <> · {timeAgo(p.updatedAt)}</>}
                {fromAutopilot && (
                  <>
                    {' · '}
                    <Bot size={11} className="inline -translate-y-px" /> Autopilot
                  </>
                )}
                {p.clip && (
                  <>
                    {' · '}
                    <Link to={`/app/p/${p.clip.projectId}`} className="font-bold text-ink-2 hover:text-ink">
                      open project
                    </Link>
                  </>
                )}
              </span>
              {p.error && <span className={cn('text-xs', p.status === 'failed' ? 'text-bad' : 'text-warn-ink')}>{p.error}</span>}
            </div>
            <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
              <Badge tone={TONE_BADGE[L.tone]}>
                <StatusIcon size={12} className={L.tone === 'busy' ? 'animate-spin' : undefined} />
                {showTime && L.tone === 'sched' ? (p.platform === 'youtube' && p.status === 'published' ? 'On YouTube’s schedule' : 'Scheduled') : L.text}
              </Badge>
              {p.remoteUrl && (
                <a className={buttonClass('secondary', 'icon-sm')} href={p.remoteUrl} target="_blank" rel="noreferrer" title={`Open on ${P.name}`}>
                  <ExternalLink size={14} />
                </a>
              )}
              {p.status === 'failed' && /reconnect|expired|disconnected|permission/i.test(p.error ?? '') && (
                <Link to="/app/settings" className={buttonClass('primary', 'sm')} title="Connect the account again in Settings, then retry">
                  Reconnect {P.name}
                </Link>
              )}
              {p.status === 'failed' && (
                <Button size="sm" onClick={() => run(api.retryPost(p.id))}>
                  <RotateCcw size={14} /> Retry
                </Button>
              )}
              {p.status === 'scheduled' && p.scheduledAt && p.scheduledAt > Date.now() && (
                <Button size="icon-sm" title="Cancel this post" aria-label="Cancel this post" onClick={() => run(api.cancelPost(p.id))}>
                  <X size={14} />
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
