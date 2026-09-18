# KNOWN LIMITATIONS

What this prototype cannot do, and why. Written so a reader can tell a limitation of
*this code* from a limitation of *the platform*.

---

## 1. The RPC is not an archive node (the big one)

**Measured, not assumed** (`eth_call` of `factory.launchCount()` at decreasing block heights):

| Block height | Result |
|---|---|
| head | OK |
| head - 1,024 | OK |
| head - 4,096 | OK |
| head - 16,384 | `metadata is not found` |
| head - 65,536 | `missing trie node` |

So state retention on the public endpoint is roughly **4,096 blocks, a few hours**.

**Consequences that no amount of code can fix:**

- Every `eth_call` in this indexer is a **HEAD-ONLY snapshot**. Token `name`/`symbol`,
  `transfersUnlocked()`, curve reserves, `complete()`/`graduated()`, accrued fees and
  vault balances are all "as of block N" and are labelled that way in the output.
- **Historical state could not be reconstructed from this endpoint.** There was no working way
  to ask "what was this curve's reserve at block X". Anything historical must come from events.
- A token that launched, traded and graduated months ago can still have its *history*
  reconstructed from logs, but its *name and symbol could not be read back* once the
  contract state has been pruned. Those live only in contract storage and appear in no
  event.

**Fix for production:** a paid archive provider (Alchemy is the documented recommendation
for this chain; Chainstack advertises full `debug`/`trace` on 46630). Set `RPC_URL`.

---

## 2. Two undocumented `eth_getLogs` limits

| Limit | Error | Where it bites |
|---|---|---|
| Query time | `log query timed out` | 1M-block spans fail; 100k succeeds |
| **Result count** | `logs matched by query exceeds limit of 10000` | **the real constraint** |

The result cap is the one that matters. In a busy region the chain emits ~360 curve logs
per 3,000 blocks, so a topic-only trade scan hits 10,000 results after roughly 25-30k
blocks. An indexer tuned only against the block-range limit passes on quiet historical
ranges and fails on recent ones.

Handled by halving the chunk on either error and creeping back up after eight consecutive
successes. It is still a per-run cost: log density across this chain's history varies by
more than an order of magnitude.

---

## 3. Scan scope: launches are complete, trades and burns are windowed by default

| Scan | Default scope | Complete? |
|---|---|---|
| **Launches** | earliest factory deployment (block 95,916,239) -> head | **yes, always** |
| Trades | last `--trade-window` blocks (default 200k) | no, pass `--full-trades` |
| Burns | last `--burn-window` blocks (default 200k) | no, pass `--full-burns` |
| Head state | first `--enrich-limit` projects by priority | no, by design |

This is a deliberate prototype tradeoff, not a platform limit. Full-history trades means
scanning ~23M blocks at ~20-30k blocks per query against a shared public endpoint: tens
of thousands of requests. The operator's own indexer reports ~524k trades, so the data
volume is real but the *politeness* cost is the binding issue: their Terms prohibit
probing or overloading the service.

**Every trade-derived field is labelled.** When the scan is windowed, `totalTrades`,
`buyVolumeWei`, `sellVolumeWei`, `totalVolumeWei`, `uniqueTraders` and all fee totals in
`projects.json` carry `confidence: "medium"` and a note naming the block range. They are
**not lifetime totals** and must not be read as such.

---

### The transaction count inherits this scope

`output/activity.json` counts distinct transaction hashes across the launch and curve
event surfaces. Its `isFullHistory` is true only when the launch scan **and** the curve
scan both covered full history, which on a default run the curve scan does not. A windowed
run still produces the figure, but stamps it `isFullHistory: false` with a warning: a
window's worth of transactions printed beside lifetime launch totals is a
misrepresentation, not an approximation.

A transaction can be Vibe/Vibe-related and still be absent from that count:

- **post-graduation trading**, which moves to Uniswap v4 and is not indexed at all;
- **buyback and burn transfers**, which are plain ERC-20 `Transfer` logs found by the
  separately-scoped burn scan;
- **`LaunchFeesClaimed`**, the operator's treasury sweep, which is neither launch nor curve
  activity;
- **any transaction that emitted none of the included events**: an approval, a plain
  transfer, a failed call;
- **launches from an unconfigured factory generation** (section 10), which are never
  scanned at all.

So it is "indexed transactions", never "total transactions". Nothing in this repository
could substantiate the second claim.

---

## 4. `--enrich-limit` and what gets sampled

