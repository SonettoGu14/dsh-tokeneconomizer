import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name; it must match the `cordis.patch.yml` row id/name pair. */
export const name = 'dsh-te-facts'

/** Repository-scoped facts learned from sessions. */
export interface Config {
  /** Mount this component. Off contributes nothing at all. */
  enabled: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
})

/**
 * Mount the component on a DSH context.
 *
 * P0 scaffold: the entry point exists and validates its settings; the behaviour
 * lands in the stage that owns this component.
 */
export function apply(_ctx: Context, _config: Config): void {}
