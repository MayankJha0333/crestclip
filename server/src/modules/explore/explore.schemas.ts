import { z } from 'zod';

export const searchQuerySchema = z.object({
  source: z.enum(['youtube', 'twitch']).default('youtube'),
  q: z.string().trim().min(1).max(200),
  type: z.enum(['videos', 'shorts', 'channels', 'live', 'vods', 'clips']).default('videos'),
  duration: z.enum(['any', 'short', 'medium', 'long']).default('any'),
  sort: z.enum(['relevance', 'views', 'date', 'rating']).default('relevance'),
  uploaded: z.enum(['any', 'hour', 'today', 'week', 'month', 'year']).default('any'),
  limit: z.coerce.number().int().min(4).max(50).default(24),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const channelQuerySchema = z.object({
  url: z.string().trim().min(1).max(400),
  tab: z.enum(['videos', 'shorts', 'streams', 'live', 'vods', 'highlights', 'clips']).optional(),
  sort: z.enum(['time', 'views']).default('time'),
  range: z.enum(['day', 'week', 'month', 'all']).default('month'),
  limit: z.coerce.number().int().min(4).max(60).default(30),
});
export type ChannelQuery = z.infer<typeof channelQuerySchema>;