Head-state reads cost RPC calls, so they are budgeted. The budget is spent in priority
order: (0) tokens with observed burn activity, (1) projects with a graduation, completion
or creator-fee-forward event in the trade scan, (2) projects that traded in the window,
(3) newest launches. A per-generation quota is reserved before the remainder is filled by
rank, so older generations are always sampled.

Projects outside the budget get `source: "unavailable"` with the note
`outside --enrich-limit` for `name`, `symbol`, `decimals`, `transfersUnlocked`, curve
lifecycle, accrued fees and vault holdings. Their **event-derived** fields are still
complete.

---

## 5. Fields that are genuinely impossible from public data

| Field | Why |
|---|---|
| `moderation.visibility` | An off-chain editorial decision. No on-chain trace was identified in the surfaces reviewed. The operator can hide a token from their UI, and that action was not observed to reach the chain. |
| Comments | Off-chain only. |
| Season 0 standings | Inputs are on-chain, but the scoring formula and tie-breaks are unpublished. Recomputable in shape, not exactly. |
| Linked X account / Vibe profile | Session-gated on the operator's API. |
| Human identity behind a wallet | Out of scope for any chain indexer. |
| IPFS *content* (description, image, socials) | The URI and an on-chain digest are in the launch event, so content is **verifiable**, but this prototype does not fetch IPFS. Adding it is straightforward and gated only on gateway reliability. |

---

## 6. `uniqueTraders` counts addresses, not people

Derived from distinct `msg.sender` in `Bought`/`Sold`. One person may control many
wallets; one wallet may be a contract acting for many people. The field is marked
`confidence: "medium"` for this reason, independently of scan scope.

Note also that `Bought` carries **both** `buyer` and `recipient`, which differ when a
purchase is made through the undocumented `buyFor(uint256,address,address)`. This
indexer counts `buyer`. Counting `recipient` would give a different, equally defensible
number, and a real analytics product has to pick and disclose.

---

## 7. Second-level fee splits are not reconstructed

Verified on-chain and re-checked by this indexer, PER GENERATION (see §9a; the fee is not
uniform across factories):
- current + legacy: total fee **125 bps**, split **75% creator / 25% protocol**
- retired: total fee **100 bps**, split **50 / 50**

**Not** verified, and deliberately not claimed: the second-level 50/50 splits
(creator payout vs launch-token buyback; treasury accrual vs tSFUND buyback). Those come
from the operator's config API and are recorded as operator-stated, not verified, in `fees.json`.
Reconstructing them would require tracing vault withdrawals and keeper swap paths per
launch: possible, but not attempted here.

---

## 8. Burn accounting has a trap, and it is handled

Naive version: `burned = balanceOf(0x...dEaD)`. **Wrong for every pre-graduation token.**

While a launch is on the curve, `transfersUnlocked()` is `false`, so a transfer to the
burn address would revert with `TransfersLocked()`. The keeper's bought-back tokens are
therefore **held in the launch's CreatorVault** (an EIP-1167 clone) and only move to
`0x...dEaD` after graduation.

Correct accounting, which this indexer emits as `totalSupplyCommittedToBurnWei`:

```
supplyRemovedOrCommitted = balanceOf(0x...dEaD) + balanceOf(creatorVault)
```

`checkPreGraduationBurnAccounting` asserts the model: zero tokens with locked transfers
may have a non-zero burn balance. A failure would mean the model is wrong.

### What this figure assumes, and why it is `confidence: "medium"`

The addition is exact. The **attribution** is not.

`totalSupplyCommittedToBurnWei` treats the entire CreatorVault token balance as
buyback-origin supply. That was consistent with every token inspected during this research,
but it was never proven, and two things keep it from being provable here:

- no mechanism was identified that prevents an unrelated inbound transfer to a vault;
- after graduation `transfersUnlocked()` is `true`, so **any** holder can send the launch
  token to **any** address, the vault included.

So a vault balance is not self-evidently "tokens the keeper bought back". Unless token
provenance is established independently, by tracing inbound transfers to the vault,
`burned + vaultBalance` is an **upper bound** on supply committed to burn, not a measured
quantity. The field is emitted at `confidence: "medium"` for exactly this reason, and its
note says so.

The arithmetic has deliberately not been changed. Narrowing it would mean guessing which
vault tokens "count", which is the kind of invention this repository refuses to do.

**Residual limitation:** the vault leg is a head-only read, so it is only available for
projects inside `--enrich-limit`.

---

## 9. Cache keys include chunk bounds

Cached chunks are keyed `{scan}/{from}-{to}.json`. Changing `LOG_CHUNK_BLOCKS` between runs
changes the bounds and therefore misses the cache, re-fetching ranges already downloaded.
Pick a chunk size and keep it. Chunks touching the last 32 blocks are never cached
(reorg safety).

