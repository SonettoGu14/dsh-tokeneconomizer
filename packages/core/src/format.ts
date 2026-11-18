/**
 * Human-readable token counts.
 *
 * Reports are read in a chat pane, so a count is rendered with one decimal and
 * a unit suffix above a thousand; exact integers stay exact below it.
 *
 * @module dsh-te-core/format
 */

/** Render a token count as `999`, `12.3k`, `1.24M`. */
export function formatTokens(count: number): string {
  const rounded = Math.round(count)
  const magnitude = Math.abs(rounded)
  if (magnitude < 1_000) return String(rounded)
  // A threshold, not a plain division: 999_960 would otherwise render as the
  // nonsense "1000.0k". Each unit hands over just before its own rollover.
  if (magnitude < 999_950) return `${(rounded / 1_000).toFixed(1)}k`
  if (magnitude < 999_995_000) return `${(rounded / 1_000_000).toFixed(2)}M`
  return `${(rounded / 1_000_000_000).toFixed(2)}B`
}
