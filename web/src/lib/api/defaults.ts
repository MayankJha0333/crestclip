import { readLocal, writeLocal } from '../storage';
import type { ProjectOptions } from './types';

export const DEFAULT_OPTIONS: ProjectOptions = {
  platform: 'shorts',
  length: 'auto',
  clipCount: 8,
  layout: 'auto',
  captionStyle: 'pop',
  showHook: true,
  useAudienceData: true,
  focus: '',
  motion: 'subtle',
  music: 'auto',
  musicVolume: 15,
  pace: 'natural',
  emoji: false,
  flashForward: false,
};

const KEY = 'crestclip:opts';

/** The clip settings the person used last time (one-off fields like picked ranges are dropped). */
export function savedOptions(): ProjectOptions {
  const o: ProjectOptions = { ...DEFAULT_OPTIONS, ...readLocal<Partial<ProjectOptions>>(KEY, {}) };
  delete o.ranges;
  delete o.joinRanges;
  delete o.instructions;
  delete o.rules;
  return o;
}

export function saveOptions(o: ProjectOptions) {
  const { ranges: _r, joinRanges: _j, instructions: _i, rules: _ru, ...keep } = o;
  writeLocal(KEY, keep);
}
