import { z } from 'zod';

/** Settings saved earlier may hold `null` for "not set" — treat it like a missing field. */
export const dropNulls = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null)) : v);

/** Clip settings for a new project (also used by Autopilot). */
export const optionsFields = z.object({
  platform: z.enum(['shorts', 'tiktok', 'reels']).default('shorts'),
  length: z.enum(['auto', 'short', 'medium', 'long']).default('auto'),
  clipCount: z.coerce.number().int().min(1).max(30).default(8),
  layout: z.enum(['auto', 'fill', 'fit', 'split']).default('auto'),
  captionStyle: z.enum(['pop', 'clay', 'neon', 'comic', 'minimal', 'none']).default('pop'),
  showHook: z.coerce.boolean().default(true),
  motion: z.enum(['none', 'subtle', 'dynamic']).default('subtle'),
  music: z.string().max(40).default('auto'),
  musicVolume: z.coerce.number().min(0).max(100).default(15),
  pace: z.enum(['off', 'natural', 'fast']).default('natural'),
  emoji: z.coerce.boolean().default(false),
  flashForward: z.coerce.boolean().default(false),
  ranges: z
    .array(z.object({ start: z.number().min(0), end: z.number().min(0) }))
    .max(20)
    .optional(),
  joinRanges: z.coerce.boolean().optional(),
  useAudienceData: z.coerce.boolean().default(true),
  focus: z.string().max(600).default(''),
  instructions: z.string().max(6000).optional(),
  logo: z
    .object({
      id: z
        .string()
        .regex(/^[a-f0-9]{8}$/)
        .nullable(),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      size: z.enum(['small', 'medium', 'large']),
      opacity: z.number().int().min(20).max(100),
    })
    .optional(),
});
export const optionsSchema = z.preprocess(dropNulls, optionsFields);

export const createProjectSchema = z.object({ url: z.string().url(), options: optionsSchema.default({}) });

export const createFolderSchema = z.object({ url: z.string().url(), options: optionsSchema.default({}) });
export const folderPreviewSchema = z.object({ url: z.string().url() });
export const createBatchSchema = z.object({ urls: z.array(z.string().url()).min(1).max(15), options: optionsSchema.default({}) });

export const pickClipsSchema = z.object({
  ranges: z
    .array(z.object({ start: z.number().min(0), end: z.number().min(0) }))
    .min(1)
    .max(20),
  join: z.boolean().default(false),
});
