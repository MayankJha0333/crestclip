import { z } from 'zod';

export const createPostsSchema = z.object({
  clipId: z.string(),
  targets: z
    .array(
      z.object({
        connectionId: z.string(),
        title: z.string().max(100).optional(),
        caption: z.string().max(5000).optional(),
        privacy: z.enum(['public', 'unlisted', 'private']).optional(),
      }),
    )
    .min(1),
  scheduledAt: z.number().int().nullable().optional(), // ms; null/omitted = now
});
export type CreatePosts = z.infer<typeof createPostsSchema>;
