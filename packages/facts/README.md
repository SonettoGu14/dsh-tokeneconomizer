# @sonettogu14/dsh-te-facts

Learns per-repository shell repairs from what actually happened — this command
form failed here and that one worked, or this command needs that environment
variable — and injects at most one short reminder, only while the wasted
attempts are still recurring.

```sh
dsh plugin --profile <profile> add @sonettogu14/dsh-te-facts
```

- A repair is promoted only after three separate sessions confirm it, and
  injected only while it is still paying for itself.
- Budget is fixed: one message, at most 4 facts, at most 600 characters, and
  nothing at all when no fact qualifies.
- Stores command forms and variable *names*; never output text or file contents.
- `/te-facts` lists what it knows, with state, score and firing rate.

Part of [dsh-tokeneconomizer](https://github.com/SonettoGu14/dsh-tokeneconomizer) — install
`@sonettogu14/dsh-te` for all three components. Thresholds and configuration are
documented there.
Licensed Apache-2.0.
