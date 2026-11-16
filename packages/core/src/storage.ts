/**
 * Where plugin state lives, and how it is written.
 *
 * Every component keeps its state under `<DSH_HOME>/dsh-tokeneconomizer/`, so
 * a user who wants a clean slate deletes one directory. `DSH_HOME` is the
 * environment override DSH itself honours; the fallback is `~/.dsh`.
 *
 * Writes are atomic (temp file in the same directory, then rename), because a
 * component may be writing while another DSH process folds the same repo.
 *
 * @module @gyk/dsh-te-core/storage
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** The plugin's directory name inside the DSH home. */
export const STATE_DIR_NAME = 'dsh-tokeneconomizer'

/**
 * Resolve the DSH home directory.
 *
 * @param env - process environment; `DSH_HOME` wins when set and non-empty.
 * @param home - platform home directory, a test seam.
 * @returns the absolute DSH home path.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const expanded = expandHome(raw.trim(), home)
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(home, '.dsh')
}

/** Expand a leading `~` in a configured path. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/** The plugin's state root: `<DSH_HOME>/dsh-tokeneconomizer`. */
export function stateRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(resolveDshHome(env, home), STATE_DIR_NAME)
}

/**
 * Read a JSON file, or `undefined` when it is absent or unreadable.
 *
 * A corrupt state file must degrade to "no state", never to a thrown error in
 * a session hook.
 */
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/**
 * Write JSON atomically: serialize, write a sibling temp file, rename over the
 * target. Creates parent directories as needed.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value)}\n`, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
