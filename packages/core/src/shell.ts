/**
 * What a shell transcript can teach without a model.
 *
 * These are deliberately narrow, mechanical extractors: a fact is only proposed
 * when a command *failed here* and a different form of the same intent
 * *succeeded here* in the same session. That keeps extraction free, explainable
 * and impossible to hallucinate — the price is that it only sees repairs the
 * session already performed.
 *
 * Both families are keyed by the *form* that failed, not by a loose intent: two
 * invocations of the same tool are not interchangeable evidence, so a successful
 * `python --version` can neither confirm nor contradict a claim about
 * `python build.py`.
 *
 * Ported from the LLM-free half of TokenEconomizer's `microskills/envfacts.py`
 * (`form_repair` and `env_value` families).
 *
 * @module dsh-te-core/shell
 */

/** One shell invocation as the transcript recorded it. */
export interface ShellCall {
  readonly command: string
  readonly ok: boolean
  readonly output: string
}

/** A fact the extractors are willing to propose, before any lifecycle. */
export interface FactCandidate {
  /** Stable identity: the same repair learned twice must land on one fact. */
  readonly key: string
  readonly family: 'form-repair' | 'env-value'
  /** One sentence, ready to inject. */
  readonly text: string
  /** The intent the fact is about, so a repeat of the failure can be recognised. */
  readonly intent: string
}

/** How a failure reads to a developer. */
const ERROR_PHRASES: Record<string, string> = {
  'command-not-found': 'a command-not-found error',
  'module-missing': 'a module-not-found error',
  'no-such-file': 'a no-such-file error',
  'missing-env': 'a missing-environment error',
  permission: 'a permission error',
  'import-error': 'an import error',
  'type-error': 'a compiler error',
  'key-error': 'a KeyError',
}

/** Environment assignments a command may carry in front of the executable. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Wrappers whose later word is the real executable. */
const WRAPPERS = new Set(['npx', 'pnpm', 'npm', 'yarn', 'uv', 'uvx', 'bun', 'bunx'])

/** Wrapper subcommands that run another program. */
const RUN_SUBCOMMANDS = new Set(['run', 'exec', 'dlx'])

/** Package-manager subcommands that are not a program to learn about. */
const PACKAGE_SCRIPTS = new Set(['install', 'ci', 'add', 'remove', 'update', 'build', 'dev', 'start', 'lint'])

/** Interpreters whose first argument is the thing being run. */
const INTERPRETERS = new Set(['python', 'python3', 'py', 'node'])

/** Options that consume the next token, used to find the real executable. */
const VALUE_FLAGS = new Set([
  '--with',
  '--package',
  '-p',
  '--prefix',
  '--filter',
  '--workspace',
  '-w',
  '--dir',
  '-C',
  '--cwd',
  '--shell',
])

/** Longest token a fact may quote; a generated name is not a lesson. */
const MAX_TOKEN_CHARS = 80

