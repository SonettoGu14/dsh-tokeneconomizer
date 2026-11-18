# Development plan and handoff

Status: **0.1.0 implemented, not published**. This document is the map for
whoever picks the project up next (human or agent): where it stands, what is
worth doing in which order, what was deliberately rejected, and how to tell
whether a change actually helped.

Snapshot 2026-11-18, commit `23dde70`:

| fact | value |
|---|---|
| packages | 5 × `0.1.0`, publishable config in place |
| npm | **nothing published**; the five names were unclaimed when last checked |
| repository | public, `github.com/SonettoGu14/dsh-tokeneconomizer` |
| tests | 113 unit + 8 integration, `pnpm verify` green |
| pin | `@deepseek-ai/dsh >=0.2.2-rc.3 <0.3.0` |
| code | ~3.8k lines TypeScript across 5 packages, no runtime dependency but `schemastery` |

## Where it stands

Three mechanisms from [microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer)
are ported as independent Cordis plugins:

- **cost** — folds the four disjoint usage buckets into cache-weighted
  "equivalent fresh-input tokens" and records one ledger per repository. It is
  the only component that cannot affect a session: it registers a command service
  and nothing else.
- **facts** — observes shell calls, extracts two families of repairs
  (`form-repair`: this command form fails and that one works; `env-value`: this
  command needs that variable), stores only the form and the variable name, and
  injects at most one short message when a fact is both confirmed across three
  tasks and still paying for itself (firing rate ≥ 0.4 over ≥ 4 exercised tasks).
- **prune** — counts sessions in which a tool was not called and hides tools idle
  for five sessions from the next session's tool list. Off by default because
  changing the tool set invalidates the cached prompt prefix.

What is proven: the mechanisms behave as specified — unit tests cover the math
and the lifecycle, the integration harness runs a real agent turn against real
dsh packages and asserts what the model request and the state file actually
contain, and one real headless session produced a sane ledger. What is **not**
proven: that any of it reduces cost on real work over many sessions. That is the
central open question and the only thing worth prioritising over everything else.

## How to work here

```sh
pnpm install && pnpm build      # lib/ is gitignored; `prepare` builds too
pnpm verify                     # 113 unit + 8 integration tests
```

Track A/B changes in a throwaway profile; never experiment in the daily one:

```sh
dsh --profile te --from-default-profile headless
dsh plugin --profile te add link:$PWD/packages/bundle   # also appends to bundles
dsh --profile te --dump-config | grep sonettogu14       # three rows
dsh --profile te "Reply with exactly: ok"               # needs a credential
```

Gotchas that cost time before (all verified):

- DSH 0.2.2 ends the turn with *"The selected tool executor is unavailable"*
  unless `@deepseek-ai/dsh-tool-executor-native` is in the composition. In the
  harness it must be mounted as the **module namespace object**; wrapping it as
  `{name, apply}` drops its `inject` and fails with *"cannot get property tools
  without inject"*.
- `tools.restrict()` only works on the **agent-scoped** context
  (`agent.ctx.get('tools')`); a context-global restriction throws.
- `session/disposed` listeners are not awaited by the harness. Persist on
  `session/flush`, which is.
- `agent/pre-step` handlers must `return next()` and spread the returned decision
  (`{...decision, messages:[...]}`); rebuilding it drops `startsRequestSeries`.
- `pnpm install` is the only sane way to get the dsh dev/peer packages; the
  package itself has no `dependencies` other than `schemastery`.
- On macOS, `mv` of a checkout containing `node_modules` with `.app` bundles can
  deadlock in `rename(2)`. Use `rsync -a --exclude node_modules` and delete after.
- `pnpm test` and `pnpm test:integration` are separate Vitest projects; the
  integration one is single-process because every test points `DSH_HOME` at its
  own temp directory.

## Release checklist (P0)

The code and metadata are ready; only the publish step and its consequences
remain.

1. Confirm the five names are still free:
   `for n in dsh-te-core dsh-te-cost dsh-te-facts dsh-te-prune dsh-te; do curl -s -o /dev/null -w "$n %{http_code}\n" "https://registry.npmjs.org/@sonettogu14%2f$n"; done`
2. `pnpm verify && pnpm release:dry` — inspect the dry-run tarballs: `LICENSE`,
   `cordis.patch.yml`, `lib/`, `src/`; `workspace:*` must appear as `0.1.0`.
