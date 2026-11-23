# dsh-tokeneconomizer

**English** · [简体中文](README.zh-CN.md)

Three small DeepSeek Harness components that make an agent spend fewer tokens on
the same work. They are native Cordis plugins, not a port of a script: each one
plugs into the harness's own typed events, so there is no shell wrapper, no
subprocess, no `fail-open` JSON dance, and no editing of another tool's settings
files.

The ideas come from [microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer)
(`arXiv:2610.22732`, Apache-2.0), which built the same three mechanisms
out-of-process for Claude Code, Codex and Copilot CLI. See `NOTICE` for the
attribution. This repository is an independent TypeScript implementation of
three of its mechanisms against a plugin API TokenEconomizer did not have.

## Install

From the npm registry:

```sh
dsh plugin --profile <profile> add dsh-te          # all three
dsh plugin --profile <profile> add dsh-te-cost     # or one at a time
```

That installs the package; it does not activate it. A package only takes effect
when the profile lists it as a bundle layer, so add the same name to
`dsh.profile.bundles` in `~/.dsh/profiles/<profile>/package.json` — last, so its
rows apply after the shipped layers:

```json
"dsh": {
  "profile": {
    "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-te"]
  }
}
```

Then confirm three rows appear:

```sh
dsh --profile <profile> --dump-config | grep "== dsh-te"
```

Set `enabled: false` in a row's `config` to keep a component installed but
dormant; that is how `dsh-te-prune` ships.

From a checkout, build once first: a `link:` install links sources and keeps
their `node_modules`, but it does not run the build for you, and the packages
resolve their entry points from `lib/`.

```sh
pnpm install
pnpm build          # tsc -b -> packages/*/lib
dsh plugin --profile <profile> add link:<repo>/packages/bundle   # or .../cost
```


Maintainer release: one command, no npm token anywhere.

```sh
pnpm release:dry    # checks only: clean tree, tag free, verify, prints the plan
pnpm release patch  # bump all five, commit, tag v<version>, push; CI publishes
```

The tag is the release. `.github/workflows/publish.yml` re-runs `pnpm verify`,
refuses a tag that disagrees with `package.json`, publishes all five packages
topologically through OIDC Trusted Publishing, and creates the GitHub Release.
Nothing to keep on a laptop: a lost token cannot publish, and a version that
already exists fails rather than being overwritten. `pnpm publish:local` is the
fallback when CI is unavailable and does need a token in `~/.npmrc`.

`prepublishOnly` builds each package, `files` ships `lib/` and `src/`, and pnpm
rewrites the intra-workspace `workspace:*` dependencies to the published
versions. The components have no dependency on each other: `cost`, `facts` and
`prune` depend only on `dsh-te-core`, and the one cross-component
interaction (`facts` reporting its own injected tokens to `cost`) is a soft,
optional lookup — lose the ledger and facts still work.

## The components

### `dsh-te-cost` — cache-weighted accounting

Raw token totals mislead, because most input tokens are cache reads billed at a
fraction of a fresh input token. This component folds the harness's own four
disjoint provider buckets (`uncachedInput`, `cacheRead`, `cacheWrite`, `output`)
into a single number that is *unit-free*: equivalent fresh-input tokens, using
the provider's real price ratios.

- Watches `session/event` (`request/header`, `assistant/message`), never touches
  the prompt or the tool surface.
- Keeps a per-session view and a per-repository ledger in
  `$DSH_HOME/dsh-tokeneconomizer/repos/<key>/cost.json`.
- Counts the components' own spending: `recordOverhead(session, label, tokens)`
  puts injected text on the same books, so a saving cannot be manufactured by
  moving cost into the plugin.
- Keeps a rolling per-session history (last 400 sessions: day, equivalent tokens,
  buckets, overhead, weight source, whether it was a subagent) beside the
  repository totals, so change over time is measurable instead of remembered.
  Re-settling a session updates its entry rather than counting it twice.
- `/te-cost [session|repo]` prints the breakdown; `repo` also names the recorded
  history.
- `/te-cost trend` prints one line per day for this repository, with a bar, the
  median equivalent per session (subagent sessions excluded) and how many oldest
  sessions the 400-entry cap dropped. `/te-cost repos` lists every repository the
  ledger knows, most expensive first; the state directory names its folders after
  a base64 key, which is not something a person can ask a trend for.

Unknown models fall back to a default weight table, recorded as
`weightsSource: 'default'` rather than failing: a plugin must never be able to
break a session over a price table.

### `dsh-te-facts` — repository facts, learned and retired

Watches shell calls; when a session ends, a form that failed here plus a
different form of the same intent that then worked is one fact (an
`env_value` repair is the second family). Facts are scoped to one repository
(git origin remote, else the working directory).

A fact is not shown because it was observed. It is promoted only after three
separate sessions confirm it, and injected only while the waste it prevents is
still happening in at least 40% of the sessions that exercised it, measured over
at least four such sessions. When the model stops repeating the mistake, the fact
stops being injected — and a later session that contradicts it retires it.