/** Keep a quoted token short and free of markup characters. */
function clip(token: string): string {
  const clean = token.replace(/[`\u0000-\u001f]/g, '')
  return clean.length <= MAX_TOKEN_CHARS ? clean : `${clean.slice(0, MAX_TOKEN_CHARS - 1)}…`
}

/** Split a command line into words, keeping quoted spans together. */
function tokenize(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | undefined
  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current !== '') out.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current !== '') out.push(current)
  return out
}

/** Strip leading environment assignments, `env …` wrappers and `cd … &&` prefixes. */
function stripPrefixes(wordList: readonly string[]): string[] {
  let rest = [...wordList]
  for (;;) {
    const head = rest[0]
    if (head === undefined) return rest
    if (ENV_ASSIGNMENT.test(head)) {
      rest = rest.slice(1)
      continue
    }
    if (head === 'env') {
      rest = rest.slice(1)
      while (rest[0] !== undefined && (rest[0].startsWith('-') || ENV_ASSIGNMENT.test(rest[0]))) {
        rest = rest.slice(1)
      }
      continue
    }
    if (head === 'cd' || head === 'pushd') {
      const separator = rest.findIndex((word) => word === '&&' || word === ';')
      if (separator >= 0) {
        rest = rest.slice(separator + 1)
        continue
      }
    }
    return rest
  }
}

/** Index of the first non-option word at or after `from`. */
function firstOperand(wordList: readonly string[], from: number): number {
  let index = from
  for (;;) {
    const word = wordList[index]
    if (word === undefined) return index
    if (!word.startsWith('-')) return index
    index += VALUE_FLAGS.has(word) ? 2 : 1
  }
}

/** A command reduced to the form that failed and the intent it served. */
interface Parsed {
  readonly form: string
  readonly intent: string
}

/**
 * Parse cache. Settle parses the same commands once per fact, so without this a
 * repository with many facts re-parses its whole transcript per settle.
 */
const PARSED = new Map<string, Parsed | undefined>()

/** Parse with a bounded memo, so a long session cannot grow the cache forever. */
function parseCached(command: string): Parsed | undefined {
  if (PARSED.has(command)) return PARSED.get(command)
  const parsed = parse(command)
  if (PARSED.size > 2_000) PARSED.clear()
  PARSED.set(command, parsed)
  return parsed
}

/**
 * Reduce a command line to its invocation form and its intent.
 * @param command - the raw command line.
 * @returns undefined when the command runs no recognisable program.
 */
function parse(command: string): Parsed | undefined {
  const rest = stripPrefixes(tokenize(command))
  const head = rest[0]
  if (head === undefined) return undefined
  const base = head.includes('/') ? (head.split('/').pop() ?? head) : head
  const next = rest[1]

  if (INTERPRETERS.has(base)) {
    if (next === '-m') {
      const moduleName = rest[firstOperand(rest, 2)]
      return moduleName === undefined ? undefined : { form: `${base} -m ${moduleName}`, intent: moduleName }
    }
    // `python build.py` and `python --version` are different claims, so the
    // script is part of the form even though both serve the same interpreter.
    if (next !== undefined && !next.startsWith('-')) return { form: `${base} ${next}`, intent: base }
    return { form: base, intent: base }
  }

  if (WRAPPERS.has(base)) {
    if (next !== undefined && RUN_SUBCOMMANDS.has(next)) {
      if ((base === 'npm' || base === 'pnpm' || base === 'yarn') && next === 'run') {
        const script = rest[firstOperand(rest, 2)]
        return script === undefined ? undefined : { form: `${base} run ${script}`, intent: script }
      }
      const tool = rest[firstOperand(rest, 2)]
      return tool === undefined ? undefined : { form: `${base} ${next} ${tool}`, intent: tool }
    }
    // `npm test` runs a script, it does not run a program called `test`.
    if (next === 'test') return undefined
    const tool = rest[firstOperand(rest, 1)]
    if (tool === undefined) return undefined
    if ((base === 'npm' || base === 'pnpm' || base === 'yarn') && PACKAGE_SCRIPTS.has(tool)) return undefined
    return { form: `${base} ${tool}`, intent: tool }
  }

  return { form: base, intent: base }
}

/**
 * The intent a command serves, ignoring how it was invoked.
 * @param command - the raw command line.
 * @returns e.g. `pytest` for `python -m pytest`, bare `pytest`, or `npx pytest`.
 */
export function intentOf(command: string): string | undefined {
  return parseCached(command)?.intent
}

/**
 * The form a command used: its distinctive invocation prefix.
 * @param command - the raw command line.
 * @returns e.g. `python -m pytest`, `pytest`, `npx jest`, `python build.py`.
 */
export function formOf(command: string): string | undefined {
  return parseCached(command)?.form
}

/**
 * Name a failure from its output.
 * @param output - combined output text.
 * @returns a stable class, or undefined when the failure is not recognisable
 * (an unnamed failure is not evidence for any claim).
 */
export function errorClassOf(output: string): string | undefined {
  if (/ModuleNotFoundError|No module named/i.test(output)) return 'module-missing'
  if (/ImportError|cannot import name/i.test(output)) return 'import-error'
  if (/\berror TS\d+/.test(output)) return 'type-error'
  if (missingEnvOf(output) !== undefined) return 'missing-env'
  // A bare `python build.py` traceback names the key without saying the
  // environment is wrong; that is a code failure, not an env claim.
  if (/KeyError/.test(output)) return 'key-error'
  if (/\bcommand not found\b/.test(output)) return 'command-not-found'
  if (/Permission denied|EACCES/.test(output)) return 'permission'
  if (/No such file or directory|ENOENT/.test(output)) return 'no-such-file'
  return undefined
}

/**
 * Find the environment variable a failure says is missing.
 * @param output - combined output text.
 * @returns the variable name, when the output names one.
 */
export function missingEnvOf(output: string): string | undefined {
  const named =
    /(?:environment variable|env var|variable|set)\s+[`'"]([A-Z][A-Z0-9_]{2,})[`'"]/i.exec(output) ??
    /\b([A-Z][A-Z0-9_]{2,})\s+is not set\b/.exec(output) ??
    /KeyError:\s*['"]([A-Z][A-Z0-9_]{2,})['"]/.exec(output)
  return named?.[1]
}

/** Whether a command sets `name` in its own environment prefix. */
function setsEnv(command: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}=`).test(command)
}

/** Split a fact key back into its family and two parts. */
function keyParts(key: string): { family: string; first: string; second?: string } {
  const [family = '', first = '', second] = key.split(':')
  return { family, first, second }
}

/**
 * How far one session's shell calls got toward a fact.
 *
 * A repository with no facts is not evidence that the mechanism is broken: it
 * can mean no shell call failed, that no failure named its cause, that the
 * failing command had no recognisable program, or that nothing was repaired.
 * These counts are what separates those cases.
 */
export interface FactDiagnostics {
  /** Shell calls recorded; only calls carrying a command are counted. */
  calls: number
  /** Calls the tool reported as failed. */
  failed: number
  /** Failures whose output names a recognised error class. */
  classified: number
  /** Classified failures whose command reduces to a form and an intent. */
  parsed: number
  /** Classified, parsed failures a later same-intent call repaired. */
  repaired: number
}

/** One session's candidate facts, with the counts that explain them. */
export interface FactAnalysis extends FactDiagnostics {
  candidates: FactCandidate[]
}

/**
 * Propose facts from one session's shell calls.
 *
 * Only same-session repairs count: failure first, then a different form of the
 * same intent that succeeded. A claim is only made when the failure has a name.
 *
 * @param calls - the session's shell calls in order.
 * @returns the candidates, one per distinct repair, plus the funnel that
 * produced them.
 */
export function analyzeFacts(calls: readonly ShellCall[]): FactAnalysis {
  const found = new Map<string, FactCandidate>()
  const diagnostics: FactDiagnostics = {
    calls: calls.length,
    failed: 0,
    classified: 0,
    parsed: 0,
    repaired: 0,
  }

  for (let index = 0; index < calls.length; index += 1) {
    const failed = calls[index]
    if (failed === undefined || failed.ok) continue
    diagnostics.failed += 1
    const errorClass = errorClassOf(failed.output)
    if (errorClass === undefined) continue
    diagnostics.classified += 1
    const failedParsed = parseCached(failed.command)
    if (failedParsed === undefined) continue
    diagnostics.parsed += 1
    const { form: failedForm, intent } = failedParsed

    const later = calls.slice(index + 1)
    const envName = missingEnvOf(failed.output)

    if (envName !== undefined) {
      // The repair must be the same intent that failed, with the variable set:
      // an unrelated `API_KEY=x git push` demonstrates nothing about `python`.
      const working = later.find(
        (call) => call.ok && intentOf(call.command) === intent && setsEnv(call.command, envName),
      )
      if (working !== undefined) {
        diagnostics.repaired += 1
        const key = `env-value:${clip(failedForm)}:${clip(envName)}`
        if (!found.has(key)) {
          found.set(key, {
            key,
            family: 'env-value',
            intent,
            text: `\`${clip(failedForm)}\` needs \`${clip(envName)}\` set here; \`${clip(envName)}=…\` works.`,
          })
        }
        continue
      }
    }

    const repaired = later.find((call) => {
      if (!call.ok) return false
      const parsed = parseCached(call.command)
      return parsed !== undefined && parsed.intent === intent && parsed.form !== failedForm
    })
    if (repaired === undefined) continue
    const workingForm = formOf(repaired.command)
    if (workingForm === undefined) continue
    diagnostics.repaired += 1
    const key = `form-repair:${clip(intent)}:${clip(failedForm)}`
    if (found.has(key)) continue
    found.set(key, {
      key,
      family: 'form-repair',
      intent,
      text: `\`${clip(failedForm)}\` fails here with ${ERROR_PHRASES[errorClass] ?? errorClass}; \`${clip(workingForm)}\` works.`,
    })
  }

  return { ...diagnostics, candidates: [...found.values()] }
}

