import { z } from 'zod';

export const updateWatermarkSchema = z
  .object({
    enabled: z.boolean(),
    position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
    size: z.enum(['small', 'medium', 'large']),
    opacity: z.number().int().min(20).max(100),
    /** any spot on the frame (0-1 across / down the room inside the edge gaps); 0 and 1 are the edges */
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .partial()
  .refine((v) => (v.x == null) === (v.y == null), 'Send both x and y.');
