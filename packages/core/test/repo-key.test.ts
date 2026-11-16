import { describe, expect, it } from 'vitest'
import { normalizeRemoteUrl, repoKeyDirName, resolveRepoKey } from '../src/index.ts'

describe('normalizeRemoteUrl', () => {
  it('normalizes an scp-style GitHub remote', () => {
    // Hosts are case-insensitive; paths are not, so the path keeps its case.
    expect(normalizeRemoteUrl('git@github.com:Owner/Repo.git')).toBe('github.com/Owner/Repo')
  })

  it('normalizes an https remote and strips credentials', () => {
    expect(normalizeRemoteUrl('https://user:token@github.com/owner/repo.git')).toBe('github.com/owner/repo')
    expect(normalizeRemoteUrl('https://github.com/owner/repo')).toBe('github.com/owner/repo')
  })

  it('normalizes an ssh:// remote with a port', () => {
    expect(normalizeRemoteUrl('ssh://git@github.com:22/owner/repo.git')).toBe('github.com/owner/repo')
  })

  it('rejects what cannot identify a repository', () => {
    expect(normalizeRemoteUrl('')).toBeUndefined()
    expect(normalizeRemoteUrl('not a url')).toBeUndefined()
  })
})

describe('resolveRepoKey', () => {
  it('prefers the origin remote, so clones and worktrees share one bucket', () => {
    const identity = resolveRepoKey('/tmp/checkout', () => 'git@github.com:Owner/Repo.git')
    expect(identity).toEqual({ key: 'remote:github.com/Owner/Repo', source: 'remote' })
  })

  it('falls back to the absolute path when there is no remote', () => {
    const identity = resolveRepoKey('/tmp/local-only', () => undefined)
    expect(identity).toEqual({ key: 'path:/tmp/local-only', source: 'path' })
  })

  it('never throws when the remote reader fails', () => {
    const identity = resolveRepoKey('/tmp/broken', () => {
      throw new Error('git exploded')
    })
    expect(identity).toEqual({ key: 'path:/tmp/broken', source: 'path' })
  })

  it('maps a key to a filesystem-safe directory name', () => {
    const name = repoKeyDirName('remote:github.com/owner/repo')
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(name).not.toContain('/')
  })
})