/**
 * Propose facts from one session's shell calls.
 * @param calls - the session's shell calls in order.
 * @returns candidate facts, one per distinct repair.
 */
export function extractFacts(calls: readonly ShellCall[]): FactCandidate[] {
  return analyzeFacts(calls).candidates
}

/**
 * The calls in which a session shows the waste a fact claims to prevent.
 *
 * A form fact's waste is its exact failing form; an env fact's waste is the same
 * form asking for the same variable. Returning the calls rather than a boolean
 * is what lets the same evidence be counted *and* priced: the ledger needs the
 * tokens those failures burned, not just whether they happened.
 *
 * @param calls - the session's shell calls.
 * @param key - the fact's stable key.
 * @returns the failing calls the fact warns about, in order.
 */
export function wastedCalls(calls: readonly ShellCall[], key: string): ShellCall[] {
  const { family, first, second } = keyParts(key)
  if (family === 'form-repair') {
    const [, intent = '', failingForm = ''] = key.split(':')
    return calls.filter(
      (call) => !call.ok && intentOf(call.command) === intent && formOf(call.command) === failingForm,
    )
  }
  if (family === 'env-value' && second !== undefined) {
    return calls.filter(
      (call) => !call.ok && formOf(call.command) === first && missingEnvOf(call.output) === second,
    )
  }
  return []
}

