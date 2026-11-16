/**
 * What a shell transcript can teach without a model.
 *
 * These are deliberately narrow, mechanical extractors: a fact is only proposed
 * when a command *failed here* and a different form of the same intent
 * *succeeded here* in the same session. That keeps extraction free, explainable
 * and impossible to hallucinate — the price is that it only sees repairs the
 * session already performed.
 *
 * Ported from the LLM-free half of TokenEconomizer's `microskills/envfacts.py`
 * (`form_repair` and `env_value` families).
 *
 * @module @gyk/dsh-te-core/shell
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
}

/** Environment assignments a command may carry in front of the executable. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Wrappers whose second word is the real executable. */
const WRAPPERS = new Set(['npx', 'pnpm', 'npm', 'yarn', 'uv', 'uvx', 'bun', 'bunx'])

/** Split a command line into words, dropping quoting noise. */
function words(command: string): string[] {
  return command.trim().split(/\s+/).filter((word) => word !== '')
}

/** Strip leading environment assignments and `cd … &&` prefixes. */
function stripPrefixes(wordList: string[]): string[] {
  let rest = [...wordList]
  for (;;) {
    const head = rest[0]
    if (head !== undefined && ENV_ASSIGNMENT.test(head)) {
      rest = rest.slice(1)
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

/**
 * The intent a command serves, ignoring how it was invoked.
 * @param command - the raw command line.
 * @returns e.g. `pytest` for `python -m pytest`, bare `pytest`, or `npx pytest`.
 */
export function intentOf(command: string): string | undefined {
  const rest = stripPrefixes(words(command))
  const head = rest[0]
  if (head === undefined) return undefined
  const base = head.includes('/') ? (head.split('/').pop() ?? head) : head
  const next = rest[1]
  if ((base === 'python' || base === 'python3' || base === 'py') && next === '-m') return rest[2]
  if (base === 'uv' && next === 'run') return rest[2]
  if (WRAPPERS.has(base)) {
    if (next === 'dlx' || next === 'exec') return rest[2]
    if (next === 'run' || next === 'test') return undefined
    return next
  }
  return base
}

/**
 * The form a command used: its distinctive invocation prefix.
 * @param command - the raw command line.
 * @returns e.g. `python -m pytest`, `pytest`, `npx jest`.
 */
export function formOf(command: string): string | undefined {
  const rest = stripPrefixes(words(command))
  const head = rest[0]
  if (head === undefined) return undefined
  const base = head.includes('/') ? (head.split('/').pop() ?? head) : head
  const next = rest[1]
  if ((base === 'python' || base === 'python3' || base === 'py') && next === '-m') {
    return rest[2] === undefined ? base : `${base} -m ${rest[2]}`
  }
  if (base === 'uv' && next === 'run') return rest[2] === undefined ? base : `uv run ${rest[2]}`
  if (WRAPPERS.has(base) && next !== undefined) return `${base} ${next}`
  return base
}

/**
 * Name a failure from its output.
 * @param output - combined output text.
 * @returns a stable class, or undefined when the failure is not recognisable
 * (an unnamed failure is not evidence for any claim).
 */
export function errorClassOf(output: string): string | undefined {
  if (/command not found|: not found\b/i.test(output)) return 'command-not-found'
  if (/ModuleNotFoundError|No module named/i.test(output)) return 'module-missing'
  if (/ImportError|cannot import name/i.test(output)) return 'import-error'
  if (/No such file or directory/i.test(output)) return 'no-such-file'
  if (/Permission denied/i.test(output)) return 'permission'
  if (/is not set\b|environment variable .* (?:is )?(?:missing|not set)|KeyError/i.test(output)) return 'missing-env'
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

/**
 * Propose facts from one session's shell calls.
 *
 * Only same-session repairs count: failure first, then a different form of the
 * same intent that succeeded. A claim is only made when the failure has a name.
 *
 * @param calls - the session's shell calls in order.
 * @returns candidate facts, one per distinct repair.
 */
export function extractFacts(calls: readonly ShellCall[]): FactCandidate[] {
  const found = new Map<string, FactCandidate>()

  for (let index = 0; index < calls.length; index += 1) {
    const failed = calls[index]
    if (failed === undefined || failed.ok) continue
    const errorClass = errorClassOf(failed.output)
    if (errorClass === undefined) continue
    const intent = intentOf(failed.command)
    const failedForm = formOf(failed.command)
    if (intent === undefined || failedForm === undefined) continue

    const later = calls.slice(index + 1)
    const envName = missingEnvOf(failed.output)

    if (envName !== undefined) {
      const working = later.find((call) => call.ok && setsEnv(call.command, envName))
      if (working !== undefined) {
        const key = `env-value:${intent}:${envName}`
        if (!found.has(key)) {
          found.set(key, {
            key,
            family: 'env-value',
            intent,
            text: `\`${intent}\` needs \`${envName}\` set here; \`${envName}=…\` works.`,
          })
        }
        continue
      }
    }

    const repaired = later.find((call) => {
      if (!call.ok) return false
      if (intentOf(call.command) !== intent) return false
      const form = formOf(call.command)
      return form !== undefined && form !== failedForm && !setsEnv(call.command, envName ?? '\u0000')
    })
    if (repaired === undefined) continue
    const workingForm = formOf(repaired.command)
    if (workingForm === undefined) continue
    const key = `form-repair:${intent}:${failedForm}`
    if (found.has(key)) continue
    found.set(key, {
      key,
      family: 'form-repair',
      intent,
      text: `\`${failedForm}\` fails here with ${ERROR_PHRASES[errorClass] ?? errorClass}; \`${workingForm}\` works.`,
    })
  }

  return [...found.values()]
}

/**
 * Whether this session shows the waste a fact claims to prevent.
 *
 * A form fact's waste is its exact failing form; an env fact's waste is the same
 * missing-variable failure. Used to decide whether injected facts are still
 * paying for themselves.
 *
 * @param calls - the session's shell calls.
 * @param key - the fact's stable key.
 * @returns true when the failure the fact warns about happened anyway.
 */
export function wasteRecurred(calls: readonly ShellCall[], key: string): boolean {
  if (key.startsWith('form-repair:')) {
    const [, intent, failingForm] = key.split(':')
    return calls.some(
      (call) => !call.ok && intentOf(call.command) === intent && formOf(call.command) === failingForm,
    )
  }
  if (key.startsWith('env-value:')) {
    const [, intent, name] = key.split(':')
    if (name === undefined) return false
    return calls.some(
      (call) => !call.ok && intentOf(call.command) === intent && missingEnvOf(call.output) === name,
    )
  }
  return false
}

/**
 * Whether a session contradicts a fact it was told.
 *
 * A form fact claims a form fails here: it is contradicted when that form
 * succeeds. An env fact claims a variable must be supplied: it is contradicted
 * when the same intent succeeds without it. Contradiction needs no model — the
 * transcript either shows the claim holding or it does not.
 *
 * @param calls - the session's shell calls.
 * @param key - the fact's stable key.
 * @returns true when the session shows the claim is false in this repository.
 */
export function contradicted(calls: readonly ShellCall[], key: string): boolean {
  if (key.startsWith('form-repair:')) {
    const [, , failingForm] = key.split(':')
    if (failingForm === undefined) return false
    return calls.some((call) => call.ok && formOf(call.command) === failingForm)
  }
  if (key.startsWith('env-value:')) {
    const [, intent, name] = key.split(':')
    if (name === undefined) return false
    return calls.some(
      (call) => call.ok && intentOf(call.command) === intent && !setsEnv(call.command, name),
    )
  }
  return false
}
