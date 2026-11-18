# dsh-te-cost

Cache-weighted token accounting for DeepSeek Harness. Raw totals mislead —
most input tokens are cache reads billed at a fraction of a fresh input
token — so this component folds the four provider buckets
(`uncachedInput`, `cacheRead`, `cacheWrite`, `output`) into one
comparable number: *equivalent fresh-input tokens*.

```sh
dsh plugin --profile <profile> add dsh-te-cost
```

- Observes `session/event` only; never touches the prompt or the tool surface.
- Keeps a per-repository ledger in
  `$DSH_HOME/dsh-tokeneconomizer/repos/<key>/cost.json`.
- `/te-cost [session|repo]` prints the breakdown.

Part of [dsh-tokeneconomizer](https://github.com/SonettoGu14/dsh-tokeneconomizer) — install
`dsh-te` for all three components. Configuration, the unknown-model
fallback and the measurement caveat are documented there.
Licensed Apache-2.0.
