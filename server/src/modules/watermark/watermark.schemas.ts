import { z } from 'zod';

export const updateWatermarkSchema = z
  .object({
    enabled: z.boolean(),
    position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
    size: z.enum(['small', 'medium', 'large']),
    opacity: z.number().int().min(20).max(100),
  })
  .partial();
