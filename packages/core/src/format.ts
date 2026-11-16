/**
 * Human-readable token counts.
 *
 * Reports are read in a chat pane, so a count is rendered with one decimal and
 * a unit suffix above a thousand; exact integers stay exact below it.
 *
 * @module @sonettogu14/dsh-te-core/format
 */

/** Render a token count as `999`, `12.3k`, `1.24M`. */
export function formatTokens(count: number): string {
  const rounded = Math.round(count)
  if (Math.abs(rounded) < 1000) return String(rounded)
  if (Math.abs(rounded) < 1_000_000) return `${(rounded / 1000).toFixed(1)}k`
  return `${(rounded / 1_000_000).toFixed(2)}M`
}
