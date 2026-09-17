# Vibe/Vibe Testnet Indexer

> **Unofficial, community-built research indexer for the Vibe/Vibe deployment on Robinhood
> Chain testnet (Chain ID 46630).**

**Read this before anything else:**

- ❌ **NOT** official Vibe/Vibe software
- ❌ **NOT** affiliated with, endorsed by, or partnered with **Robinhood** or Robinhood Chain
- ❌ **NOT** affiliated with, endorsed by, or partnered with **Seedify**
- ❌ **NOT** production infrastructure
- ✅ **TESTNET ONLY**: chain 46630. All values are test-value.
- ✅ **READ-ONLY**: never signs a transaction, never writes on-chain, holds no keys
- ⚠️ **NO warranty of completeness.** Protocol behaviour may change without notice.
- ⚠️ **Factory addresses are configured manually.** A new factory generation will cause
  **silent incompleteness** until `config/factories.ts` is updated.

This is independent research software written by observing public chain data. Nothing here
implies any relationship with the operators of the protocols it reads.

---

## What It Does

Reconstructs Vibe/Vibe launches, trades, fees and buyback/burn accounting **directly from
public Robinhood Chain testnet data**: contract events and `eth_call`, with no dependency on
any private API.

In the reference run it reconstructed **77,166 launches across three factory generations**, with
provably dense launch-ID ranges (zero gaps, zero duplicates), and all sanity checks passing. The
[latest validation run](#latest-validation-run), on 2026-09-17, reconstructed **96,398** launches
with the same properties.

Every emitted field carries its provenance, so you can tell a decoded event from a head-only
contract read from an arithmetic derivation.

---

## Why It Exists

Reading this protocol correctly is harder than it looks, in ways that do not announce
themselves. Specifically:

- **Multiple factory generations coexist**, all still producing launches. Following only the
  newest one covers roughly **27%** of observed launches, with no error and no warning.
- **Launch IDs are factory-scoped, not globally unique.** Every factory numbers from 0, so IDs
  collide directly across generations.
- **Economics differ by generation.** One generation charges a different fee at a different
  split with a graduation target 1000x smaller.
- **The public API may omit launches.** During testing it returned HTTP 404 for recent launches
  from one factory that is still actively producing them.
- **Buyback/burn accounting requires vault awareness.** Reading the dead-address balance alone
  under-reports, because pre-graduation tokens cannot legally be transferred there.
- **The public RPC is not archival.** Observed state retention was roughly 4,096 blocks, so
  historical state could not be reconstructed from that endpoint.

This repository is an attempt to get those details right and to document them so others don't
have to rediscover them.

---

## Current Verified Findings

Reproduced by this indexer against testnet 46630:

| Finding | Detail |
|---|---|
| **3 factory generations observed** | All three were still producing launches at the time of the run |
| **77,166 launches reconstructed** | retired 14,663; legacy 41,858; current 20,645 |
| **Single-factory indexing covers ~27%** | 20,645 of 77,166; the rest is silently missed |
| **Retired generation uses different fee economics** | 100 bps at a 50/50 split, vs 125 bps at 75/25 |
| **A "retired"-labelled factory still produces launches** | Latest observed at block 118,865,843 |
| **The operator's published deployment list can shrink while a factory stays live** | `retiredPublicGraphs` went from one entry to **zero**, while that same factory produced 10 launches in the next 30,000 blocks. Treat the published list as additive-only: never remove a factory because it disappeared from it |
| **API blind spot for newest retired-factory launches** | 5 oldest sampled returned HTTP 200; **all 5 newest returned HTTP 404** |
| **Burn accounting must include vault-held tokens** | In one run, tokens held in launch vaults were comparable in size to tokens actually at the burn address |
| **`launchId` is not globally unique** | Ranges `0..14662`, `0..41857`, `0..20644` overlap directly |

> **These figures are point-in-time testnet observations and may change.**
> The chain is live; totals drift between runs. Every figure this tool emits is stamped with
> the head block it was read at.
>
> **Three runs are quoted in this repository and their totals differ, because the chain kept
> producing launches between them.** None has been back-fitted to another, and none refreshes
> automatically.
>
> | Run | When | Head block | Total launches | Where it appears |
> |---|---|---|---|---|
> | **Reference run** | 2026-09-13 | see below | 77,166 | This section and the generation table below |
> | Sample run | 2026-09-13T17:36Z | 118,855,856 | 77,226 | [`sample-output/`](sample-output/) |
> | **Latest validation run** | **2026-09-17T08:08Z** | **120,708,793** | **96,398** | [Latest validation run](#latest-validation-run) below |
>
> The reference-run figures are kept because the written findings were derived against them.
> Re-run the indexer for current numbers.

---

## Latest validation run

**2026-09-17.** A read-only run against Robinhood Chain testnet, chain ID 46630.

```bash
npm run index -- --enrich-limit 800 --trade-window 200000 --burn-window 2000000 --compare-api
```

| | |
|---|---|
| Head block | `120,708,793` |
| Finished | `2026-09-17T08:08:35Z` |
| **Total launches** | **96,398** across 3 configured factory generations |
| Sanity checks | **5 of 5 passed** |
| RPC calls | 167 in 104s (warm launch cache) |

| Generation | Launches | Observed launchId range | Dense | Duplicates | Last launch seen at block |
|---|---|---|---|---|---|
| `retired` | 14,799 | `0 to 14,798` | yes | 0 | 120,622,795 |
| `legacy` | 42,946 | `0 to 42,945` | yes | 0 | 120,690,796 |
| `current` | 38,653 | `0 to 38,652` | yes | 0 | 120,707,948 |

All three configured factories were readable on-chain and **all three had produced launches
within this run's window**, including the one the operator labels `retired`. No additional
factory was identified by the checks performed, which is not the same as none existing: this
indexer cannot discover a factory that is not in `config/factories.ts`.

Trade and burn figures are windowed, not lifetime: trades over blocks
`120,508,793 to 120,708,793`, burns over `118,708,793 to 120,708,793`.

**The chain is active and these totals change continuously.** Treat every number here as an
observation timestamped at the head block above, not as a standing property of the protocol.

---

## Factory Generations

| Generation | Factory address | Observed launchId range | Fee policy | Graduation target | Observed activity | Source |
|---|---|---|---|---|---|---|
| `retired` | `0x4FEbC267e0C24440bcDEF72B5DBC5FE7BED091dF` | `0 to 14,662` | **100 bps, 50/50** | **0.005 ETH** (verified) | **Still producing launches** (block 118,865,843) | Originally operator config API `retiredPublicGraphs[0]` (**since removed from that response**); liveness and economics confirmed on-chain |
| `legacy` | `0xB5B7A2f6c4EAFa2D73918fcA32d50e2126339eb9` | `0 to 41,857` | 125 bps, 75/25 | *not verified* | Still producing launches | Operator config API `legacyPublicGraphs[0]`; economics confirmed on-chain |
| `current` | `0x40f1be6faf8DAB9C143cce1a0A04c2075Fb2DF59` | `0 to 20,644` | 125 bps, 75/25 | 5 ETH (verified) | Still producing launches | Operator config API `deployments`; economics confirmed on-chain |

Full evidence for each value (including how it was read and what was deliberately left
unverified) is inline in [`config/factories.ts`](config/factories.ts) and
[`docs/fee-models.md`](docs/fee-models.md).

**"Retired" is the operator's label, not an observed state.** This indexer records
`observedStillProducingLaunches` separately and scans all three regardless.

---

## Installation

Requires **Node.js 20+**.

```bash
git clone <your-fork-url> vibevibe-testnet-indexer
cd vibevibe-testnet-indexer
npm install
```

---

## Configuration

Copy the example and edit if you want a keyed RPC provider:

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|---|---|---|
| `RPC_URL` | public Robinhood Chain testnet RPC | Your RPC endpoint. A keyed provider is strongly recommended for anything beyond experimentation: the public endpoint is rate-limited and **not archival**. |
| `LOG_CHUNK_BLOCKS` | `20000` | Blocks per `eth_getLogs` call. Adaptive: halves on a range or result-count error. |
| `REQUEST_DELAY_MS` | `150` | Politeness delay between RPC calls. Do not set to 0 against a public endpoint. |
| `MAX_RETRIES` | `5` | Retry budget for transient failures. |
| `RETRY_BASE_MS` | `600` | Exponential backoff base. |
| `VIBE_API_BASE` | operator API base | Only used by the optional `--compare-api` cross-check. |

**No credentials are required to run.** `.env` is gitignored; never commit a keyed URL.

---

## Running

```bash
npm run index                # default run
npm run index:quick          # smaller windows, faster
npm run help                 # all flags
npm test                     # assumption tests, no network needed
npm run typecheck
```

Flags (all of these exist; nothing is documented that the CLI does not implement):

| Flag | Default | Effect |
|---|---|---|
| `--enrich-limit N` | `1500` | How many projects get head-state reads (name, symbol, lifecycle, vault balance). Budgeted because the RPC prunes state after ~4,096 blocks. |
| `--trade-window N` | `200000` | Index curve events over the last N blocks. |
| `--trade-from N` | none | Explicit start block for the trade scan; overrides the window. |
| `--full-trades` | off | Scan trades from the earliest factory deployment (~23M blocks, long). |
| `--burn-window N` | `200000` | `Transfer -> 0x...dEaD` scan window. |
| `--full-burns` | off | Scan burns across full history. |
| `--compare-api` | off | Optional cross-check against the operator's public API. |
| `--emit-bulk` | off | Also write the large artifacts (see Outputs). |

Example matching the validation run whose output is committed under `sample-output/`:

```bash
npm run index -- --enrich-limit 800 --trade-window 200000 --burn-window 2000000 --compare-api
```

Helper scripts that demonstrate specific findings:

```bash
npm run check:burn-model      # targeted test of the vault-vs-dead-address model
npm run check:api-coverage    # does the operator API serve every launch the chain has?
```

---

## Outputs

Written to `output/`.

**Always emitted (small):**

| File | Contents |
|---|---|
| `factories.json` | All configured generations, launches indexed per generation, shared contracts, keepers, quote assets, run metadata, launchId audit, and `run.foreignActivity` (curve-shaped activity from unrecognised contracts) |
| `fees.json` | **Fee policy per generation**, observed aggregates, burn accounting (both legs), sanity-check results |
| `lifecycle.json` | Curve completions, graduations, creator-fee forwards |
| `indexer-summary.md` | Human-readable run report |
| `projects-enriched-sample.json` | Up to 500 fully enriched project records, readable by hand |
| `api-comparison.json` | **Always written.** Without `--compare-api` it contains a disabled stub (`enabled: false`, empty `spotChecks`) so a consumer can tell "comparison was switched off" from "comparison ran and found nothing" |

> ### Your RPC URL and generated artifacts
>
> All redaction lives in [`src/lib/redact.ts`](src/lib/redact.ts). A keyed endpoint appears as
> `https://host.example/<redacted>`; userinfo, path and query are discarded.
>
> **Guaranteed by construction, and covered by tests:**
>
> - `RunMeta` has no raw-URL field. It stores `rpcEndpoint`, already sanitized at the point
>   it is built, so no emitter can leak one by forgetting to redact. `factories.json` and
>   `indexer-summary.md` receive only that value, and `emitFactories` refuses to write if
>   handed something that still looks credential-bearing.
> - `config.rpcUrl` is read in exactly two places, both of which construct the viem transport.
>   No write path receives it.
> - Every error message this tool **persists** is scrubbed before it is truncated, not after:
>   `readError` in `data/raw/token-state.json` and `curve-state.json`, `error` in
>   `protocol-state.json`, and `note` in `api-comparison.json`. Truncating first would have
>   kept the key, because viem puts the URL near the front of the message.
>
> **What is not guaranteed.** Scrubbing arbitrary error text is pattern-based: it rewrites
> anything matching an `http(s)://` URL, plus literal occurrences of the configured endpoint.
> A reference that is neither, such as a schemeless `host.example/v2/KEY` produced by some
> future library, would not be recognised. This is a best-effort defence over third-party text,
> not a proof about all possible strings.
>
> **Least privilege still applies.** Prefer an RPC key scoped to read-only testnet access, and
> rotate it if you have shared raw logs or `data/` contents.

**Opt-in via `--emit-bulk` (large: a full run is ~400 MB each):**

| File | Contents |
|---|---|
| `projects.json` / `projects.ndjson` | Every project with full provenance |
| `projects.csv` | Flattened, provenance stripped, spreadsheets only |
| `trades.json` | Every indexed trade plus scan scope and integrity counters |
| `data/raw/*` | Raw decoded chain data before derivation |

See [`sample-output/`](sample-output/) for trimmed, committed examples, and
[`docs/data-model.md`](docs/data-model.md) for the full field reference.

---

## Data Provenance

Every non-trivial field is wrapped so you can tell where it came from:

```jsonc
{
  "value": 125,
  "source": "derived",
  "confidence": "high",
  "note": "expected 125 bps for generation \"current\""
}
```

| `source` | Meaning | Trust |
|---|---|---|
| `onchain_event` | Decoded from a contract event log | **Highest**: immutable, independently verifiable |
| `contract_read` | `eth_call` | High, but **HEAD-ONLY**: state prunes after ~4,096 blocks |
| `derived` | Computed from other fields in the record | Inherits its weakest input; scan-scope caveats land here |
| `config` | Constant from the verified address book | High |
| `vibe_api` | Operator API | **Never appears in an emitted record.** Cross-check only, confined to `api-comparison.json` |
| `unavailable` | `value` is `null`; the note says why | A deliberate absence, never a guess |

`confidence: "medium"` means one of two things, and the field's `note` says which:
**windowed scope** on a trade-derived field, or **an attribution assumption** on
`totalSupplyCommittedToBurnWei`, where `burned + vaultBalance` is exact arithmetic over a
vault balance whose buyback origin is assumed rather than proven, making the figure an upper
bound. See [`docs/known-limitations.md`](docs/known-limitations.md) section 8.

For the windowed case: the number is
real but is not a lifetime total.

---

## Important Accounting Notes

**1. Fee models are generation-specific.**
No platform-wide rate was observed across the generations reviewed. Applying 125 bps to a
retired-generation launch overstates the
fee by 25% and the creator share by 50%. Read `TOTAL_FEE_BPS()` per curve, or better, read
`creatorFee` / `protocolFee` straight off the trade event; they are carried inline. See
[`docs/fee-models.md`](docs/fee-models.md).

**2. `launchId` is a factory-scoped namespace.**
Use `{generation}:{launchId}` or the token address. Keying on `launchId` alone collapses
projects from different factories into one row, silently, on write.

**3. Buyback tokens can be held in vaults, not burned.**
While a launch is on its curve, `transfersUnlocked()` is `false`, so a transfer to
`0x...dEaD` reverts with `TransfersLocked()`. Bought-back tokens are held in the launch's
`CreatorVault` and only move to the burn address after graduation.

**Dead-address balance alone is NOT full buyback/burn accounting:**

```
supplyCommittedToBurn = balanceOf(0x...dEaD) + balanceOf(creatorVault)
```

A locked token with real buyback activity reports **zero** under naive accounting. This
indexer emits both legs plus the total, and asserts the invariant that a locked token must
never hold a burn-address balance.

**4. Locked vs unlocked lifecycle.**
`transfersUnlocked() === false` means the token cannot move at all: not to a DEX, a lending
market, or the burn address. Check it before any transfer path.

**5. Graduation is two transactions.**
`CurveCompleted` then `Graduated`, separated by a permissionless, retryable `graduate()` call.
Gaps of 91 and 1,030 blocks were observed. Model the intermediate state explicitly.

---

## Known Limitations

- **TESTNET ONLY.** Chain 46630. Vibe/Vibe **mainnet is not supported**. No mainnet
  deployment was identified during this research, and chain 4663 is explicitly rejected by this
  tool.
- **Public RPC state retention was measured at roughly 4,096 blocks.** Beyond that, `eth_call`
  returned `metadata is not found` / `missing trie node` during testing. Treat all contract
  reads as head-only snapshots; historical state is not recoverable from that endpoint.
- **Token metadata may be unrecoverable.** `name`/`symbol` live in contract state and were not
  found in any event in the ABI surfaces reviewed. For a token whose state has been pruned,
  they could not be read back via RPC during testing.
- **Historical trade scans are expensive.** `--full-trades` covers ~23M blocks against a shared
  public endpoint. Use a keyed provider and be patient.
- **10,000-result log cap.** `logs matched by query exceeds limit of 10000` is undocumented and
  is the binding constraint for dense ranges. Handled adaptively; never assume a fixed block
  range is safe.
- **Factory addresses are not discoverable through any canonical registry.** They are
  hand-maintained in `config/factories.ts`.
- **A future factory generation requires a config update.** Until then this indexer will
  under-count **silently**: an unconfigured factory's logs are never scanned, so nothing
  throws and nothing warns. The separate fail-loud behaviour applies only to a generation that
  **is** configured but lacks a verified economic policy; that case throws rather than
  inheriting another generation's economics. Fail-safe economics does not solve discovery.
- **The API is comparison/convenience, not source of truth.** It is browser-origin restricted
  (server-side works, third-party browser origins get 403), rate-limited, and was observed to
  omit recent launches from one generation.
- **Post-graduation trading is not indexed.** Trading moves to Uniswap v4 after graduation;
  only curve-phase trades are covered, so totals understate graduated projects.
- **No reorg handling** beyond a 32-block cache exclusion.

Full detail: [`docs/known-limitations.md`](docs/known-limitations.md).

---

## Documentation

| File | Contents |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Pipeline, module map, adaptive scanning, caching, design principles |
| [`docs/event-map.md`](docs/event-map.md) | Topic hashes, event signatures, query strategy, RPC limits |
| [`docs/fee-models.md`](docs/fee-models.md) | Per-generation economics, and the fail-safe for configured generations that lack a verified policy |
| [`docs/data-model.md`](docs/data-model.md) | Every output field and its provenance rules |
| [`docs/known-limitations.md`](docs/known-limitations.md) | What this cannot do, and why |

---

## Contributing

Useful contributions, roughly in order of value:

1. **A new factory generation**: add a verified entry to `config/factories.ts` with evidence.
2. **Post-graduation Uniswap v4 `Swap` indexing**: the largest correctness gap.
3. **IPFS metadata fetching** with digest verification.
4. **Automatic factory discovery**, so a new generation is not a silent miss.
5. More assumption tests.

Please include how you verified any on-chain claim.

---

## Disclaimer

Research software, provided as-is under the MIT licence. **No warranty of correctness,
completeness or fitness for any purpose.**

Nothing here is financial, investment, legal or tax advice. Nothing here is an endorsement of
any protocol, token or platform. Testnet tokens have no monetary value.

This project is not affiliated with Vibe/Vibe, Seedify, Robinhood, Robinhood Chain, or any of
their operators. All protocol names and addresses are referenced for identification only.
Observations are point-in-time and may be wrong or outdated, so verify anything you rely on.

Third-party dependency licences: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
