/**
 * The install-all bundle's own behaviour: `/te`.
 *
 * Without a command, this package was a dependency list plus a patch — a pure
 * meta-package, which is installable but invisible: nothing in a session tells
 * you the three components are there, and nothing says how to switch one off.
 * `/te` answers both from whatever components are actually mounted, so it also
 * works when the user installed only one of them.
 *
 * It reads the component services through `ctx.get`, never imports them at
 * runtime, and reports nothing it cannot see.
 *
 * @module dsh-te
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import { formatTokens } from 'dsh-te-core'

/** The part of `dsh-te-cost` this command reads. */
interface CostView {
  sessionSnapshot(session: Session): { messages: number; equivalent: number; model?: string }
  repoSnapshot(session: Session): Promise<{ equivalent: number; sessions: number; history: readonly unknown[] } | undefined>
}

/** The part of `dsh-te-facts` this command reads. */
interface FactsView {
  snapshot(session: Session): Promise<{
    sessions: number
    total: number
    active: number
    candidate: number
    retired: number
    injectedTasks: number
    injectedTokens: number
  }>
}

/** The part of `dsh-te-prune` this command reads. */
interface PruneView {
  snapshot(session: Session): Promise<{
    sessions: number
    tracked: number
    candidates: readonly string[]
    hiddenNow: number
    idleSessions: number
  }>
}

/** Mount the bundle's command. */
export function apply(ctx: Context): void {
  // The command service can be registered after this plugin loads, so the
  // effect waits for it instead of reading `ctx.commands` at apply time.
  ctx.inject(['commands'], (ctx) => {
    ctx.effect(() =>
      ctx.commands.register({
        name: 'te',
        description: 'Status of the three dsh-te components, and how to switch one off',
        handler: async (invocation) => ({
          kind: 'success',
          text: await overview(invocation.agent.session, ctx),
        }),
      }),
    )
  })
}

/** One line per component that is actually mounted, plus how to switch it off. */
async function overview(session: Session, ctx: Context): Promise<string> {
  const lines = ['dsh-te — three components behind one install.', '']
  const cost = ctx.get('teCost') as CostView | undefined
  const facts = ctx.get('teFacts') as FactsView | undefined
  const prune = ctx.get('tePrune') as PruneView | undefined

  if (cost === undefined) {
    lines.push('cost     not installed')
  } else {
    const current = cost.sessionSnapshot(session)
    const repo = await cost.repoSnapshot(session)
    const sessionPart = `${formatTokens(current.equivalent)} eq this session (${current.messages} req)`
    const repoPart =
      repo === undefined
        ? 'no repo totals yet'
        : `${formatTokens(repo.equivalent)} eq over ${repo.sessions} repo sessions`
    lines.push(`cost     ${sessionPart} · ${repoPart}`)
  }

  if (facts === undefined) {
    lines.push('facts    not installed')
  } else {
    const summary = await facts.snapshot(session)
    const states =
      summary.total === 0
        ? 'no facts yet'
        : `${summary.total} facts: ${summary.active} active · ${summary.candidate} candidate · ${summary.retired} retired`
    const spend =
      summary.injectedTasks === 0
        ? 'never injected'
        : `injected ${summary.injectedTasks} tasks / ${formatTokens(summary.injectedTokens)} eq`
    lines.push(`facts    ${summary.sessions} sessions · ${states} · ${spend}`)
  }

  if (prune === undefined) {
    lines.push('prune    not installed')
  } else {
    const summary = await prune.snapshot(session)
    const would = summary.candidates.length === 0 ? 'nothing to hide' : `would hide ${summary.candidates.join(', ')}`
    lines.push(
      `prune    ${summary.sessions} sessions · ${summary.tracked} tools tracked · ${would}${summary.hiddenNow > 0 ? ` · ${summary.hiddenNow} hidden now` : ''}`,
    )
  }

  lines.push('')
  lines.push(
    'Switch one off in the profile\'s cordis.patch.yml by adding "disabled: true" under its row',
  )
  lines.push('(te-cost, te-facts, te-prune), or with the switch on the DSH Plugins page.')
  return lines.join('\n')
}
