# @sonettogu14/dsh-te-core

Pure functions shared by the `dsh-te-*` components of
[dsh-tokeneconomizer](https://github.com/SonettoGu14/dsh-tokeneconomizer): the cache-weighted pricing table, token
buckets, fact lifecycle, shell-call parsing, repository keys and atomic
storage.

This is a library, not a DSH plugin — installing it into a profile does
nothing. Install one of the components instead:

```sh
dsh plugin --profile <profile> add @sonettogu14/dsh-te-cost
```

It has no Cordis dependency and no I/O beyond `node:fs`, so it can be unit
tested directly.

Full documentation: [README.md](https://github.com/SonettoGu14/dsh-tokeneconomizer#readme).
Licensed Apache-2.0; see `NOTICE` in the repository for upstream attribution.
