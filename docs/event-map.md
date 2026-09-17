# EVENT MAP

Everything an outside indexer needs in order to reconstruct vibe/vibe from logs.
**None of this is documented by the operator.** The signatures below were recovered from
the public frontend bundle, confirmed by decoding live logs, and topic hashes computed
locally. Any signature that has *not* been confirmed against a live log is marked.

**Network: Robinhood Chain TESTNET, chain 46630.**

## Topic hashes

| Event | topic0 | Confirmed against live logs? |
|---|---|---|
| `TokenLaunched` | `0x56eef5c350583250e71791d6d659f4d181796c9deb08b977252efc3995aa9279` | **yes**, all three generations |
| `TokenLaunchedQuoted` | `0x34041bc557672fe6a73853ece671e7715108f75e25427bfddf3e2f8e2085a0e7` | **yes**, but rare: 1 in 77k launches |
| `LaunchFeesClaimed` | `0x5326669ac9b092e736c22b5ad8dc2eee4ea9c954c6aa1ab998cb9e25588c257e` | **yes** |
| `Bought` | `0x8a5254432535d4192429d2cc163283a57784eac274295fcda17cc659c1ee414c` | **yes** |
| `Sold` | `0x917d0fe1b6c3328f12a0177d25bf1b7d9e963116addad0bfc06b0cdcb6427603` | **yes** |
| `CurveCompleted` | `0x654e1d49372e305713e05ff2ed090670dd8683b365ce33618c15e187b875d21d` | **yes** |
| `Graduated` | `0xc1eaf6441a62895ddec3612cee606bd971cf6b1b38dd700f103e7b6b94167d0c` | **yes** |
| `CreatorFeesForwarded` | `0xbaf18a788f79bd1cdd660a8ddfb8dbcac3d7f2a33c05c6dd3d32d32a15b70bc7` | **yes** |
| `Transfer` (ERC-20, used for burns) | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` | **yes** |

## Signatures

### Factory: emitted by all three generations, ABI-compatible

```solidity
event TokenLaunched(
  uint256 indexed launchId,
  address indexed token,
  address indexed curve,
  address creator,
  address creatorFeeRecipient,
  address creatorVault,
  uint256 initialBuy,
  uint256 initialTokensBought,
  uint16  metadataSchemaVersion,
  bytes32 metadataDigest,
  string  metadataURI
);

// Stock-paired launches. Same shape plus quoteCurrency.
event TokenLaunchedQuoted(
  uint256 indexed launchId, address indexed token, address indexed curve,
  address creator, address creatorFeeRecipient, address creatorVault,
  address quoteCurrency,
  uint256 initialBuy, uint256 initialTokensBought,
  uint16 metadataSchemaVersion, bytes32 metadataDigest, string metadataURI
);

event LaunchFeesClaimed(address indexed treasury, uint256 amount);
```

This single event carries the whole project graph: token, curve, creator, fee recipient,
vault, the creator's atomic launch buy, and the IPFS metadata pointer with its on-chain
digest. **Enumerating projects did not require the operator's API at any point during this
research.**

### Curve: emitted by each per-launch curve contract

```solidity
event Bought(
  address indexed buyer,
  address indexed recipient,  // note: buyer != recipient when bought via buyFor()
  uint256 grossEthUsed,       // quote-asset units on a quoted launch
  uint256 curveQuote,
  uint256 tokenAmount,
  uint256 creatorFee,         // generation-specific share, see below
  uint256 protocolFee          // generation-specific share, see below
);

event Sold(
  address indexed seller,
  uint256 tokenAmount,
  uint256 grossCurveQuote,
  uint256 ethReceived,
  uint256 creatorFee,
  uint256 protocolFee
);

