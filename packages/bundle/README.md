# dsh-te

The bundle: installs all three DeepSeek Harness token-economy components in one
command.

```sh
dsh plugin --profile <profile> add dsh-te
```

It is a `cordis.patch.yml` and four dependencies — no code of its own. Each
component can also be installed alone:

| package | what it does | default |
|---|---|---|
| `dsh-te-cost` | cache-weighted equivalent-token ledger, `/te-cost` | on |
| `dsh-te-facts` | per-repository shell repairs, `/te-facts` | on |
| `dsh-te-prune` | hide tools nobody calls, `/te-prune` | off |

Full documentation, configuration and the evidence caveat:
[README.md](https://github.com/SonettoGu14/dsh-tokeneconomizer#readme).
Licensed Apache-2.0; see `NOTICE` in the repository for upstream attribution.