3. Authenticate without five OTP prompts: create an npm **automation token**
   (the account's 2FA is `auth-and-writes`) and put it in `~/.npmrc` as
   `//registry.npmjs.org/:_authToken=...`, or run `pnpm release` and answer each
   prompt.
4. `pnpm release` (builds, then publishes topologically: core → components →
   bundle).
5. Sanity-check the published surface: `npm view @sonettogu14/dsh-te` for the
   repository/homepage/bugs links, then install **from npm** in a throwaway
   profile (`dsh plugin --profile te add @sonettogu14/dsh-te`) and run one
   headless task — link installs and registry installs differ.
6. Tag the release (`git tag v0.1.0 && git push --tags`) and write a short
   release note: what each component does, the defaults, and the evidence caveat.

## Roadmap

Ordered by value per unit of work. Each item has an acceptance criterion so it
can be closed without an argument.

### P0 — ship the distribution loop

Publish `0.1.0` (above) and add CI: `.github/workflows/verify.yml` running
`pnpm install && pnpm verify` on node 24 for pushes and PRs. Right now the only
thing standing between a typo and a published package is a local command.

**Done when** the five packages resolve from npm and a red PR fails CI.

### P1 — prove or disprove the value (highest priority)

Everything else is speculative until this exists. The mechanisms already record
what is needed — `facts.json` has `fired`/`firedWaste` per fact, `cost.json` has
per-repository equivalents and session counts — but nothing aggregates it into a
claim.

Build a report first (cheap, no new behaviour):

- `/te-facts stats` (or a `--json` flag): per repository, facts by state, firing
  rate, how many sessions injected, which facts were retired and why.
- `/te-cost trend`: equivalents per session over time for one repository, with
  the session count, so a before/after comparison is possible at all.

Then run the experiment, which is the honest part:

- **fact effect**: a repository with enough history (say ≥ 20 sessions after
  enabling facts). Metric: median equivalents/session for the injected sessions
  vs the sessions where the fact existed but was not yet injectable. Secondary:
  does the firing rate fall after injection (the model learned it) or stay high
  (the fact is wrong or the model ignores it)?
- **prune effect**: before enabling, measure the tools' share of the prompt via
  `tokenMeter` (`contextBreakdown.toolsTokens`) and count requests whose reason is
  `change` (a prefix invalidation). Hiding a tool is only a win if the saved
  schema tokens exceed the re-read cost of the sessions that followed.
- **cost**: nothing to prove; it is accounting. It is the instrument for the
  other two, which is why it shipped first.

**Done when** a short report exists with numbers and a recommendation per
mechanism: keep on by default, keep off, or tune a threshold. Publish it as
`docs/MEASUREMENT.md`, including the confounders that were not controlled.

### P2 — documentation parity

The README explains what the plugins do; it does not yet answer "why this rather
than the alternatives", which is what a reader deciding whether to install asks
first.

- First screen: one paragraph naming the three costs it attacks (repeated
  environment discovery, unused tool schemas, cache-unfriendly buckets) with the
  cache-weighted unit explained in one sentence.
- A **feature matrix** with three honest columns like the closest prior art does:
  *tested* (unit + integration harness), *verified manually* (real headless run),
  *known limitation*. Right now the README prose mixes these levels.
- A prior-art section: upstream TokenEconomizer (Python, host-agnostic) and the
  several npm plugins that appeared in the same weeks; say plainly what is
  different here (TypeScript, fifth-package composability, self-measuring
  ledgers) and what is not (no loop guard, fewer fact families, smaller test
  surface than at least one competitor).

**Done when** a new reader can decide in under a minute and is not surprised
later.

### P3 — facts coverage (the mechanism with the clearest upside)

Two of the six upstream envfact families are implemented. The remaining four —
`arg-repair` (right command, wrong flag), `absent-tool` (tool isn't installed
here), `empty-probe` (a "list" command returned nothing, so there is nothing to
find), `boundary` (a command must run from a subdirectory) — all fall out of the
same `ShellCall` evidence and need no model call.

- Extend `packages/core/src/shell.ts` with one detector per family plus
  `exercised`/`wasteRecurred`/`contradicted` for its key shape, and integration
  coverage for at least `arg-repair`.
- Keep the injection budget fixed (≤4 facts, ≤600 chars): more families means
  competition for slots, which is correct — the firing rate decides.
- Add a `te-facts prune` command for the user to drop a wrong fact by hand; the
  lifecycle cannot see everything (a fact can be true and still useless).

**Done when** the new families are unit-tested, covered by at least one
integration case, and the README's family list is accurate.

### P4 — decide prune's default, with data

Prune ships off because a tool-set change re-reads the whole prompt. That is a
prediction, not a measurement. Use the P1 instrument to settle it:

- if P1 shows saved schema tokens dominate, flip `enabled` to `true` in the
  bundle's `cordis.patch.yml` and document the threshold (`idleSessions`).
- if not, keep it off and say so in the README with the number that decided it.

Also worth doing regardless: scan cost is currently one `schemas()` call per
agent, which is fine; the `/te-prune` output should show *equivalent tokens
saved* rather than a tool count, because that is the unit the user cares about.

**Done when** the default has a number behind it and the README states it.

### P5 — cost depth

- machine-readable output (`/te-cost --json`) so scripts can read the ledger;
- per-session breakdown by bucket, so a spike can be attributed (context growth
  vs output vs cache misses);
- a maintenance rule for the weights table: the table is a snapshot of published
  ratios, so date-stamp the source in the file header and add a test that fails
  when a *known* model id silently falls back to `default` (a new model should be
  an explicit decision, not an accident);
- if DSH ever exposes a separate 1h cache-write bucket, price it (currently
  conservative: 1h writes are charged as 5m writes).

**Done when** a scheduled job could detect price drift without a human reading
the code.

### Explicitly not planned

- **Loop guard.** Upstream never validated it on real spirals and says so; DSH
  already ships `dsh-repeat-tool-reminder` for the detection half. Revisit only
  with evidence of real spirals that the reminder misses — not because the
  upstream has a fourth mechanism.
- **Context compression / cost UI.** `dsh-compaction*` and
  `@linxin666/dsh-usage` own those; duplicating them adds conflict surface.
- **An LLM proposer for facts.** It spends tokens to maybe save tokens, and the
  deterministic two families are free. It becomes interesting only after P1 shows
  the deterministic ones work.
- **Python sidecar.** The whole point of the port is native TypeScript.

## Technical debt

Known, accepted for now. Each item names why it is not yet fixed.

| item | why it is still open | effort |
|---|---|---|
| `shell.ts` option table is heuristic (`VALUE_FLAGS`) | a wrong entry can name the wrong command form; only fixtures cover it, and every new CLI adds a case | S |
| `repo-key` collision rules (ports, case folding, `.git`, top-level) | covered by tests but still a rule set that will meet a host it did not anticipate | S |
| `formatTokens(999_960)` renders `1000.0k` | cosmetic, and the fix changes every command's output | XS |
| evidence window is a constant (20 tasks) | no data on what it should be; P1 can measure the effect of retiring later | S |
| unknown model weights are maintained by hand | every published model needs a row; the P5 fallback test is the guard | S |
| no CI, no CHANGELOG, no SECURITY.md | P0/backlog; none block a release | S |
| `lib/` is gitignored, so a fresh clone needs `pnpm build` before `link:` install works | documented in the README install section; a `prepare` script covers registry installs | — |
| two Vitest configs share an alias block | acceptable duplication; unify only if a third project appears | XS |

Deliberate non-fixes (documented, will not be "fixed" without a reason): the 1h
cache-write estimate, `formatTokens` rounding, and the shell heuristics above —
they are approximations chosen to stay simple, and each says so in its docstring.

## Decisions the owner needs to make

1. **Publish now or after P1?** Publishing reserves the names and gives users
   something; it also freezes the API shape at a moment when P1 may change
   defaults. Suggestion: publish `0.1.0` now, let the next change be `0.2.0`.
2. **Is `@sonettogu14` the final scope?** Renaming a published scope is painful;
   if an org or brand name is likely, decide before step 1.
3. **Measurement or breadth next?** This plan says measurement (P1) before more
   mechanism (P3). If the goal is the opposite — more hooks before proof — say so
   and reorder.
4. **Language.** Everything is English today; the closest prior art ships a
   Chinese README as well. A `README.zh-CN.md` is cheap and, for this audience,
   probably worth it.
5. **Loop guard**: is the DSH reminder genuinely enough, or is a smaller
   "redirect once" worth building on top of it?

## Definition of done for any change

- `pnpm verify` green, including at least one integration case when the change
  touches injection, the tool surface, or persistence.
- The README describes the user-visible behaviour; the docstring says *why* the
  choice was made, not what the code does.
- If a threshold or magic number changed, the reason is in the commit body.
- If on-disk shape changed, the record `version` is bumped and the reader still
  accepts the old one.
- No new dependency without a sentence explaining why stdlib/existing packages do
  not suffice.
