# AGENTS.md

Guidance for working in this repository. It is a standalone project: the code
lives here, is reviewed here, and is released to npm from here. The global
`~/.dsh/AGENTS.md` still applies; this file adds what is specific to these
plugins.

## What this is

Three independent plugins for DeepSeek Harness, plus a shared library:

| package | what it does | default |
|---|---|---|
| `dsh-te-core` | pure functions: pricing weights, token buckets, fact lifecycle, shell parsing, repository keys, atomic storage | — (library) |
| `dsh-te-cost` | folds `session/event` usage into cache-weighted equivalent tokens; `/te-cost` | on |
| `dsh-te-facts` | learns command-form and env-var repairs per repository and injects the live ones; `/te-facts` | on |
| `dsh-te-prune` | hides tools that stayed idle for N sessions; `/te-prune` | **off** |
| `dsh-te` | bundle that inserts all three components | — |

The mechanisms come from [microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer)
(Apache-2.0, `arXiv:2610.22732`). The implementation is original TypeScript
against the Cordis plugin API; `NOTICE` records what is derived. A reference
checkout is usually a sibling directory (`../TokenEconomizer`).

## Current state

Snapshot 2026-11-18:

- five packages at `0.2.0`, published to npm under the **unscoped** names
  `dsh-te`, `dsh-te-core`, `dsh-te-cost`, `dsh-te-facts`, `dsh-te-prune`.
- a release is a pushed tag: `.github/workflows/publish.yml` re-runs
  `pnpm verify`, publishes all five through OIDC Trusted Publishing and creates
  the GitHub Release. No npm token lives on any machine.
  `.github/workflows/verify.yml` runs the same `pnpm verify` on every push to
  master and every pull request.
- `pnpm verify` green: 146 unit tests, 9 integration tests.
- 0.2.0 records what a trend needs: `cost.json` v2 keeps a per-session
  `history`, `facts.json` v2 keeps per-fact injection and waste token counts.
  Readers still accept v1 files.
- repository is public: <https://github.com/SonettoGu14/dsh-tokeneconomizer>.
- peer range pinned to `@deepseek-ai/dsh >=0.2.2-rc.3 <0.3.0`; every dsh package is
  declared in both `peerDependencies` and `devDependencies`.

[`docs/PLAN.md`](docs/PLAN.md) is the roadmap and the handoff note: what is next,
what was deliberately rejected, and how to measure whether any of it works.
Read it before starting feature work.

## Commands

```sh
pnpm install        # node >= 24.9, pnpm 11.28.5 via packageManager
pnpm build          # tsc -b (project references; lib/ is gitignored)
pnpm typecheck      # tsc -p tsconfig.test.json  (run after build)
pnpm test           # vitest, packages/*/test (146 unit tests)
pnpm test:integration  # vitest, test/integration (9 tests, real DSH packages)
pnpm verify         # build + typecheck + test + test:integration
pnpm release:dry    # checks only: clean tree, free tag, verify, prints the plan
pnpm release patch  # bump all five, commit, tag vX, push; CI publishes
pnpm publish:local  # manual fallback: publishes from this machine (needs a token)
```

Always run `pnpm verify` (or `pnpm build && pnpm typecheck && pnpm test &&
pnpm test:integration`) before committing. `typecheck` depends on `build`: the
test project consumes the emitted `lib/*.d.ts`.

To try a change in a real session:

```sh
dsh --profile <p> --from-default-profile headless     # once
dsh plugin --profile <p> add link:$PWD/packages/bundle
# then append "dsh-te" to dsh.profile.bundles in that profile's package.json:
# plugin add only installs the package, it does not register the bundle layer
dsh --profile <p> --dump-config | grep "== dsh-te"   # three te-* rows
dsh --profile <p> "Reply with exactly: ok"           # needs an LLM credential
```

## Repository layout

```
packages/core/     pure functions, no Cordis (pricing, buckets, lifecycle, shell, repo key, storage)
packages/cost/     session/event folding + the teCost service + /te-cost
packages/facts/    tools/result observation, agent/pre-step injection + /te-facts
packages/prune/    agent/created tool mask, session idle counters + /te-prune
packages/bundle/   cordis.patch.yml that inserts all three
test/integration/  real-composition harness (harness.ts) and its three suites
docs/PLAN.md       roadmap, priorities, debt and measurement protocol
```

## Layout rules

- `core` has no Cordis dependency and no I/O beyond `node:fs`. Everything that
  can be a pure function lives there and is unit tested directly.
- A component imports only `core` and dsh packages. Components never import each
  other; the one cross-component interaction (`facts` reporting its injected
  tokens to `cost`) is an optional `ctx.get('teCost')` lookup.
- Each component is independently installable and independently disableable
  (`enabled: false`). Do not introduce a shared "install-all" requirement.

## Invariants

These are the promises the README makes; breaking them is a bug even if tests
still pass.

1. **Never break a session.** Handlers catch their own errors, log via
   `ctx.logger(...).warn`, and degrade to doing nothing. No throw may escape an
   event listener or a waterfall step.
2. **`cost` stays invisible to the model.** It registers only `commands`; it must
   not change the prompt or the tool surface (`CostLedger.inject === ['commands']`
   is asserted).
3. **`facts` stays small and fail-open.** At most one injected message, ≤4 facts,
   ≤600 characters, and only when facts actually exist. A malformed
   `facts.json` entry is dropped, never thrown.