- Injects through the logged pre-step channel: one extra user-role message at
  the first step of every turn, nothing at all when no fact qualifies, capped at
  4 facts / 600 characters. It repeats per turn on purpose: a compressor that
  folds older history on the wire (billion-context keeps only the last few
  messages) can drop the earlier copy, and the turn boundary is the one place
  where the facts are sure to survive it. Each turn adds one copy to the session
  log — about a hundred tokens — so a long session keeps one notice per turn at
  the tail; a compressor that folds the wire hides the older copies from the
  model, which is why the block stays this small.
- Stores the repair itself — the failing and working command forms of one intent,
  plus environment variable *names*. Never file contents, never output text.
- Books what the injection cost and what it prevented: each fact records the
  sessions its text was injected into, their token cost, the sessions that
  exercised it, and the wasted output of the failures it was meant to stop.
  Without those three numbers the "does injecting this pay for itself" question
  has no answer that is not a guess.
- `/te-facts` lists what it knows, with state, score and firing rate, plus
  `inj N/Xeq` (injected into N sessions for X equivalent tokens) and
  `after w/t` (the waste seen after the first injection).
- `/te-facts stats` answers the other question: counts by state, what injection
  has cost in total, and per fact a break-even (`injected eq ÷ eq per failure`,
  i.e. how many recurrences its text has to prevent to pay for itself) beside the
  observations that fact actually has. It reports absolute counts and says what it
  cannot know: there is no baseline error rate, so no improvement percentage is
  claimed.

Ported constants: `K_PROMOTE=3`, `GAMMA=0.8`, `LAMBDA=5.0`, `FIRE_GATE=0.40`,
`FIRE_MIN_N=4`.

### `dsh-te-prune` — stop sending tools nobody calls

Every tool definition rides along on every request. This component counts, per
repository, how many sessions a tool has gone unused; after `idleSessions`
(default 5) it hides the tool with the registry's own scoped restriction, which
is lifted when the session ends.

- Off by default, and deliberately so: the tool set is part of the cached
  request prefix, so hiding tools changes what the provider can reuse. The
  decision is made once at session start and held for the whole session, which
  keeps the prefix stable inside a session.
- Never hides the harness basics (shell, edit, read, subagents, jobs, …), and
  `maxHidden` bounds the damage to 8 tools per session.
- `/te-prune` shows idle counters; `/te-prune restore` gives tools back and
  records them as permanently kept.

## Configuration

Each component takes a small `Config`; the profile's patch row is the place to
set it:

```yaml
- id: te-facts
  name: 'dsh-te-facts'
  config:
    enabled: true
    maxFacts: 4
    maxChars: 600
```

| Component | Setting | Default | Meaning |
|---|---|---|---|
| cost | `enabled`, `persist` | `true`, `true` | fold usage, write the repo ledger |
| facts | `enabled` | `true` | watch, learn, inject |
| facts | `maxFacts`, `maxChars` | `4`, `600` | injection budget |
| prune | `enabled` | `false` | hiding is opt-in |
| prune | `idleSessions`, `maxHidden` | `5`, `8` | when to hide, how many |
| prune | `protected` | `[]` | extra names never to hide |

State lives in `$DSH_HOME/dsh-tokeneconomizer/` (default `~/.dsh/`), partitioned
by repository key. Writes are atomic (`tmp` + `rename`), reads never throw.

## Reading the ledger after a few sessions

Two files accumulate, both plain JSON:

- `repos/<key>/cost.json` — `history[]` has one entry per session: day,
  `equivalent`, the four buckets, the components' overhead, and the weight source.
- `repos/<key>/facts.json` — per fact, `injectedTasks`/`injectedTokens` (what the
  injected block cost), `exercisedTasks` (sessions where the mistake could
  recur), `wastedTasks`/`wasteTokens` (how often and how expensively it did).

`/te-cost repo` and `/te-facts` print the same numbers without opening them. A
session is written when it ends, so the entry for the session you are in appears
after it closes, not during it.

## Verification

```sh
pnpm build             # tsc -b over the four source packages
pnpm typecheck         # tsc -p tsconfig.test.json, includes all tests
pnpm test              # vitest: 160 unit tests
pnpm test:integration  # vitest: 11 integration tests against real DSH packages
pnpm verify            # all four, in that order
```

Three levels, from cheapest to most convincing:

**Unit tests** mount the components in a bare Cordis `Context` with stubbed
services: cost is fed synthetic session events, facts and prune are driven
through four to six simulated sessions to prove promotion, the firing gate,
two-strike contradiction, idle counting, and that restrictions are lifted again.

**Integration tests** (`test/integration/`) are the interesting ones: they load
the real `@deepseek-ai/dsh-agent-loop`, `dsh-llm`, `dsh-tools`,
`dsh-session` and `dsh-tool-executor-native` packages, register a scripted
`LlmAdapter` in place of a provider, and run a genuine agent turn — no network,
no credentials, no model. What they assert is exactly what the components claim:

