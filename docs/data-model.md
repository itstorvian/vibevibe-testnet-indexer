# OUTPUT SCHEMA

All amounts are **base units as decimal strings** (never JS numbers, because a wei value does not
fit in a double). Addresses are lowercased hex. Blocks are numbers.

**Network: Robinhood Chain TESTNET, chain 46630.** All values are test-value.

---

## The provenance envelope

Every non-trivial field in `projects.json` is wrapped:

```jsonc
{
  "value": <T> | null,
  "source": "onchain_event" | "contract_read" | "vibe_api" | "derived" | "config" | "unavailable",
  "confidence": "high" | "medium" | "low" | "none",
  "note": "required when value is null or confidence < high"
}
```

| `source` | Meaning | Trust |
|---|---|---|
| `onchain_event` | Decoded from a contract event log | **Highest.** Immutable, independently verifiable, no operator involvement |
| `contract_read` | `eth_call` | High, but **HEAD-ONLY**: state is pruned after ~4k blocks |
| `derived` | Computed from other fields in the record | Inherits the weakest input; scan-scope caveats land here |
| `config` | Constant from the verified address book | High, verified on-chain during due diligence |
| `vibe_api` | Operator REST API | **Never appears in `projects.json`.** Cross-check only, in `api-comparison.json` |
| `unavailable` | `value` is `null`; `note` says why | Deliberate absence, never a guess |

`confidence: "medium"` has two distinct meanings in this dataset, and the field's `note`
says which one applies:

1. **Windowed scope.** On a trade-derived field, the
   number is real but is not a lifetime total.
2. **Attribution assumption.** On `totalSupplyCommittedToBurnWei`, the arithmetic is exact
   but the provenance of the vault balance is assumed rather than proven, so the value is an
   upper bound.

For case 1: the
number is real but is not a lifetime total. The note names the block range.

---

## `output/projects.json`

```jsonc
{
  "network": "TESTNET",
  "chainId": 46630,
  "generatedAt": "ISO-8601",
  "count": 77102,
  "provenanceLegend": { ... },
  "projects": [ ProjectRecord, ... ]
}
```

Written with a streaming writer: 77k records with full provenance exceed Node's maximum
string length. `output/projects.ndjson` carries the same records one per line, which is
what a downstream consumer should actually stream.

### `ProjectRecord`

**`key`** is `"{generation}:{launchId}"`. Required because **`launchId` is not globally
unique**; counters restart per factory generation.

#### `identity`
| Field | Source | Notes |
|---|---|---|
| `launchId` | `onchain_event` | per-factory counter, not globally unique |
| `generation` | `config` | `retired` \| `legacy` \| `current` |
| `factory` | `onchain_event` | emitting factory address |
| `factoryVersionNote` | `config` | which config-API list this generation came from |
| `token`, `curve`, `creator`, `creatorFeeRecipient`, `creatorVault` | `onchain_event` | the full project graph, from one event |
| `name`, `symbol`, `decimals` | `contract_read` | **head-only**; `unavailable` outside `--enrich-limit`. These appear in **no event** |
| `metadataURI`, `metadataDigest` | `onchain_event` | IPFS pointer + on-chain commitment. Content not fetched by this prototype |

#### `timing`
`deploymentBlock`, `deploymentTxHash` (`onchain_event`); `launchTimestamp`
(`contract_read`, unix seconds, head-only).

#### `lifecycle`
| Field | Source | Notes |
|---|---|---|
| `state` | read or event | `CURVE_TRADING` \| `CURVE_COMPLETE_AWAITING_GRADUATION` \| `GRADUATED` \| `UNKNOWN` |
| `transfersUnlocked` | `contract_read` | **the key composability flag.** `false` = token cannot move at all |
| `curveCompletedBlock` | `onchain_event` | from `CurveCompleted` |
| `graduated` | read or event | |
| `graduationTxHash`, `graduationBlock` | `onchain_event` | from `Graduated` |
| `poolId` | event or read | Uniswap v4 pool id |
| `poolManager` | `config` | v4 PoolManager (verified source on the explorer) |

