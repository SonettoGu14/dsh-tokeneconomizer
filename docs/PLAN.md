# Development plan and handoff

Status: **0.2.0 implemented and published; measurement is the next step.** This
document is the map for whoever picks the project up next (human or agent): where
it stands, what is worth doing in which order, what was deliberately rejected,
and how to tell whether a change actually helped.

Snapshot 2026-11-18:

| fact | value |
|---|---|
| packages | 5 × `0.2.0` |
| npm | `dsh-te` / `dsh-te-``{core,cost,facts,prune}` published by CI through OIDC Trusted Publishing |
| repository | public, `github.com/SonettoGu14/dsh-tokeneconomizer` |
| tests | 146 unit + 9 integration, `pnpm verify` green |
| CI | `verify.yml` on every push and PR; `publish.yml` on `v*` tags |
| pin | `@deepseek-ai/dsh >=0.2.2-rc.3 <0.3.0` |
| code | ~3.9k lines TypeScript across 5 packages, no runtime dependency but `schemastery` |

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
pnpm verify                     # 146 unit + 9 integration tests
```

Track A/B changes in a throwaway profile; never experiment in the daily one:

```sh
dsh --profile te --from-default-profile headless
dsh plugin --profile te add link:$PWD/packages/bundle   # then list "dsh-te" in dsh.profile.bundles
dsh --profile te --dump-config | grep "== dsh-te"       # three te-* rows
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
- Network here: the local proxy can fail on TLS (`error:...:SSL connect error`)
  and a direct push can fail with *"Error in the HTTP2 framing layer"*. A direct
  connection with `git -c http.version=HTTP/1.1 push origin master` works; check
  connectivity with `curl -s -o /dev/null -w "%{http_code}" https://api.github.com/rate_limit`
  before blaming git.
- `pnpm test` and `pnpm test:integration` are separate Vitest projects; the
  integration one is single-process because every test points `DSH_HOME` at its
  own temp directory.

## Release (walked once, then one command per version)

All five packages are on npm as `0.1.1` under the unscoped names `dsh-te`,
`dsh-te-core`, `dsh-te-cost`, `dsh-te-facts`, `dsh-te-prune`, published by
`.github/workflows/publish.yml` through OIDC Trusted Publishing: no token on
any laptop, and one GitHub Release per tag.

The loop for every later version:

1. `pnpm release:dry` — clean tree, free tag, `pnpm verify`, prints the plan.
2. `pnpm release patch|minor|major|x.y.z` — bumps all five `package.json`
   files together, commits `release: vX`, tags `vX`, pushes; CI does the rest.
3. Watch the run: Install → tag/version check → `pnpm verify` → publish →
   Release. A version that already exists fails at the publish step instead of
   overwriting.

Every new *package name* needs its own trusted-publisher connection on npmjs.com
before CI can publish it (Settings → Publishing access → GitHub Actions: owner,
repository, workflow filename `publish.yml`, environment left empty because the
workflow declares none, "Allow npm publish" checked). The connection is created
once and cannot be edited afterwards — delete and recreate rather than repair.

`pnpm publish:local` is the manual fallback and the only path that works when
Actions is down; it needs a granular npm token in `~/.npmrc`, which cannot
bypass 2FA for destructive actions such as unpublish or trust management.

## Roadmap

Ordered by value per unit of work. Each item has an acceptance criterion so it
can be closed without an argument.

### P0 — ship the distribution loop — **done**

The five packages resolve from npm as `0.2.0`, published by `publish.yml` on a
`v*` tag through OIDC Trusted Publishing (no token anywhere), and
`.github/workflows/verify.yml` runs the same `pnpm verify` on node 24 for pushes
to master and for pull requests.

### P1 — prove or disprove the value (highest priority)

Everything else is speculative until this exists. **The recording half is done in
0.2.0**; the reporting half is the next version.

0.2.0 changed what is stored, because the old shape could not answer the
question: `cost.json` only had running totals, so no trend could be computed, and
`facts.json` only had `fired`/`firedWaste` counts, so no fact's own cost could be
weighed against what it prevented.

