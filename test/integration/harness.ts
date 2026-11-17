/**
 * Offline end-to-end harness: real DSH packages, a scripted model adapter.
 *
 * The unit tests prove the mechanisms in isolation. They cannot prove the two
 * promises that matter to a user: that the injected note actually reaches the
 * model request, and that a pruned tool actually disappears from it. This
 * harness mounts the real `dsh-*` services in a bare Cordis application — no
 * profile, no network, no credentials — and replaces the provider adapter with
 * one that records every request it is handed and replays a scripted answer.
 *
 * @module test/integration/harness
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Commands from '@deepseek-ai/dsh-commands'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as nativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

import { repoKeyDirName, resolveRepoKey, stateRoot } from '../../packages/core/src/index.ts'
import { apply as applyCost } from '../../packages/cost/src/index.ts'
import type { Config as CostConfig } from '../../packages/cost/src/index.ts'
import { apply as applyFacts } from '../../packages/facts/src/index.ts'
import type { Config as FactsConfig } from '../../packages/facts/src/index.ts'
import { apply as applyPrune } from '../../packages/prune/src/index.ts'
import type { Config as PruneConfig } from '../../packages/prune/src/index.ts'

/** One message as the provider adapter received it. */
export interface RecordedMessage {
  role: string
  source: string | null
  text: string
}

/** One request as the provider adapter received it. */
export interface RecordedRequest {
  provider: string
  model: string
  toolNames: string[]
  systemText: string
  messages: RecordedMessage[]
}

/** What the fake model does on one request. */
export type Decision =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; args: Record<string, unknown> }

/** Context handed to a script function. */
export interface ScriptContext {
  index: number
  request: RecordedRequest
  harness: Harness
}

/** A tool the model may call, as the harness registers it. */
export interface ToolFixture {
  name: string
  parameters?: Record<string, unknown>
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

/** The mounted application plus the handles a test needs. */
export interface Harness {
  ctx: Context
  projectRoot: string
  stateDir: string
  requests: RecordedRequest[]
  /** Mount an extra tool the scripted model may call. */
  tool(fixture: ToolFixture): void
  /** Create an agent bound to the harness project. */
  agent(): Promise<{ id: string; stop(): Promise<void> }>
  /** Submit one user turn and wait until the agent goes idle. */
  turn(handle: { id: string }, text?: string): Promise<void>
  /** End one session and wait for durable state (`session/flush`). */
  end(handle: { id: string }): Promise<void>
  /** Read a JSON file under this repository's state directory. */
  readRepo(name: string): unknown
  /** Write a JSON file under this repository's state directory (seeding). */
  writeRepo(name: string, value: unknown): void
  /** Read a JSON file under `$DSH_HOME/dsh-tokeneconomizer/`. */
  readState(relativePath: string): unknown
  /** Write a JSON file under `$DSH_HOME/dsh-tokeneconomizer/` (seeding). */
  writeState(relativePath: string, value: unknown): void
  /** Repository state directory for the harness project. */
  repoDir(): string
  dispose(): Promise<void>
}

const DEFAULT_USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 50,
  cacheWriteTokens: 5,
}