Reuse is uneven in practice. The launches scan has a stable namespace and a fixed start
block, so it reuses well. Trade and burn scans over a **moving** window reuse poorly: their
namespaces embed the window bounds, their chunk boundaries are anchored to `fromBlock`, and
adaptive chunk sizing means boundaries may differ between runs even for the same start block.
See [`architecture.md`](architecture.md) for the full account and the `--trade-from`
workaround.

---

## 9a. Generation-specific behaviour that the code has to know about

Discovered by running this indexer, not from any document:

| Generation | Fee | Split | Graduation target | `quoteCurrency()` |
|---|---|---|---|---|
| retired | **100 bps** | **50/50** | **0.005 ETH** | **absent, reverts** |
| legacy | 125 bps | 75/25 | not read | not read |
| current | 125 bps | 75/25 | 5 ETH | present |

Consequences encoded in the code:
- `GENERATIONS[].economics` carries per-generation policy, read through
  `resolveFeePolicy()`; the checks validate against the
  right one. Applying the published 125/75/25 uniformly mis-accounts 14,663 launches.
- Multicall uses `allowFailure: true` because older curves lack functions newer ones have.
- The operator labels the first factory "retired", but it is **still producing launches**,
  and the operator's own API returned HTTP 404 for all 5 sampled recent ones (0/5 served). See
  `output/api-coverage-by-generation.json`.

## 9b. Dust trades make basis-point comparisons meaningless

Below roughly 1,000 wei of gross, a 1-wei integer-division remainder swings the implied fee
by tens of basis points: we observed 179-wei trades reading as "167 bps" when the contract
charged exactly 125. The checks compare absolute wei (tolerance 2) and report dust
separately. Any analytics product computing effective fee rates needs the same guard.

## 10. Three generations are hardcoded, and no discovery mechanism was found

The factory addresses in `config/factories.ts` were verified on-chain, but **no on-chain
registry enumerating factory generations was identified**. The only published list is the
`deployments` / `legacyPublicGraphs` / `retiredPublicGraphs` fields of the operator's
undocumented config API.

If a fourth generation is deployed, this indexer will not discover it and will silently
under-count, which is exactly the failure mode it was built to demonstrate. A production indexer
would need to watch for new contracts matching the factory bytecode, or poll the config
API purely for address discovery.

Note that the `UnsupportedGenerationError` fail-safe does **not** cover this. That error fires
only for a generation that is present in `config/factories.ts` without a verified economic
policy. An unconfigured factory is never scanned, so it never reaches that code path.

`QuoteRegistry` is worse: it appears in *no* published list and was found only by calling
`factory.quoteRegistry()`.

---

## 11. Prototype-grade engineering

Not production software. Specifically missing:

- No database. Everything is JSON on disk; `projects.json` is written with a streaming
  writer because 77k records with full provenance exceed Node's maximum string length.
- No reorg handling beyond a 32-block cache exclusion. No finality tracking.
- No incremental tip-following. Each run re-derives from cached chunks.
- Single-threaded, one request at a time, by choice: politeness over speed.
- Test coverage is offline-only. The suite is 79 assertion tests across 15 suites
  (`npm test`), which pin the correctness traps this repository exists to document:
  generation-scoped fee arithmetic, launch-identity namespacing, burn accounting across
  both legs, the unknown-generation fail-safe, RPC range-error classification, RPC
  endpoint redaction, and credential scrubbing of persisted error text. They run without network access against fixed fixtures.
  Separately, five sanity checks run *inside* an indexing run against live data.
  **There is no integration test that exercises a full indexing run**, and no test
  asserts anything about live chain state.
- IPFS metadata is referenced but not fetched.
- Post-graduation Uniswap v4 `Swap` events are **not** indexed. Only curve-phase trades
  are. A complete volume picture needs both.

---

## 12. TESTNET

Everything here describes Robinhood Chain **testnet 46630**. vibe/vibe has no mainnet
deployment: the operator API returns `UNSUPPORTED_CHAIN` for chain 4663 and their Terms
state "Chain ID 4663 is disabled". All values are test-value. The testnet may reset, and
the operator's own indexer coverage starts at block 91,563,904 rather than genesis, which
suggests it already has.

The only registered quote asset is **"Seedify Mock Stock SPCX"**, deployed and owned by
the operator's 2-of-3 Safe. It is **not** a Robinhood Stock Token. All 194 real RHJ stock
tokens exist only on mainnet 4663. Outputs label this on every record
(`quoteAssetIsMockStock`, `quoteAssetIsRealRobinhoodStockToken`).
