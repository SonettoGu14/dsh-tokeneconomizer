/**
 * Slash-command argument parsing.
 *
 * A command is typed by a person in a chat line, so the grammar stays small:
 * positionals, `--flag`, `--name=value`, and `--name value` when the value is
 * a number. The numeric rule is what keeps a boolean flag from swallowing the
 * word after it (`--json repo` keeps `repo` as a positional).
 *
 * @module dsh-te-core/args
 */

/** One parsed command line. */
export interface ParsedArgs {
  /** Positional words, in order. */
  readonly words: readonly string[]
  /** Flags by name, without the leading `--`; `true` when the flag took no value. */
  readonly flags: Readonly<Record<string, string | true>>
}

/** The only values a bare `--name value` pair binds. */
const NUMERIC = /^-?\d+(?:\.\d+)?$/

/**
 * Parse the raw input of a slash command.
 * @param rawInput - everything the user typed after the command name.
 * @returns positionals and flags.
 */
export function parseArgs(rawInput: string): ParsedArgs {
  const words: string[] = []
  const flags: Record<string, string | true> = {}
  const tokens = rawInput.split(/\s+/).filter((token) => token !== '')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string
    if (!token.startsWith('--')) {
      words.push(token)
      continue
    }
    const body = token.slice(2)
    if (body === '') continue
    const equals = body.indexOf('=')
    if (equals >= 0) {
      flags[body.slice(0, equals)] = body.slice(equals + 1)
      continue
    }
    const next = tokens[index + 1]
    if (next !== undefined && NUMERIC.test(next)) {
      flags[body] = next
      index += 1
      continue
    }
    flags[body] = true
  }
  return { words, flags }
}
