# Changelog

Newest first. The five packages move together: one version, one tag, one npm
release. Entries describe user-facing behaviour; the commit log carries the
reasoning.

## Unreleased

### Added

- `/te-facts why` prints the funnel that turns shell calls into facts — calls,
  failures, failures that named a cause, failures with a recognisable program,
  repairs — and names the first empty stage. A repository with no facts can now
  say why instead of looking broken. The counts persist in `facts.json` v3
  (`learning`); v1 and v2 records are still read and filled in place.
- `/te-cost --json` for `session`, `repo`, `trend` and `repos`: the same numbers
  as the text views in one JSON document, including the weights date.
- The weight table carries the day it was last checked against published prices
  (`WEIGHTS_UPDATED`), printed beside the resolved row and included in JSON, so a
  stale price is visible rather than assumed current.
- `/te-prune` prices the change it would make: the schema tokens saved per
  request and their share of the tool block, next to the per-tool estimate.

### Fixed

- An integration case now mounts `prune` with the configuration the bundle
  actually ships (`enabled: false`). Every earlier case used `enabled: true`,
  which is not the configuration any user starts in.

## 0.4.1 — 2026-11-25

### Fixed

- `prune` never mounted with the bundle's default `enabled: false`: `apply`
  returned early, so the Plugins page showed it enabled while `tePrune` and
  `/te-prune` did not exist and no counters were ever written. Measuring and
  hiding are now separate — the component always mounts, `enabled` decides only
  whether the mask is applied.

### Added

- `/te-prune dry-run`: the candidates with a chars/4 token estimate, and the
  one-off cost of changing the tool set (the first request after the change pays
  the prefix once).

## 0.4.0 — 2026-11-23

### Added

- `dsh-te` bundle with `/te`, a one-command overview of the three components, so
  installing the suite is one row instead of three.
- Chinese README; the measurement protocol is frozen in `docs/MEASUREMENT.md`.

## 0.3.0 — 2026-11-23

### Added

- `/te-cost trend` and `/te-cost repos`, `/te-facts stats`: the reports the
  measurement protocol needs.
- `facts` re-injects its block at the first step of every turn, where a
  wire-level compressor cannot fold it away.
- `prune` protects every compressor tool (retrieve/status/cache) and sizes its
  report from the data instead of a fixed width.

## 0.2.1 — 2026-11-18

### Changed

- Every package carries keywords and a bilingual description, so the plugin
  catalog can list them.

## 0.2.0 — 2026-11-18

### Added

- `cost.json` v2: per-session `history`, so a trend can be computed.
- `facts.json` v2: per-fact injection and waste token counts, so a fact's cost
  can be weighed against what it prevented.
- CI verifies every push and pull request.

## 0.1.2 — 2026-11-18

First published set: `dsh-te-core`, `dsh-te-cost`, `dsh-te-facts`,
`dsh-te-prune`.
