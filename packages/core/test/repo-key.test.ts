import { describe, expect, it } from 'vitest'
import { normalizeRemoteUrl, repoKeyDirName, resolveRepoKey } from '../src/index.ts'

describe('normalizeRemoteUrl', () => {
  it('folds the case of a GitHub path, which GitHub itself does', () => {
    expect(normalizeRemoteUrl('git@github.com:Owner/Repo.git')).toBe('github.com/owner/repo')
    expect(normalizeRemoteUrl('https://github.com/owner/repo')).toBe('github.com/owner/repo')
  })

  it('keeps the case of a path on a host that may be case-sensitive', () => {
    expect(normalizeRemoteUrl('git@gitea.example.com:Team/Api.git')).toBe('gitea.example.com/Team/Api')
  })

  it('strips a .git suffix whatever its case', () => {
    expect(normalizeRemoteUrl('https://github.com/owner/repo.GIT')).toBe('github.com/owner/repo')
  })

  it('normalizes an https remote and strips credentials', () => {
    expect(normalizeRemoteUrl('https://user:token@github.com/owner/repo.git')).toBe('github.com/owner/repo')
    expect(normalizeRemoteUrl('https://github.com/owner/repo')).toBe('github.com/owner/repo')
  })

  it('drops the default ssh port but keeps a non-default one', () => {
    expect(normalizeRemoteUrl('ssh://git@github.com:22/owner/repo.git')).toBe('github.com/owner/repo')
    expect(normalizeRemoteUrl('https://github.com:443/owner/repo')).toBe('github.com/owner/repo')
    expect(normalizeRemoteUrl('ssh://git@host:2222/team/api')).toBe('host:2222/team/api')
  })

  it('keeps two servers on one host apart', () => {
    expect(normalizeRemoteUrl('http://127.0.0.1:3000/team/api.git')).toBe('127.0.0.1:3000/team/api')
    expect(normalizeRemoteUrl('http://127.0.0.1:3001/team/api.git')).toBe('127.0.0.1:3001/team/api')
  })

  it('rejects what cannot identify a repository', () => {
    expect(normalizeRemoteUrl('')).toBeUndefined()
    expect(normalizeRemoteUrl('not a url')).toBeUndefined()
  })
})

describe('resolveRepoKey', () => {
  it('prefers the origin remote, so clones and worktrees share one bucket', () => {
    const identity = resolveRepoKey('/tmp/checkout', () => 'git@github.com:Owner/Repo.git')
    expect(identity).toEqual({ key: 'remote:github.com/owner/repo', source: 'remote' })
  })

  it('falls back to the checkout root when there is no remote', () => {
    const identity = resolveRepoKey(
      '/tmp/local-only/subdir',
      () => undefined,
      () => '/tmp/local-only',
    )
    expect(identity).toEqual({ key: 'path:/tmp/local-only', source: 'path' })
  })

  it('falls back to the absolute path when git has no answer either', () => {
    const identity = resolveRepoKey('/tmp/local-only', () => undefined, () => undefined)
    expect(identity).toEqual({ key: 'path:/tmp/local-only', source: 'path' })
  })

  it('never throws when the remote reader fails', () => {
    const identity = resolveRepoKey(
      '/tmp/broken',
      () => {
        throw new Error('git exploded')
      },
      () => {
        throw new Error('git exploded')
      },
    )
    expect(identity).toEqual({ key: 'path:/tmp/broken', source: 'path' })
  })

  it('maps a key to a filesystem-safe directory name', () => {
    const name = repoKeyDirName('remote:github.com/owner/repo')
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(name).not.toContain('/')
  })
})