/** Scripted provider: records the request, then replays one decision. */
class ScriptedAdapter extends LlmAdapter {
  requests: RecordedRequest[] = []
  harness: Harness | undefined
  constructor(
    private readonly script: (context: ScriptContext) => Decision,
    private readonly usage: TokenUsage,
  ) {
    super()
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'integration-model', name: 'Integration Model' }])
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const request: RecordedRequest = {
      provider: options.provider,
      model: options.model,
      toolNames: (options.tools ?? []).map((tool) => tool.name),
      systemText: (options.messages ?? [])
        .filter((message) => message.role === 'system')
        .flatMap((message) => message.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
      messages: (options.messages ?? []).map((message) => ({
        role: message.role,
        source: message.source?.kind ?? null,
        text: (message.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('|'),
      })),
    }
    this.requests.push(request)
    const decision = this.script({
      index: this.requests.length - 1,
      request,
      harness: this.harness as Harness,
    })

    if (decision.kind === 'tool') {
      const callId = `call_${request.messages.length}_${decision.name}` as unknown as ToolCallId
      const args = JSON.stringify(decision.args ?? {})
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: decision.name, argumentsDelta: args }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: callId, name: decision.name, arguments: args },
      }
      yield { type: 'usage', usage: this.usage }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: decision.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: decision.text } }
    yield { type: 'usage', usage: this.usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A shell-like tool whose failure text exercises the fact extractors. */
export function makeShellTool(): ToolFixture {
  return {
    name: 'bash',
    parameters: { command: { type: 'string', description: 'command to run' } },
    run: (args) => {
      const command = String(args.command ?? '')
      if (command.includes('python -m pytest')) throw new Error('bash: python: command not found')
      return 'ok'
    },
  }
}

export interface StartOptions {
  /** Mounted components; facts and prune are off unless listed. */
  components?: readonly ('cost' | 'facts' | 'prune')[]
  /** Fake usage reported for every request. */
  usage?: TokenUsage
  /** What the model does for request `index`. */
  script?: (context: ScriptContext) => Decision
  /** Tools available to the agent. */
  tools?: readonly ToolFixture[]
  cost?: Partial<CostConfig>
  facts?: Partial<FactsConfig>
  prune?: Partial<PruneConfig>
}

/** Create a temp git project so repository identity is a real remote. */
export function makeProject(): { root: string; cleanup(): void } {
  const base = mkdtempSync(join(os.tmpdir(), 'dsh-te-it-'))
  const root = join(base, 'project')
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:integration/fixture.git'], { cwd: root })
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

const STATE_NAMESPACE = 'dsh-tokeneconomizer'

/** Mount the real DSH application, the requested components, and a fake model. */
export async function startHarness(options: StartOptions = {}): Promise<Harness> {
  const project = makeProject()
  const stateDir = mkdtempSync(join(os.tmpdir(), 'dsh-te-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = stateDir

  const ctx = new Context()
  for (const plugin of [
    SystemPrompt,
    ToolRuntime,
    nativeToolExecutor,
    LlmRuntime,
    SessionStore,
    SessionProjectionRegistry,
    AgentRegistry,
    AgentLoop,
    Commands,
  ]) {
    await (ctx.plugin as unknown as (value: unknown) => Promise<void>)(plugin)
  }

  const adapter = new ScriptedAdapter(
    options.script ?? (() => ({ kind: 'text', text: 'DONE' })),
    options.usage ?? DEFAULT_USAGE,
  )
  ctx.llm.registerAdapter(['integration-provider'], adapter as never)

  const handles = new Map<string, Awaited<ReturnType<typeof ctx.agents.create>>>()
  const statePath = (relative: string): string => join(stateDir, STATE_NAMESPACE, relative)
  const repoDirPath = (): string => join(statePath('repos'), repoKeyDirName(resolveRepoKey(project.root).key))

  const harness: Harness = {
    ctx,
    projectRoot: project.root,
    stateDir,
    requests: adapter.requests,
    tool(fixture) {
      ctx.tools.register(
        defineTool({
          name: fixture.name,
          description: `integration fixture tool ${fixture.name}`,
          parameters: (fixture.parameters ?? {}) as never,
          output: {
            schema: { type: 'string' },
            render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
          },
          async execute(args: unknown) {
            return String(await fixture.run((args ?? {}) as Record<string, unknown>))
          },
        }) as never,
      )
    },
    async agent() {
      const created = await ctx.agents.create({
        sessionId: `session-${handles.size + 1}` as never,
        agentOptions: { provider: 'integration-provider', model: 'integration-model' },
        meta: { cwd: project.root },
      } as never)
      handles.set(created.agent.id as unknown as string, created)
      return {
        id: created.agent.id as unknown as string,
        stop: async () => {
          await created.dispose()
        },
      }
    },
    async turn(handle, text = 'do the task') {
      const created = handles.get(handle.id)
      if (created === undefined) throw new Error(`unknown agent ${handle.id}`)
      created.agent.followup(
        createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      )
      await created.agent.whenIdle()
    },
    async end(handle) {
      const created = handles.get(handle.id)
      if (created === undefined) return
      handles.delete(handle.id)
      await created.dispose()
      await (ctx as unknown as { parallel(name: string): Promise<void> }).parallel('session/flush')
    },
    readRepo(name) {
      return harness.readState(join('repos', repoKeyDirName(resolveRepoKey(project.root).key), name))
    },
    writeRepo(name, value) {
      harness.writeState(join('repos', repoKeyDirName(resolveRepoKey(project.root).key), name), value)
    },
    readState(relative) {
      try {
        return JSON.parse(readFileSync(statePath(relative), 'utf8')) as unknown
      } catch {
        return undefined
      }
    },
    writeState(relative, value) {
      const target = statePath(relative)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`)
    },
    repoDir: repoDirPath,
    async dispose() {
      for (const created of handles.values()) await created.dispose().catch(() => {})
      handles.clear()
      await (ctx.fiber as unknown as { dispose(): Promise<void> }).dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(stateDir, { recursive: true, force: true })
      project.cleanup()
    },
  }

  adapter.harness = harness

  for (const fixture of options.tools ?? []) harness.tool(fixture)

  if (options.components?.includes('cost')) {
    applyCost(ctx as never, { enabled: true, persist: true, ...options.cost } as CostConfig)
  }
  if (options.components?.includes('facts')) {
    applyFacts(ctx as never, { enabled: true, maxFacts: 4, maxChars: 600, ...options.facts } as FactsConfig)
  }
  if (options.components?.includes('prune')) {
    applyPrune(ctx as never, { enabled: true, idleSessions: 5, maxHidden: 8, protected: [], ...options.prune } as PruneConfig)
  }

  // Services mount asynchronously inside their fibers.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return harness
}

/** `stateRoot()` for the current harness (set by `startHarness`). */
export function harnessStateRoot(): string {
  return stateRoot()
}