- `cost.json` v2 — `history[]`, one entry per session (day, `equivalent`, buckets,
  overhead split by component, `weightsSource`, subagent flag), capped at 400
  entries with `droppedSessions` keeping the arithmetic closed. Re-settling a
  session replaces its entry instead of double-counting it.
- `facts.json` v2 — per fact: `injectedTasks`/`injectedTokens` (when its text was
  actually injected, and what that text cost), `exercisedTasks` (sessions where
  the mistake could recur), `wastedTasks`/`wasteTokens` (how often and how
  expensively it did recur). The injection decision itself — `injectable()`,
  score, `FIRE_GATE` — was not touched; this only books what already happened.

Still missing, and deliberately not guessed at: a denominator for "did
injecting reduce errors". `facts` can name the sessions that exercised a fact,
but there is no baseline error rate to compare against, so the report must show
absolute counts and a break-even (n* = injected tokens ÷ waste per failure) and
say what it cannot know. An `earning` verdict with `k = 0` observations is not
proof of anything.

The reports are **built** (they read the v2 records and change no behaviour):

- `/te-facts stats` — facts by state, total injected tasks and equivalent tokens,
  and per fact the break-even (`injected eq ÷ eq per failure`) next to the
  observations it actually has. It reports absolute counts and states that the
  ledger has no baseline error rate, so no improvement percentage is claimed.
- `/te-cost trend` — one line per calendar day for the current repository, with a
  bar, the median equivalent per session (subagent sessions excluded from the
  median but not from the totals) and how many sessions the 400-entry cap dropped.
- `/te-cost repos` — every repository the ledger knows, most expensive first, so a
  trend can be asked for without reading the state directory.

Still open in P1: to show *which* facts were retired and why, the retirement
reason has to be recorded (`recordInjection`/`contradict` keep the counts, not the
cause). Collect that before quoting a reason in the report.

Then run the experiment, which is the honest part. The protocol, the decision rules
(written down before any data is collected) and the empty result tables live in
[docs/MEASUREMENT.md](MEASUREMENT.md):

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
| waste is priced at `ceil(characters / 4)` tokens | the harness reports no per-token count for a tool result; it is the same estimate the context UI uses, and it is marked `approx` where shown | S |
| `history` keeps 400 sessions and drops the rest | an unbounded file in a state directory is worse than a trend starting 400 sessions ago; `droppedSessions` keeps the arithmetic honest | XS |
| evidence window is a constant (20 tasks) | no data on what it should be; P1 can measure the effect of retiring later | S |
| unknown model weights are maintained by hand | every published model needs a row; the P5 fallback test is the guard | S |
| no CHANGELOG, no SECURITY.md | CI publishes and tags, so release notes live in the Release body; neither blocks a release | S |
| `lib/` is gitignored, so a fresh clone needs `pnpm build` before `link:` install works | documented in the README install section; a `prepare` script covers registry installs | — |
| two Vitest configs share an alias block | acceptable duplication; unify only if a third project appears | XS |

Deliberate non-fixes (documented, will not be "fixed" without a reason): the 1h
cache-write estimate and the shell heuristics above — they are approximations
chosen to stay simple, and each says so in its docstring.

## Decisions the owner needs to make

1. ~~Publish now or after P1?~~ **Decided: publish now.** `0.1.1` is live, so
   the API is frozen at the shape the README documents and the next mechanism
   change is a minor bump.
2. ~~Is `@sonettogu14` the final scope?~~ **Decided: unscoped, and it cost less
   than feared.** The five packages went live scoped and then moved to
   `dsh-te` / `dsh-te-*` while nothing depended on them. What made it cheap:
   rename in the tree, publish the new names, reconfigure the trusted
   publishers, unpublish the old ones — all before a single install existed.
   Treat the first real user as the point where that freedom ends.
3. **Measurement or breadth next?** This plan says measurement (P1) before more
   mechanism (P3). If the goal is the opposite — more hooks before proof — say so
   and reorder.
4. ~~Language.~~ **Decided: both.** `README.zh-CN.md` mirrors the English README
   (the audience is largely Chinese-speaking), and the English one links to it. Keep
   the two in step when behaviour changes.
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
