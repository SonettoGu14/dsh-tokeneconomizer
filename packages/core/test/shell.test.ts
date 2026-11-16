import { describe, expect, it } from 'vitest'
import { errorClassOf, extractFacts, formOf, intentOf, missingEnvOf, wasteRecurred } from '../src/index.ts'

describe('intent', () => {
  it('looks through the way a tool was invoked', () => {
    expect(intentOf('pytest -q tests/')).toBe('pytest')
    expect(intentOf('python -m pytest -q')).toBe('pytest')
    expect(intentOf('npx jest --watch=false')).toBe('jest')
    expect(intentOf('uv run pytest')).toBe('pytest')
    expect(intentOf('git status --short')).toBe('git')
  })

  it('ignores environment prefixes and cd chains', () => {
    expect(intentOf('FOO=1 pytest')).toBe('pytest')
    expect(intentOf('cd packages/core && pytest')).toBe('pytest')
  })

  it('has no intent for an empty command', () => {
    expect(intentOf('  ')).toBeUndefined()
  })
})

describe('form', () => {
  it('keeps the distinctive invocation prefix', () => {
    expect(formOf('python -m pytest tests/a.py')).toBe('python -m pytest')
    expect(formOf('pytest tests/a.py')).toBe('pytest')
    expect(formOf('npx vitest run')).toBe('npx vitest')
  })

  it('separates two forms of one intent', () => {
    expect(formOf('python -m pytest')).not.toBe(formOf('pytest'))
    expect(intentOf('python -m pytest')).toBe(intentOf('pytest'))
  })
})

describe('error naming', () => {
  it('names the failures it can recognise', () => {
    expect(errorClassOf('bash: pytest: command not found')).toBe('command-not-found')
    expect(errorClassOf('ModuleNotFoundError: No module named foo')).toBe('module-missing')
    expect(errorClassOf('cat: nope: No such file or directory')).toBe('no-such-file')
    expect(errorClassOf('API_KEY is not set')).toBe('missing-env')
    expect(errorClassOf('something odd happened')).toBeUndefined()
  })

  it('reads the missing variable when the output names one', () => {
    expect(missingEnvOf('API_KEY is not set')).toBe('API_KEY')
    expect(missingEnvOf('environment variable "TE_TOKEN" is required')).toBe('TE_TOKEN')
    expect(missingEnvOf("KeyError: 'DATABASE_URL'")).toBe('DATABASE_URL')
    expect(missingEnvOf('nothing here')).toBeUndefined()
  })
})

describe('extractFacts', () => {
  const failed = (command: string, output: string) => ({ command, ok: false, output })
  const ok = (command: string) => ({ command, ok: true, output: '' })

  it('learns a form repair performed inside one session', () => {
    const facts = extractFacts([
      failed('pytest -q', 'bash: pytest: command not found'),
      ok('python -m pytest -q'),
    ])
    expect(facts).toHaveLength(1)
    expect(facts[0]?.family).toBe('form-repair')
    expect(facts[0]?.text).toContain('`pytest` fails here')
    expect(facts[0]?.text).toContain('`python -m pytest` works')
  })

  it('learns an environment value the session had to supply', () => {
    const facts = extractFacts([
      failed('python build.py', 'API_KEY is not set'),
      ok('API_KEY=test python build.py'),
    ])
    expect(facts).toHaveLength(1)
    expect(facts[0]?.family).toBe('env-value')
    expect(facts[0]?.text).toContain('`API_KEY=…` works')
  })

  it('makes no claim from an unnamed failure', () => {
    expect(extractFacts([failed('pytest', 'weird output'), ok('python -m pytest')])).toEqual([])
  })

  it('makes no claim when the repair never happened', () => {
    expect(extractFacts([failed('pytest', 'command not found'), ok('pytest -q')])).toEqual([])
  })

  it('does not claim a repair from an earlier successful form', () => {
    expect(extractFacts([ok('python -m pytest'), failed('pytest', 'command not found')])).toEqual([])
  })

  it('collapses the same repair learned twice into one fact', () => {
    const facts = extractFacts([
      failed('pytest', 'command not found'),
      ok('python -m pytest'),
      failed('pytest', 'command not found'),
      ok('python -m pytest'),
    ])
    expect(facts).toHaveLength(1)
  })
})

describe('wasteRecurred', () => {
  it('sees the warned-about failure come back', () => {
    const calls = [{ command: 'pytest', ok: false, output: 'bash: pytest: command not found' }]
    expect(wasteRecurred(calls, 'form-repair:pytest:pytest')).toBe(true)
    expect(wasteRecurred(calls, 'form-repair:jest:jest')).toBe(false)
  })

  it('sees a missing variable come back', () => {
    const calls = [{ command: 'python build.py', ok: false, output: 'API_KEY is not set' }]
    expect(wasteRecurred(calls, 'env-value:python build.py:API_KEY')).toBe(true)
    expect(wasteRecurred(calls, 'env-value:python build.py:OTHER_KEY')).toBe(false)
  })
})
