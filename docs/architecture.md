# ARCHITECTURE

How this indexer is put together, and why each decision was made. Every constraint named
here was measured against Robinhood Chain **testnet 46630**, not assumed.

---

## Design principles

1. **The chain is the only source of truth.** No field in an emitted record comes from the
   operator's API. The API is an optional cross-check, confined to `output/api-comparison.json`.
2. **Never invent data.** A value that cannot be reconstructed is `null` with a `source` of
   `unavailable` and a note explaining why.
3. **Fail loudly on a wrong premise.** Checks assert expected constants rather than fitting
   themselves to observed data. A CONFIGURED generation with no verified economic policy
   throws rather than inheriting another generation's numbers. This does not extend to
   discovery: a factory absent from `config/factories.ts` is never scanned, so it is missed
   silently. Failing loudly and finding factories are different problems, and only the first
   is solved here.
4. **Be a polite guest.** One request at a time, a delay between calls, and on-disk chunk
   caching. Caching helps unevenly: the launches scan has a stable namespace and fixed start
   block, so it reuses well, while trade and burn scans over a moving window currently reuse
   poorly, because their scan boundaries shift with the head and adaptive chunk sizes may
   differ between runs. See [Caching](#caching).
5. **Separate raw from derived.** `data/` is what the chain said. `output/` is what this
   indexer concluded.

---

## Pipeline

```
stage 1  launches     all THREE factory generations, full history, one address-array scan
stage 2  trades       Bought / Sold / CurveCompleted / Graduated / CreatorFeesForwarded
                      via topic-only queries across all addresses
stage 3  burns        Transfer -> 0x...dEaD, then per-launch CreatorVault balances
stage 4  head state   token + curve + protocol reads  (HEAD-ONLY, see below)
derive                assemble project records, each field carrying its provenance,
                      plus the activity summary: transactions by distinct hash
verify                re-run fee and burn-accounting assertions against fresh data
emit                  output/*.json + run summary
```

### Stage 1: launches

One `eth_getLogs` scan with an **address array** covering all three factories, from the
earliest deployment block to head. The RPC supports address arrays, so this is a single pass.

Completeness is provable: each factory numbers launches from 0 with no gaps, so a **dense
launchId range** per generation means nothing was missed. The run prints this audit.

### Stage 2: trades

Curve events are emitted by tens of thousands of per-launch contracts, so address filtering is
impractical. This RPC accepts **topic-only queries across all addresses**, which is what makes
a complete trade index feasible.

**Correctness requirement:** a topic-only query returns logs from *any* contract sharing
`topic0`. On an open testnet full of copycat deployments this is a real risk. Every log's
emitter is checked against the curve set reconstructed in stage 1; non-matching logs are
counted and reported in `integrity.foreignLogsIgnored`, never silently dropped.

### Stage 3: burns and the vault leg

There is **no protocol-level burn event**. Burns are ordinary ERC-20
`Transfer(x, 0x...dEaD, amount)` logs, filtered node-side on the indexed `to` argument.

The subtlety that makes naive burn accounting wrong is documented in
[`known-limitations.md`](known-limitations.md) and enforced by a sanity check. Summary:
pre-graduation, `transfersUnlocked()` is false, so bought-back tokens **cannot** reach the
burn address and are held in the launch's `CreatorVault` instead.

### Stage 4: head state

Everything here is a **snapshot at head**, and can never be anything else on this RPC.

Measured state retention:

| Block height | Result |
|---|---|
| head - 4,096 | OK |
| head - 16,384 | `metadata is not found` |
| head - 65,536 | `missing trie node` |

So contract reads cover roughly the last few hours. Historical state cannot be reconstructed
at all; anything historical must come from events. Token `name`/`symbol` appear in **no
event**, so for a token whose state has been pruned they are simply unreadable via RPC.

Reads are batched through Multicall3 with `allowFailure: true`, because older-generation
curves lack functions that newer ones have (`quoteCurrency()` reverts on retired curves).

---

## Module map

```
config/
  factories.ts      Manually maintained address book + per-generation fee policy.
                    Exports resolveFeePolicy(), which THROWS for a CONFIGURED
                    generation with no verified policy. A factory absent from
                    this file is never scanned, so it is missed silently.
  network.ts        Chain pinning, RPC URL, chunk sizes, measured retention limit.
  abis.ts           ABI fragments, with provenance for each.

src/lib/
  rpc.ts            viem client, retry with exponential backoff + jitter, and the
                    distinction between range errors (shrink) and pruned-state
                    errors (do not retry, the data is gone).
  logscan.ts        Chunked, cached, adaptive eth_getLogs.
  cache.ts          Chunk cache, checkpoints, streaming writers, bulk-output switch.
  provenance.ts     The {value, source, confidence, note} envelope.

src/stages/         One file per pipeline stage (launches, trades, burns, headstate).
src/derive/         Assembles ProjectRecords, and the activity summary that counts
                    transactions by distinct hash. The only place facts are combined.
src/verify/         Sanity checks + the optional API cross-check.
src/emit/           Output writers.
```

---

## Adaptive log scanning

**Two undocumented limits exist on the public RPC and both were found by hitting them:**

| Limit | Error message | Where it bites |
|---|---|---|
| Query time | `log query timed out` | a 1,000,000-block span fails; 100,000 succeeds |
| **Result count** | `logs matched by query exceeds limit of 10000` | **the binding constraint** |

The result cap is the one that matters. In a dense region the chain emits roughly 360 curve
logs per 3,000 blocks, so a topic-only trade scan hits 10,000 results after about 25-30k
blocks, well inside a span the time limit would allow. **An indexer tuned only against block
range works on quiet history and then fails on recent blocks.**

`scanLogs()` therefore:
- starts at `LOG_CHUNK_BLOCKS` (default 20,000),
- **halves** on either error class and retries the same cursor,
- creeps back up by 1.5x after eight consecutive successes,
- and never assumes a fixed range is safe.

Range errors bypass the retry path entirely. Backing off cannot make an oversized query
smaller.

---

## Caching

Each `[from,to]` chunk is cached as `data/cache/{scan}/{from}-{to}.json`. Finalised history
does not change, so chunks are immutable once written. Chunks touching the last 32 blocks are
never cached (reorg safety).

**Cache keys embed the chunk bounds**, so changing `LOG_CHUNK_BLOCKS` between runs misses the
cache and re-fetches. Pick a chunk size and keep it.

### Known limitation: cross-run reuse is poor for trades and burns

Be accurate about what the cache does and does not buy you.

| Scan | Namespace | Reused across runs? |
|---|---|---|
| launches | `launches-all-generations` | **Yes.** Stable namespace, and the walk always starts at the earliest factory deployment, so boundaries line up |
| trades | `trades-{fromBlock}-{toBlock}` | **Rarely.** The namespace embeds the window |
| burns | `burns-{fromBlock}-{toBlock}` | **Rarely.** Same |

With a window relative to a moving head (`--trade-window`, `--burn-window`), `fromBlock`
differs on every run, so each run writes into a fresh namespace and re-fetches everything.

Making the namespace stable would not by itself fix this, which is why it has not been
changed:

- chunk boundaries are anchored to `fromBlock` (`let cursor = fromBlock` in
  [`logscan.ts`](../src/lib/logscan.ts)), so a shifted window shifts every boundary and the
  exact `{from}-{to}` keys still would not match;
- `chunkSize` adapts at runtime in response to RPC range errors, so boundaries are not
  reproducible even for an identical `fromBlock`.

Genuine reuse needs chunk boundaries aligned to a fixed global grid rather than to the start
of the request. That is a change to the scanner's walk, and it is deliberately left for after
this release rather than rushed alongside correctness fixes.

**Workaround today:** pass an explicit `--trade-from N` (a fixed block, not a moving window).
Successive runs then share a `fromBlock`, and chunk boundaries line up as long as
`LOG_CHUNK_BLOCKS` is unchanged and no adaptive shrink occurs.

---

## Provenance model

Every non-trivial field is wrapped so a reader can distinguish a decoded event from a
head-only read from an arithmetic derivation. See [`data-model.md`](data-model.md).

`vibe_api` exists in the type but **never appears in an emitted record**, and a test asserts this.

---

## Output sizing

A full run covers ~77,000 launches. Writing every record to a monolithic JSON file produces
roughly 400 MB and exceeds Node's maximum string length unless streamed.

So **bulk artifacts are opt-in** via `--emit-bulk`:

| Always emitted | Opt-in (`--emit-bulk`) |
|---|---|
| `factories.json`, `fees.json`, `lifecycle.json`, `api-comparison.json`, `indexer-summary.md`, `projects-enriched-sample.json` | `projects.json`, `projects.ndjson`, `projects.csv`, `trades.json`, `data/raw/*` |

Bulk writers stream rather than buffering, and repeated provenance notes are interned into a
`noteLegend` to avoid duplicating the same sentence across 75,000 records.

---

## What this architecture does not do

- **Does not index post-graduation trading.** After graduation, trading moves to Uniswap v4
  and emits `Swap` on the PoolManager. Only curve-phase trades are covered here, so volume and
  fee totals are understated for graduated projects. This is a known scope limit, not a
  platform fault.
- **Does not fetch IPFS metadata.** The URI and an on-chain digest are indexed, so content is
  verifiable, but fetching is left to the consumer.
- **Does not discover factories.** See `config/factories.ts`: the address book is manual, and
  a new generation would be silently missed until added.
- **Does not handle reorgs beyond a 32-block cache exclusion.**
- **Does not follow the chain tip incrementally.** Each run re-derives from cached chunks.
