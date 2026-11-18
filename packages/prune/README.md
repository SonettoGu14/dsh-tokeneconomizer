# @sonettogu14/dsh-te-prune

Stops sending tool definitions the model never calls. Every tool schema rides
along on every request; this component counts, per repository, how many
sessions a tool has gone unused, and hides it after `idleSessions` (default 5).

```sh
dsh plugin --profile <profile> add @sonettogu14/dsh-te-prune
```

**Off by default.** Hiding a tool changes the cached request prefix, so it is
only a win if the saved schema tokens exceed what the change costs; the decision
is made once at session start and held for the whole session. Harness basics are
never hidden, and `maxHidden` bounds the total to 8 tools.

- `/te-prune` shows idle counters, `/te-prune restore` returns a tool and keeps it.

Part of [dsh-tokeneconomizer](https://github.com/SonettoGu14/dsh-tokeneconomizer) — install
`@sonettogu14/dsh-te` for all three components.
Licensed Apache-2.0.
