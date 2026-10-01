import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { subscribeToasts, type Toast } from '../../lib/toast';

export function Toaster() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setList), []);
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-24 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2 lg:bottom-6">
      {list.map((t) => (
        <div
          key={t.id}
          className={cn(
            'animate-pop-in rounded-full px-5 py-3 text-sm font-extrabold shadow-float',
            t.tone === 'error' ? 'bg-bad-bg text-bad-ink' : t.tone === 'ok' ? 'bg-good-bg text-good-ink' : 'bg-surface text-ink',
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
