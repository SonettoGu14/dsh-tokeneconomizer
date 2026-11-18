/**
 * Repository identity shared by every component: the same checkout and every
 * clone of the same remote must land on one state directory, while unrelated
 * repositories must never share one.
 *
 * Mirrors TokenEconomizer's rule: an `origin` remote wins (all clones and
 * worktrees of it share what was learned), otherwise the absolute checkout
 * path identifies the repository.
 * @module dsh-te-core/repo-key
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

/**
 * Hosts whose repository paths are case-insensitive. Elsewhere the path keeps
 * its case: on a self-hosted forge `Team/Api` and `team/api` may be two repos.
 */
const CASE_INSENSITIVE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org'])

/** Reads `remote.origin.url` for a directory, or undefined when absent. */
export type RemoteReader = (cwd: string) => string | undefined

/** Reads the checkout root for a directory, or undefined when not a checkout. */
export type TopLevelReader = (cwd: string) => string | undefined

/**
 * Normalize a git remote URL to `host/path`, dropping credentials, default
 * ports, a trailing `.git` and trailing slashes so ssh and https agree.
 *
 * A non-default port is kept: `127.0.0.1:3000` and `127.0.0.1:3001` are
 * different servers, and merging them would mix two repositories' facts. Paths
 * keep their case except on hosts known to be case-insensitive (GitHub), where
 * `Owner/Repo` and `owner/repo` are the same repository.
 * @param url - raw `remote.origin.url`.
 * @returns the normalized identity, or undefined when the URL is unusable.
 */
export function normalizeRemoteUrl(url: string): string | undefined {
  const raw = url.trim()
  if (raw === '') return undefined
  let host: string
  let path: string
  let port = ''
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
    port = parsed.port
  }
  if (host === '') return undefined
  const cleanHost = host.toLowerCase()
  if (cleanHost === '' || cleanHost === '.') return undefined
  let cleanPath = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  if (cleanPath === '' || cleanPath.startsWith('..')) return undefined
  if (CASE_INSENSITIVE_HOSTS.has(cleanHost)) cleanPath = cleanPath.toLowerCase()
  // 22 and 443 are the default ssh/https ports, so they identify nothing extra.
  const suffix = port === '' || port === '22' || port === '443' ? '' : `:${port}`
  return `${cleanHost}${suffix}/${cleanPath}`
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
 * Default reader: ask git for the root of the checkout containing `cwd`.
 * @param cwd - directory to inspect.
 * @returns the absolute checkout root, or undefined when this is not a checkout.
 */
export function gitTopLevel(cwd: string): string | undefined {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
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
 * @param readTopLevel - checkout-root seam, so subdirectories of one remote-less
 * checkout share a bucket instead of each getting their own.
 * @returns the repository identity; never throws.
 */
export function resolveRepoKey(
  cwd: string,
  readRemote: RemoteReader = gitOriginRemote,
  readTopLevel: TopLevelReader = gitTopLevel,
): RepoIdentity {
  try {
    const remote = readRemote(cwd)
    if (remote !== undefined) {
      const normalized = normalizeRemoteUrl(remote)
      if (normalized !== undefined) return { key: `remote:${normalized}`, source: 'remote' }
    }
  } catch {
    // A broken checkout must degrade to the path rule, never break a session.
  }
  try {
    const root = readTopLevel(cwd)
    if (root !== undefined && root !== '') return { key: `path:${root}`, source: 'path' }
  } catch {
    // Same rule: a broken checkout must never break a session.
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