Precedence: a head read wins over an event, because the read reflects *now* while an
event only proves a past transition. When neither exists the state is `UNKNOWN` with a
note, never guessed.

#### `market`
| Field | Notes |
|---|---|
| `quoteAsset` | zero address = native-ETH-quoted |
| `quoteAssetSymbol` | `ETH` or `SPCX` |
| `isQuotedLaunch` | true only for `TokenLaunchedQuoted` |
| `quoteAssetIsMockStock` | **true for SPCX**, an operator-deployed mock |
| `quoteAssetIsRealRobinhoodStockToken` | **false for every launch observed on testnet.** At the time of verification, all 194 RHJ assets listed by the issuer API were deployed on mainnet 4663 only |

#### `activity`
`totalTrades`, `buyCount`, `sellCount`, `buyVolumeWei`, `sellVolumeWei`,
`totalVolumeWei`, `uniqueTraders`.

Volumes sum `Bought.grossEthUsed` and `Sold.grossCurveQuote`. On a quoted launch these
are **quote-asset units, not wei**. The field name says Wei for schema stability; read
`market.quoteAsset` before interpreting. `uniqueTraders` counts distinct `msg.sender`,
not people.

#### `fees`
`totalFeesWei`, `creatorFeesWei`, `protocolFeesWei` are summed from the `creatorFee` and
`protocolFee` fields carried **inside** each trade event. No computation needed.

`observedFeeBps` and `observedCreatorShareBps` are the per-project measured values. The
expected reading is **generation-specific**, so check it against the project's own generation:

| Generation | `observedFeeBps` | `observedCreatorShareBps` |
|---|---|---|
| `retired` | 100 | 5000 |
| `legacy` | 125 | 7500 |
| `current` | 125 | 7500 |

Expecting 125 / 7500 everywhere overstates a retired-generation launch's fee by 25% and its
creator share by 50%. See [`fee-models.md`](fee-models.md). `creatorFeesAccruedOnCurve` / `protocolFeesAccruedOnCurve` are
*unclaimed* balances (head-only). `creatorFeesForwardedWei` sums `CreatorFeesForwarded`.

#### `buybackBurn`
| Field | Notes |
|---|---|
| `burnedToDeadAddressWei` | `balanceOf(0x...dEaD)` when enriched, else summed from `Transfer->dEaD` logs in the scan window |
| `heldForBurnInVaultWei` | `balanceOf(creatorVault)`, the pre-graduation leg |
| `totalSupplyCommittedToBurnWei` | **burned + held.** The supply-impact figure to use; the burn address alone under-reports. Emitted at `confidence: "medium"`: the sum is exact, but treating the whole vault balance as buyback-origin is an assumption, so read it as an **upper bound** unless token provenance is independently established. See [`known-limitations.md`](known-limitations.md) section 8 |
| `burnEventCount` | count of `Transfer->dEaD` logs in the scanned window |

Counting only the burn address under-reports every pre-graduation token, because
`transfersUnlocked() == false` makes a transfer to `0x...dEaD` revert.

#### `treasuries`
`projectTreasury` = the per-launch `CreatorVault` (EIP-1167 clone): receives the creator
fee share and holds buyback tokens pre-graduation. `protocolTreasury` is
generation-specific: each generation has its own.

#### `provenanceSummary`
Per-record counts of `onchain_event` / `contract_read` / `derived` / `unavailable` fields.
Aggregated in `indexer-summary.md` to answer "how much of this came from the chain".

---

## `output/projects.csv`
One flat row per project, provenance stripped to bare values (`identity_token`,
`fees_totalFeesWei`, ...). For spreadsheets. **Use the JSON when provenance matters**: the
CSV cannot distinguish a real zero from an unavailable field.

