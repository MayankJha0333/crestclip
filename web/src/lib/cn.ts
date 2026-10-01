import { twMerge } from 'tailwind-merge';

/** Join class names, skipping falsy ones; later Tailwind classes win over earlier ones (cn('w-full', 'w-auto') → 'w-auto'). */
export const cn = (...parts: (string | false | null | undefined | 0)[]) => twMerge(parts.filter(Boolean).join(' '));