- **cost** — the four buckets the fake adapter reports (`100` uncached, `50`
  cache-read, `5` cache-write, `20` output) land in `cost.json` unchanged and
  fold to `equivalent: 211.25`; two sessions in one repository accumulate, each
  with its own history entry, and `/te-cost repo` run from a later session
  reports that history through the real command service.
- **facts** — a qualified fact is present as a `dsh-te-facts` message in the
  *first model request* (not merely in state), and disappears when the fire gate
  is not met; the second turn's request still carries it, which is the regression
  guard for a wire-level compressor folding the earlier copy away; a real failing
  `python -m pytest` followed by a working `pytest` in the same session teaches
  the fact end to end; and the session that received the injection records it
  against the task it happened in.
- **prune** — an idle tool is absent from the request's `toolNames` while the
  registry still knows it (hidden, not unregistered); a tool below the threshold
  survives; `write` is never hidden; and an idle `acp_*` tool from a context
  compressor is never hidden either.

These tests caught a real composition requirement: DSH 0.2.2 refuses to run an
agent unless a tool executor is mounted, which a bare event-level test never
notices.

**Manual, real model** — a throwaway profile built from the shipped `headless`
template with the bundle installed answered a one-word task and exited cleanly:

```
$ dsh --profile te-headless "Reply with exactly: ok"
ok
```

That run produced `$DSH_HOME/dsh-tokeneconomizer/repos/<key>/cost.json` with
`equivalent: 9189` for a three-token reply — the fixed prompt and tool
definitions, not the answer, are what a session costs. The same repo after a
second session read:

```json
{"equivalent": 9471.76, "buckets": {"uncachedInput": 9266, "cacheRead": 9088,
 "cacheWrite": 0, "output": 6}, "sessions": 2}
```

18,360 raw tokens against 9,472 equivalent ones: that gap is the whole reason the
ledger folds buckets instead of summing `totalTokens`. A profile with **only**
`dsh-te-cost` installed boots the same way, so the components really are
independent.

What no test can prove is the harness-level effect on token spend over many
sessions; that needs the plugins left on in real work.

## What was deliberately not ported

- **Loop guard / spiral intervention.** TokenEconomizer's own docs say it was
  only validated on seeded loops, never on a real spiral, and DSH already ships
  `dsh-repeat-tool-reminder`. Porting an unvalidated heuristic that can spend
  model calls to interrupt a turn is not a good trade here.
- **Context compaction, ¥ spend panel.** Already covered by `dsh-compaction*`
  and `@linxin666/dsh-usage`; duplicating them would only add overhead.
- **The LLM proposer and the other four fact families** (`boundary`,
  `arg_repair`, `absent_tool`, `empty_probe`). They are where TokenEconomizer's
  extra model calls live; the mechanical two-family core is the cheap 80%.
- **A Python sidecar.** The target harness is TypeScript and in-process; a
  second runtime would add a process boundary for nothing.

## Evidence status

TokenEconomizer's headline numbers (18–31% cheaper on SWE-Bench, 16–21% on
Web-Bench) exist in that repository only as constants in
`docs/assets/results_overview.py`, covering the paper's Table 1; the repository
ships no run results and says so in that file. They are a reason to try these
mechanisms, not evidence that this port inherits them. What is verifiable here is
narrow and stated above: the arithmetic is exact, the lifecycle gates behave as
specified, and nothing the components do can alter the agent's transcript except
one bounded fact block at session start.

## Layout

```
packages/core/    pure logic: pricing weights, bucket folding, fact lifecycle,
                  shell-transcript extraction, repo identity, atomic storage.
                  No Cordis dependency; unit-tested in isolation.
packages/cost/    ledger service + /te-cost
packages/facts/   fact watcher + pre-step injection + /te-facts
packages/prune/   idle counters + scoped tool restrictions + /te-prune
packages/bundle/  the install-all patch
test/integration/ real-composition harness (real dsh packages, scripted model)
docs/PLAN.md      roadmap, priorities and the measurement protocol
```

## Citation and license

The mechanisms implemented here come from this paper; cite it if you use them:

```bibtex
@misc{li2026tokeneconomizer,
  title         = {{TokenEconomizer}: Experience-Driven Black-Box Cost Control for Coding Agents},
  author        = {Li, Aaron J. and Xu, Weijia and Singh, Chandan and Chen, Zixiao and
                   Inala, Jeevana Priya and Siska, Charlotte and Tamersoy, Acar and Yu, Bin and
                   Stoica, Ion and Galley, Michel and Gao, Jianfeng},
  year          = {2026},
  eprint        = {2610.22732},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2610.22732}
}
```

This project is licensed under the Apache License, Version 2.0; see
[`LICENSE`](LICENSE). It is an independent implementation of mechanisms from
[microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer)
(Apache-2.0, Copyright (c) Microsoft Corporation and contributors); no source
file was copied verbatim. [`NOTICE`](NOTICE) records the attribution and which
parts are derived.