## `output/trades.json`
Streamed. Carries `scope` (block range + `isFullHistory`), `counts`, and `integrity`
(`foreignLogsIgnored`, logs sharing a curve topic0 that came from non-Vibe contracts and
were excluded). Trade records: `curve`, `token`, `side`, `trader`, `recipient`,
`grossWei`, `curveQuoteWei`, `ethReceivedWei`, `tokenAmount`, `creatorFeeWei`,
`protocolFeeWei`, `totalFeeWei`, `blockNumber`, `txHash`, `logIndex`.

## `output/lifecycle.json`
`CurveCompleted`, `Graduated`, `CreatorFeesForwarded`, split out because they are a much
smaller set than trades.

## `output/activity.json`
The transaction metric, and the scope that makes it quotable.

| Field | Meaning |
|---|---|
| `uniqueTransactionCount` | **The published figure.** Distinct transaction hashes across every included surface, deduplicated globally. |
| `scope` | `"launch-and-curve-events"`. Deliberately not "all Vibe/Vibe transactions". |
| `isFullHistory` | True only when *every* contributing scan covered full history. False means the figure is a window's worth and must not sit beside lifetime totals. |
| `launchTransactionCount` / `tradeTransactionCount` / `lifecycleTransactionCount` | Distinct hashes *within* each category. These do **not** sum to the total. |
| `sharedAcrossCategories` | How many hashes appear in more than one category, i.e. exactly how much the naive sum overstates by. |
| `unusableTransactionHashes` | Rows whose hash could not be normalised to 32 bytes and were not counted. Reported, never silently dropped. |
| `launchScan` / `curveScan` | Block bounds and full-history flag for each contributing scan. |
| `includedEventSurfaces` | The exact events that contribute a transaction. |
| `exclusions` | What a Vibe/Vibe transaction can be and still be absent. |
| `warning` | Null on a full-history run; a refusal-to-be-misread paragraph otherwise. |

**Why a hash and not a row.** One transaction can emit several of the included events: the
buy that tips a curve over its target emits `Bought` and `CurveCompleted` together, and a
launch with a non-zero `initialBuy` emits `TokenLaunched` and the curve's first `Bought`.
Counting event rows, or summing the three category counts, overstates transactions by
exactly that overlap. Derivation lives in `src/derive/activity.ts`; no emitter counts
hashes of its own.

Aggregates only. The hashes themselves stay in the opt-in bulk artifacts, where the count
can be reproduced.

## `output/fees.json`
`policy` (the constants, with their evidence labels), `observed` (measured aggregates),
`buybackBurn` (both legs), and `checks` (the sanity-check results). The second-level
50/50 splits are present but are labelled as operator-stated rather than verified; this indexer
does not reconstruct them.

## `output/factories.json`
All three generations with deployment blocks, per-generation infrastructure addresses,
launches indexed per generation, shared contracts, keeper EOAs, quote assets, and the
economics constants.

## `output/api-comparison.json`
Only populated with `--compare-api`. Records the CORS asymmetry (no `Origin` -> 200;
foreign `Origin` -> 403), the rate-limit headers, whether the operator's published
economics match the on-chain constants, and per-field spot checks. **Nothing here feeds
`projects.json`.**

## `output/indexer-summary.md`
Human-readable run report: totals, per-generation counts, scan scope, provenance
distribution, sanity-check results, `launchId` audit, and RPC cost.

---

## `data/`: raw, unjoined
`data/raw/` holds decoded-but-underived chain data (`launches.json`, `trades.json`,
`burns.json`, `token-state.json`, `curve-state.json`, `protocol-state.json`).
`data/cache/` holds per-chunk log caches keyed `{scan}/{from}-{to}.json` plus checkpoints.

**Raw and derived are deliberately separate.** `data/` is what the chain said; `output/`
is what this indexer concluded.
