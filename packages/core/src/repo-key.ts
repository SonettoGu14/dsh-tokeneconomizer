/**
 * Repository identity shared by every component: the same checkout and every
 * clone of the same remote must land on one state directory, while unrelated
 * repositories must never share one.
 *
 * Mirrors TokenEconomizer's rule: an `origin` remote wins (all clones and
 * worktrees of it share what was learned), otherwise the absolute checkout
 * path identifies the repository.
 * @module @gyk/dsh-te-core/repo-key
 */

import { spawnSync } from 'node:child_process'

/** How a repository was identified. */
export type RepoKeySource = 'remote' | 'path'

/** One resolved repository identity. */
export interface RepoIdentity {
  /** Stable, filesystem-safe key. */
  readonly key: string
  /** Which rule produced it. */
  readonly source: RepoKeySource
}

/** Reads `remote.origin.url` for a directory, or undefined when absent. */
export type RemoteReader = (cwd: string) => string | undefined

/**
 * Normalize a git remote URL to `host/path`, dropping credentials, ports,
 * a trailing `.git`, and trailing slashes so ssh and https agree.
 * @param url - raw `remote.origin.url`.
 * @returns the normalized identity, or undefined when the URL is unusable.
 */
export function normalizeRemoteUrl(url: string): string | undefined {
  const raw = url.trim()
  if (raw === '') return undefined
  let host: string
  let path: string
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw)
  if (scp !== null && !raw.includes('://')) {
    host = scp[1] ?? ''
    path = scp[2] ?? ''
  } else {
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      return undefined
    }
    host = parsed.hostname
    path = parsed.pathname
  }
  if (host === '') return undefined
  const cleanHost = host.toLowerCase()
  let cleanPath = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  if (cleanPath === '' || cleanPath.startsWith('..')) return undefined
  // Local file remotes (`/path/to/repo`, `file:///path`) have no host identity.
  if (cleanHost === 'localhost' || cleanHost === '.') return undefined
  return `${cleanHost}/${cleanPath}`
}

/**
 * Default reader: ask git for the origin remote of `cwd`.
 * @param cwd - directory to inspect.
 * @returns the remote URL, or undefined when this is not a git checkout.
 */
export function gitOriginRemote(cwd: string): string | undefined {
  const result = spawnSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
    encoding: 'utf8',
    timeout: 1_000,
    windowsHide: true,
  })
  if (result.status !== 0) return undefined
  const out = (result.stdout ?? '').trim()
  return out === '' ? undefined : out
}

/**
 * Resolve the identity of the repository a session ran in.
 * @param cwd - the session's absolute working directory.
 * @param readRemote - remote reader seam (tests inject a stub).
 * @returns the repository identity; never throws.
 */
export function resolveRepoKey(cwd: string, readRemote: RemoteReader = gitOriginRemote): RepoIdentity {
  try {
    const remote = readRemote(cwd)
    if (remote !== undefined) {
      const normalized = normalizeRemoteUrl(remote)
      if (normalized !== undefined) return { key: `remote:${normalized}`, source: 'remote' }
    }
  } catch {
    // A broken checkout must degrade to the path rule, never break a session.
  }
  return { key: `path:${cwd}`, source: 'path' }
}

/**
 * Make a repository key safe to use as one path segment.
 * @param key - the identity key.
 * @returns a reversible, collision-resistant directory name.
 */
export function repoKeyDirName(key: string): string {
  const encoded = Buffer.from(key, 'utf8').toString('base64url')
  return encoded === '' ? 'empty' : encoded
}
