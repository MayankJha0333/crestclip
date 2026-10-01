import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CornerDownLeft, Plus, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Badge, Button } from '../../components/ui';
import { splitLinks } from './instructions';
import { LinkSourceIcon } from './LinkSourceIcon';
import { detectLink } from './links';

/** Most videos one project can hold (the server checks this too). */
export const MAX_VIDEOS = 15;

const SOURCES = ['YouTube', 'Twitch', 'Google Drive', 'Dropbox', 'OneDrive', '.mp4 link'];

/** Little numbered dot that marks each video slot. */
const Num = ({ n, ghost }: { n: number; ghost?: boolean }) => (
  <span className={cn('grid size-7 shrink-0 place-items-center rounded-full text-xs font-black', ghost ? 'border-2 border-dashed border-line-strong text-ink-3' : 'bg-ink text-on-ink')}>{n}</span>
);

/**
 * A list of video links, one per row. Paste or type a link and press Enter — it becomes a row and the
 * box is ready for the next one. Pasting several links at once adds them all. Every row = one video,
 * and all of them go into one project.
 */
export function LinkList({
  items,
  onItems,
  draft,
  onDraft,
  onFile,
  onSubmit,
}: {
  items: string[];
  onItems: (v: string[]) => void;
  draft: string;
  onDraft: (v: string) => void;
  onFile: (f: File) => void;
  onSubmit: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  /** Move whatever links are in `text` into the list. Returns true if something was added. */
  const commit = (text: string) => {
    const found = splitLinks(text);
    if (!found.length) return false;
    const fresh = found.filter((u) => !items.includes(u));
    const room = MAX_VIDEOS - items.length;
    const added = fresh.slice(0, room);
    setNote(
      fresh.length > room
        ? `Only ${MAX_VIDEOS} videos fit in one project — ${fresh.length - room} link${fresh.length - room > 1 ? 's were' : ' was'} left out`
        : fresh.length < found.length
          ? 'Skipped a link you already added'
          : null,
    );
    if (added.length) onItems([...items, ...added]);
    onDraft('');
    return true;
  };
  const draftInfo = draft.trim() ? detectLink(draft) : null;
  const next = items.length + 1;
  const full = items.length >= MAX_VIDEOS;

  return (
    <div className="flex flex-col gap-2" aria-describedby="link-hint">
      {items.map((u, i) => {
        const info = detectLink(u);
        const bad = !info || info.error;
        return (
          <div key={u} className={cn('group flex min-w-0 animate-pop-in items-center gap-3 rounded-2xl py-2.5 pr-2 pl-2.5', bad ? 'bg-bad-bg' : 'bg-row shadow-flat')}>
            <Num n={i + 1} />
            <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface shadow-flat">
              <LinkSourceIcon info={info} size={17} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <b className={cn('flex items-center gap-1.5 text-sm', bad ? 'text-bad-ink' : 'text-ink')}>
                {info?.label ?? 'Not a video link'}
                {bad ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} className="text-good" />}
              </b>
              <span className={cn('truncate text-xs', bad ? 'text-bad-ink' : 'text-ink-3')}>{info?.error ?? u}</span>
            </span>
            <Button variant="ghost" size="icon-sm" aria-label={`Remove video ${i + 1}`} onClick={() => onItems(items.filter((x) => x !== u))}>
              <X size={15} />
            </Button>
          </div>
        );
      })}

      {/* the box for the next link (hidden once the project is full) */}
      {!full && (
        <div
          className={cn(
            'flex items-center gap-3 rounded-2xl bg-sunken py-2 pr-2 pl-2.5 shadow-well transition-shadow focus-within:shadow-[var(--shadow-well),0_0_0_3px_rgba(255,138,91,.4)]',
            draftInfo?.error && 'shadow-[var(--shadow-well),inset_0_0_0_2px_var(--bad)]',
          )}
        >
          <Num n={next} ghost={!draft.trim()} />
          <span className="grid size-8 shrink-0 place-items-center">
            <LinkSourceIcon info={draftInfo} size={19} />
          </span>
          <input
            ref={input}
            autoFocus
            aria-label={items.length ? `Video ${next} link` : 'Video link'}
            value={draft}
            onChange={(e) => {
              const v = e.target.value;
              // several links pasted at once → add them all as rows
              if (splitLinks(v).length > 1) commit(v);
              else onDraft(v);
            }}
            onPaste={(e) => {
              const f = e.clipboardData.files?.[0];
              if (f) {
                e.preventDefault();
                onFile(f);
              }
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (e.metaKey || e.ctrlKey) {
                commit(draft);
                return onSubmit();
              }
              commit(draft);
            }}
            onBlur={() => commit(draft)}
            placeholder={items.length ? 'Paste another link (optional)' : 'Paste a video link — YouTube, Twitch, Drive…'}
            className="min-w-0 flex-1 bg-transparent py-2 text-[17px] font-semibold text-ink outline-none placeholder:font-normal placeholder:text-ink-3"
          />
          {draft.trim() ? (
            <Button size="sm" variant="ink" onClick={() => commit(draft)} disabled={!splitLinks(draft).length}>
              <CornerDownLeft size={14} /> Add
            </Button>
          ) : null}
        </div>
      )}

      {/* a hint of the next slot, so it's obvious more than one video fits */}
      {!draft.trim() && !items.length && (
        <button
          type="button"
          onClick={() => input.current?.focus()}
          className="flex items-center gap-3 rounded-2xl border-2 border-dashed border-line-strong py-2.5 pr-3 pl-2.5 text-left text-sm font-bold text-ink-3 transition-colors hover:border-tangerine hover:text-accent"
        >
          <Num n={2} ghost />
          <Plus size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">Got more videos? Add them one after another</span>
        </button>
      )}

      <p id="link-hint" className="mt-1 flex flex-wrap items-center gap-1.5 px-1 text-[13px] text-ink-3">
        {draftInfo && !draftInfo.error ? (
          <span className="font-semibold text-good-ink">
            <b>{draftInfo.label}</b> · {draftInfo.hint} · press Enter to add it
          </span>
        ) : draftInfo?.error ? (
          <span className="font-semibold text-bad">{draftInfo.error}</span>
        ) : full ? (
          <span className="font-semibold text-warn-ink">
            <b>
              {MAX_VIDEOS} of {MAX_VIDEOS} videos
            </b>{' '}
            — that’s the most one project can hold. Start another project for more.
          </span>
        ) : items.length > 1 ? (
          <span>
            <b className="text-ink">
              {items.length} of {MAX_VIDEOS} videos
            </b>{' '}
            → one project, same settings for every video{note ? ` · ${note}` : ''}
          </span>
        ) : (
          <>
            Works with
            {SOURCES.map((s) => (
              <Badge key={s} className="font-bold text-ink-2">
                {s}
              </Badge>
            ))}
            <span>+ 1,000 more sites</span>
          </>
        )}
      </p>
    </div>
  );
}
