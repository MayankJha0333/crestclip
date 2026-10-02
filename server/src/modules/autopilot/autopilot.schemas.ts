import { z } from 'zod';
import { optionsSchema } from '../projects/projects.schemas.js';
import { DEFAULT_CAPTION } from './autopilot.engine.js';
import { isValidZone } from './autopilot.time.js';

/** A posting time, "HH:MM" (24 h). */
const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;

export const autopilotSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sources: z
    .array(
      z.object({
        kind: z.enum(['youtube_channel', 'youtube_topic']),
        value: z.string().trim().min(1).max(300),
        channelId: z.string().max(40).nullish(),
        label: z.string().max(200).nullish(),
        region: z.string().max(4).nullish(),
      }),
    )
    .min(1, 'Add at least one source')
    .max(20),
  filters: z.object({
    minViews: z.coerce.number().int().min(0).max(1e10).default(10_000),
    minMinutes: z.coerce.number().min(1).max(600).default(5),
    maxMinutes: z.coerce.number().min(1).max(900).default(180),
    maxAgeDays: z.coerce.number().int().min(1).max(365).default(14),
    waitHours: z.coerce.number().min(0).max(240).default(24),
  }),
  options: optionsSchema.partial().default({}),
  clipsPerVideo: z.coerce.number().int().min(1).max(5).default(2),
  times: z.array(z.string().regex(timeRe, 'Times look like 13:00')).min(1, 'Pick at least one posting time').max(12),
  timezone: z.string().refine(isValidZone, 'Unknown time zone'),
  targets: z.array(z.object({ connectionId: z.string(), privacy: z.enum(['public', 'unlisted', 'private']).optional() })).min(1, 'Pick at least one account to post to'),
  mode: z.enum(['review', 'auto']).default('review'),
  caption: z.string().max(2200).default(DEFAULT_CAPTION),
  rightsConfirmed: z.literal(true, { errorMap: () => ({ message: 'Confirm you have the rights to clip and repost these videos' }) }),
});
export type AutopilotForm = z.infer<typeof autopilotSchema>;