event CurveCompleted(uint256 netEthReserve, uint256 timestamp);
event Graduated(bytes32 indexed poolId, uint256 ethAmount, uint256 tokenAmount);
event CreatorFeesForwarded(address indexed vault, uint256 amount);
```

`Bought` and `Sold` carry the fee split inline. **You do not need to compute fees**.
Read `creatorFee` and `protocolFee` directly. The main reason to compute them is verification,
which is what `src/verify/checks.ts` does.

**The split is generation-specific.** Reading the values from the event avoids the trap; deriving
them from a remembered constant walks straight into it:

| Generation | Total fee | `creatorFee` | `protocolFee` |
|---|---|---|---|
| `retired` | 100 bps | 50% of the fee | 50% of the fee |
| `legacy` | 125 bps | 75% of the fee | 25% of the fee |
| `current` | 125 bps | 75% of the fee | 25% of the fee |

See [`fee-models.md`](fee-models.md) for how each row was verified.

### Burns: no protocol-level burn event was identified

```solidity
event Transfer(address indexed from, address indexed to, uint256 value);
// filter: to == 0x000000000000000000000000000000000000dEaD
```

Burns are ordinary ERC-20 transfers. Watch tokens, not the protocol. See
`docs/known-limitations.md` for the pre-graduation vault subtlety that makes naive burn
accounting wrong.

## Query strategy that actually works

| Scan | Filter | Why |
|---|---|---|
| Launches | `address: [gen1, gen2, gen3]`, all factory events | Address arrays are supported. One pass covers all generations. |
| Trades | **topic-only, no address filter** | Tens of thousands of curve contracts exist; you cannot enumerate them in an address filter. Topic-only queries work on this RPC. |
| Burns | `Transfer` topic + indexed `to = 0x...dEaD` | Indexed-arg filtering happens node-side, so this is one cheap query rather than a per-token fan-out. |

**Correctness requirement for topic-only scans:** they return logs from *any* contract
sharing that topic0. On a public testnet full of copycat deployments this is a real risk.
This indexer cross-checks every curve log against the curve set reconstructed in stage 1
and reports the ignored count (`integrity.foreignLogsIgnored` in `output/trades.json`)
rather than silently dropping it.

## Two undocumented RPC limits, both found by hitting them

| Limit | Error string | Practical effect |
|---|---|---|
| Query **time** | `log query timed out` | a 1,000,000-block span fails; 100,000 succeeds |
| Query **result count** | `logs matched by query exceeds limit of 10000` | **the binding constraint.** In a busy region the chain emits ~360 curve logs per 3,000 blocks, so a topic-only trade scan hits the cap after roughly 25-30k blocks |

An indexer tuned only against the block-range limit will work on quiet historical ranges
and then fail on recent ones. `src/lib/logscan.ts` halves the chunk on either error and
creeps back up after sustained success.

## Ordering and keys

- Order logs by `(blockNumber, logIndex)`. Both are needed, since many launches and trades
  share a block.
- **`launchId` is NOT globally unique.** Every factory numbers its launches from 0
  independently, so ids collide directly across generations. Key on
  `${generation}:${launchId}`, or on `tokenAddress`, which is unique.
  A full-history scan shows each range is **dense**: retired `0..14662`, legacy
  `0..41857`, current `0..20644`, zero gaps and zero duplicates (reference-run
  figures, matching `config/factories.ts`). That density is
  how you prove a reconstruction is complete rather than merely large.
- `token` and `curve` are both `indexed` on the launch events, so you can filter by
  either without a full scan.

## What has NO event

These exist only as contract state, and this RPC prunes state after ~4k blocks:

| Fact | Where it lives |
|---|---|
| token `name()` / `symbol()` / `decimals()` | token contract state, **head-only** |
| `transfersUnlocked()` | token contract state, head-only |
| current curve reserves, `complete()`, `graduated()` | curve state, head-only |
| unclaimed `creatorFeesAccrued()` / `protocolFeesAccrued()` | curve state, head-only |
| vault token balance (the held-for-burn leg) | token balance, head-only |
| quote-asset registration | QuoteRegistry state, head-only |

This is the single biggest structural constraint on reconstruction. See
`docs/known-limitations.md`.