/**
 * Whether this session shows the waste a fact claims to prevent.
 * @param calls - the session's shell calls.
 * @param key - the fact's stable key.
 * @returns true when the failure the fact warns about happened anyway.
 */
export function wasteRecurred(calls: readonly ShellCall[], key: string): boolean {
  return wastedCalls(calls, key).length > 0
}

/**
 * Whether the situation a fact is about arose in this session at all.
 *
 * Independent of injection and of the outcome: this is the denominator of the
 * firing rate, so an env fact counts only when the variable was asked for or
 * supplied, not merely because the interpreter ran.
 *
 * @param calls - the session's shell calls.
 * @param key - the fact's stable key.
 * @returns true when the session touched the fact's situation.
 */
export function exercised(calls: readonly ShellCall[], key: string): boolean {
  const { family, first, second } = keyParts(key)
  if (family === 'form-repair') {
    const [, intent = ''] = key.split(':')
    return calls.some((call) => intentOf(call.command) === intent)
  }
  if (family === 'env-value' && second !== undefined) {
    return calls.some(
      (call) => missingEnvOf(call.output) === second || setsEnv(call.command, second) && formOf(call.command) === first,
    )
  }
  return false
}

/**
 * Whether a session contradicts a fact it was told.
 *
 * A form fact claims a form fails here: it is contradicted when that form
 * succeeds. An env fact claims a form needs a variable: it is contradicted when
 * that same form succeeds without it. Contradiction needs no model — the
 * transcript either shows the claim holding or it does not.
 *
 * @param calls - the session's shell calls.
 * @param key - the fact's stable key.
 * @returns true when the session shows the claim is false in this repository.
 */
export function contradicted(calls: readonly ShellCall[], key: string): boolean {
  const { family, first, second } = keyParts(key)
  if (family === 'form-repair') {
    const [, , failingForm = ''] = key.split(':')
    if (failingForm === '') return false
    return calls.some((call) => call.ok && formOf(call.command) === failingForm)
  }
  if (family === 'env-value' && second !== undefined) {
    return calls.some(
      (call) => call.ok && formOf(call.command) === first && !setsEnv(call.command, second),
    )
  }
  return false
}
