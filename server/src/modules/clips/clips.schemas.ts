import { z } from 'zod';

export const clipPatchSchema = z.object({
  title: z.string().max(140).optional(),
  hook: z.string().max(90).optional(),
  description: z.string().max(2200).optional(),
  hashtags: z.array(z.string().max(60)).max(15).optional(),
  start: z.number().min(0).optional(),
  end: z.number().min(0).optional(),
  layout: z.enum(['auto', 'fill', 'fit', 'split']).optional(),
  captionStyle: z.enum(['pop', 'clay', 'neon', 'comic', 'minimal', 'none']).optional(),
  showHook: z.boolean().optional(),
  motion: z.enum(['none', 'subtle', 'dynamic']).optional(),
  pace: z.enum(['off', 'natural', 'fast']).optional(),
  emoji: z.boolean().optional(),
  flashForward: z.boolean().optional(),
  music: z.object({ track: z.string().max(40), volume: z.number().min(0).max(100), duck: z.boolean() }).optional(),
});

export type ClipPatch = z.infer<typeof clipPatchSchema>;