4. **`prune` decides once, early, and reversibly.** The mask is chosen at
   `agent/created` (before the first prompt is assembled), applied through
   `agent.ctx.get('tools')`, and disposed when the session ends. `restore` must
   dispose the live mask. Compression, skill and image tools are always
   protected — hiding them would make long sessions more expensive.
5. **Tool-surface changes invalidate the cached prompt prefix.** Any change to
   visible tool schemas or their order makes the next request re-read the whole
   prompt from the first changed token. That is why `prune` ships disabled and
   why it never changes its decision mid-session.
6. **State is written once, atomically, under one root.** Only
   `$DSH_HOME/dsh-tokeneconomizer/` (default `~/.dsh/...`), through
   `writeJsonAtomic`, directories `0700`, files `0600`. Durable writes are
   awaited through `session/flush`; `session/disposed` listeners are not awaited
   by the harness, so nothing may depend on them alone.
7. **No content on disk.** Facts keep command forms, an env-var name and an
   error class — never output text, file contents or absolute user paths.
8. **An unknown model id is a warning, not an error.** Cost accounting falls
   back to default weights and records `weightsSource`; a plugin must never
   refuse to run because a price is unknown.

## API contract worth re-checking when DSH changes

Peers are pinned `@deepseek-ai/dsh >=0.2.2-rc.3 <0.3.0`; dsh packages appear in
both `peerDependencies` and `devDependencies` (shared instances require both).

- observe: `tools/result(exec, result)`, `session/event(session, event)`,
  `session/disposed(session)`, `session/flush()`, `agent/created({agent})`
- intercept: `agent/pre-step` waterfall — call `next()`, and when returning
  `{kind:'enter'}` spread the decision (`{...decision, messages:[...]}`) so fields
  such as `startsRequestSeries` survive
- restrict: `tools.restrict({deny})` **on the agent-scoped context**; unknown or
  scope-local names throw, and an empty filter throws
- usage buckets: `TokenUsage` gives `inputTokens` (uncached), `outputTokens`,
  `cacheReadTokens`, `cacheWriteTokens` — disjoint, which is what makes the
  four-bucket fold correct

## Testing rules

- New behaviour needs a test in `packages/<pkg>/test/`. Core math gets
  hand-computed fixtures (no snapshots of implementation output).
- Use a real `cordis` `Context` in plugin tests; stub only the services the
  plugin consumes, and emit the real events rather than calling internals.
- Assert observable behaviour (state file, service method, injected message),
  not private fields.
- Anything that touches injection, the tool surface, or persistence also needs a
  case in `test/integration/`. Those run a real agent turn against the real dsh
  packages with a scripted `LlmAdapter` (no network, no credentials): assert on
  what the *model request* contains, not on what a unit test thinks was called.
- The integration harness in `test/integration/harness.ts` mounts a fixed
  composition; at minimum `dsh-tool-executor-native` must be there or DSH 0.2.2
  ends the turn with "The selected tool executor is unavailable". Each test gets
  a temp `$DSH_HOME` and a temp git project with a fake `origin` remote, which is
  what fixes the repository key.
- If a change alters on-disk shape, bump the record's `version` and keep the
  reader tolerant of older or malformed records.

## Versioning and release

- `0.x`, semver intent: a mechanism change is a minor bump, a fix is a patch.
  `pnpm release patch|minor|major` bumps all five `package.json` files together,
  commits, tags and pushes; never bump one package alone.
- Publish order is topological and pnpm handles it: `core` → components →
  bundle. Never publish the bundle before the packages it depends on.
- Publishing runs in CI through OIDC Trusted Publishing: each package name needs
  its own connection on npmjs.com (Settings → Publishing access → GitHub
  Actions: owner, repo, workflow `publish.yml`, environment empty). Connections
  are created once and cannot be edited, so delete and recreate rather than
  repair. `publishConfig.access` is `public` for all five.
- The granular token in `~/.npmrc` can run `pnpm publish:local`, but it cannot
  bypass 2FA for unpublish or trust management — those need the npm website.
- Record notable changes in the commit message; the README documents user-facing
  behaviour only.

## Known gaps (deliberate, documented in the README)

- No loop guard: upstream never validated it on real spirals, and DSH's
  `dsh-repeat-tool-reminder` already covers the detection.
- No context compression, no cost UI: `dsh-compaction*` and
  `@linxin666/dsh-usage` already own those.
- Two of six upstream envfact families (`form-repair`, `env-value`); no LLM
  proposer yet.
- A 1h cache write is priced as a 5m write, because DSH exposes a single
  `cacheWriteTokens` bucket — the estimate is conservative, and documented.

## Missing infrastructure (see `docs/PLAN.md`)

- The reports the roadmap calls for (`/te-facts stats`, `/te-cost trend`,
  `--json`) do not exist yet: 0.2.0 only started recording the history they need,
  so there is nothing to trend until a few sessions have run.
- No `CHANGELOG.md` and no changesets; the GitHub Release body and the commit
  log are the release notes.
- No `SECURITY.md`, even though the plugins read agent transcripts (they never
  write content to disk, and the state directory is `0700`).

## Commit style

Imperative subject, one concern per commit, body explains *why* and names the
failure it prevents. Cite the upstream module when porting a rule.
