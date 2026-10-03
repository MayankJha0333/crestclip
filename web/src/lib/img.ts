import type { SyntheticEvent } from 'react';

/** A picture from another site that didn't load (expired link, blocked): hide it instead of showing a broken icon. */
export const hideBroken = (e: SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.style.display = 'none';
};
