import { useEffect, useRef } from 'react';
import { Bug, CreditCard, Film, Lightbulb, MessageCircle, Send, UserRound, type LucideIcon } from 'lucide-react';
import type { TicketCategory, TicketMessage, TicketStatus } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Badge, type BadgeTone } from '../../components/ui';

export const CATEGORIES: { value: TicketCategory; label: string; hint: string; Icon: LucideIcon }[] = [
  { value: 'billing', label: 'Billing & credits', hint: 'Payments, plans, invoices, credits', Icon: CreditCard },
  { value: 'clips', label: 'Clips & videos', hint: 'A video failed, clips look wrong', Icon: Film },
  { value: 'publishing', label: 'Posting', hint: 'YouTube, Instagram, scheduling', Icon: Send },
  { value: 'account', label: 'Account', hint: 'Sign-in, email, deleting data', Icon: UserRound },
  { value: 'bug', label: 'Something’s broken', hint: 'A page or button doesn’t work', Icon: Bug },
  { value: 'idea', label: 'Idea', hint: 'Something you’d like CrestClip to do', Icon: Lightbulb },
  { value: 'other', label: 'Something else', hint: 'Anything not listed', Icon: MessageCircle },
];
export const categoryOf = (c: TicketCategory) => CATEGORIES.find((x) => x.value === c) ?? CATEGORIES.at(-1)!;

/** How a status reads to the person who asked, and to the team. */
const STATUS: Record<TicketStatus, { user: string; admin: string; tone: BadgeTone }> = {
  open: { user: 'Waiting for us', admin: 'Open', tone: 'orange' },
  in_progress: { user: 'We’re on it', admin: 'In progress', tone: 'info' },
  waiting: { user: 'Answered', admin: 'Waiting on customer', tone: 'warn' },
  resolved: { user: 'Resolved', admin: 'Resolved', tone: 'good' },
  closed: { user: 'Closed', admin: 'Closed', tone: 'neutral' },
};
export const statusLabel = (s: TicketStatus, side: 'user' | 'admin') => STATUS[s][side];
export function StatusBadge({ status, side }: { status: TicketStatus; side: 'user' | 'admin' }) {
  return <Badge tone={STATUS[status].tone}>{STATUS[status][side]}</Badge>;
}

export const when = (ms: number) => {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};

/**
 * The conversation, oldest first: the viewer's own messages on the right, the other side's on the left. `me` says
 * whose side the viewer is on ("user" for the person, "admin" for the team).
 */
export function Thread({ messages, me, otherName }: { messages: TicketMessage[]; me: 'user' | 'admin'; otherName: string }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [messages.length]);
  return (
    <ol className="flex flex-col gap-4">
      {messages.map((m) => {
        const mine = m.from === me;
        return (
          <li key={m.id} className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}>
            <span className="px-1 text-xs text-ink-3">
              <b className="font-extrabold text-ink-2">{mine ? 'You' : m.from === 'admin' ? m.authorName || 'CrestClip support' : m.authorName || otherName}</b>
              {m.from === 'admin' && !mine && <span className="ml-1.5 rounded-full bg-tangerine/15 px-1.5 py-px text-[10px] font-black text-accent uppercase">Team</span>} · {when(m.at)}
            </span>
            <div
              className={cn(
                'max-w-[min(36rem,92%)] rounded-[20px] px-4 py-3 text-[14.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]',
                mine ? 'rounded-br-md bg-ink text-on-ink' : 'rounded-bl-md bg-row text-ink shadow-flat',
              )}
            >
              {m.body}
            </div>
          </li>
        );
      })}
      <div ref={end} />
    </ol>
  );
}
