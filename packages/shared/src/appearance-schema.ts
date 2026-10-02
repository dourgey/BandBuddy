import { z } from 'zod'
import type { Appearance } from './appearance.js'

/** Validation belongs on the IPC boundary, outside the renderer boot path. */
export const appearanceSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  theme: z.enum(['warm', 'dark', 'system']).default('warm'),
  density: z.enum(['normal', 'compact']).default('normal'),
  effects: z.enum(['standard', 'reduced']).default('standard')
}) satisfies z.ZodType<Appearance>
