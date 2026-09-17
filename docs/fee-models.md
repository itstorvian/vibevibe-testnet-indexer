# FEE MODELS

**The single most important thing in this repository: no platform-wide fee rate was observed.**

Fee economics differ by factory generation. An indexer that applies one rate everywhere
produces confident, wrong numbers for a large slice of the ecosystem, with no error.

All values below were read on-chain from Robinhood Chain **testnet 46630** and cross-checked
against decoded trade events. They are point-in-time observations and may change.

---

## Observed policy by generation

| Generation | Factory | Total fee | Creator / protocol | Graduation target | `quoteCurrency()` |
|---|---|---|---|---|---|
| `retired` | `0x4FEbC267...091dF` | **100 bps (1.00%)** | **50 / 50** | **0.005 ETH** | **absent, reverts** |
| `legacy` | `0xB5B7A2f6...39eb9` | 125 bps (1.25%) | 75 / 25 | *not verified* | *not verified* |
| `current` | `0x40f1be6f...2DF59` | 125 bps (1.25%) | 75 / 25 | 5 ETH | present |

### How this was established

- **Direct contract reads.** `curve.TOTAL_FEE_BPS()` returned `100` on six independently
  sampled retired-generation curves and `125` on legacy and current curves.
- **Decoded trade events.** Across 92,404 non-dust indexed trades in the reference run:
  - `retired`: 126 / 126 within 2 wei of 100 bps at a 5000 bps creator share
  - `legacy`: 28,805 / 28,805 at 125 bps / 7500 bps
  - `current`: 63,473 / 63,473 at 125 bps / 7500 bps
  - **zero exceptions in any generation**
- **Graduation target.** `curve.NET_GRADUATION_TARGET()` read `5e15` (0.005 ETH) on retired
  curves and `5e18` (5 ETH) on current, a **1000x** difference.

`TOTAL_FEE_BPS` is a constant on the curve. No setter was found on any contract reviewed, so
within a generation the rate appears fixed.

---

## Why this matters: the concrete error

Applying 125 bps / 75-25 to a retired-generation launch:

| Quantity | Correct | If you assume the newer policy | Error |
|---|---|---|---|
| Total fee | 100 bps | 125 bps | **+25%** |
| Creator share of fee | 50% | 75% | **+50%** |
| Protocol share of fee | 50% | 25% | **-50%** |
| Graduation progress denominator | 0.005 ETH | 5 ETH | **1000x**, so a fully graduated curve renders as 0.1% complete |

In the reference run, the retired generation held **14,663 of 77,166 launches (~19%)**.

---

## The safe way to read fees: don't compute them

`Bought` and `Sold` carry the split **as event fields**:

```solidity
event Bought(address indexed buyer, address indexed recipient,
  uint256 grossEthUsed, uint256 curveQuote, uint256 tokenAmount,
  uint256 creatorFee, uint256 protocolFee);

event Sold(address indexed seller, uint256 tokenAmount, uint256 grossCurveQuote,
  uint256 ethReceived, uint256 creatorFee, uint256 protocolFee);
```

**Read `creatorFee` and `protocolFee` directly.** A consumer that does this never encounters
the divergence at all, because the on-chain data is self-describing. This indexer does exactly that
for its totals, and uses the policy table only to *verify* the events against an expected
constant.

You need the policy table when you are **projecting** rather than **reading**: modelling a
launch that hasn't happened, estimating "what would X volume earn", or rendering a graduation
progress bar (which has no event to fall back on).

---

## Fail-safe behaviour for unknown generations

**This protection is narrower than it sounds. Read which case it covers.**

| Case | Situation | Behaviour |
|---|---|---|
| **A** | A generation IS listed in `config/factories.ts`, but its economic policy is missing or unverified | **Fails loudly.** `resolveFeePolicy` throws rather than inheriting another generation's numbers |
| **B** | A factory exists on-chain and is **NOT** listed in `config/factories.ts` | **Silently missed.** Its logs are never scanned, so nothing throws and nothing warns |

Case A is what the code below protects. Case B is an open limitation: fail-safe economics
does not solve factory discovery, and nothing in this repository does. See
[`docs/known-limitations.md`](known-limitations.md).

For Case A, the indexer throws `UnsupportedGenerationError` rather than borrowing another
generation's numbers:

```ts
resolveFeePolicy("gen4-unknown");
// UnsupportedGenerationError: Unsupported factory/generation "gen4-unknown".
// This indexer has no verified economic policy for it, and will NOT assume one
// from another generation. Add a verified entry to config/factories.ts before
// indexing it. See docs/fee-models.md.
```

This is deliberate. A future generation could diverge again, exactly as the retired one did.
Silently defaulting would produce the same class of error this whole repository exists to
prevent.

The same rule applies **within** a generation: `legacy`'s graduation target is `null` because
it was not read on-chain. It is **not** filled in from `current`. `null` means unverified,
never "same as the others".

---

## Second-level splits: deliberately not implemented

The operator's config API states that the creator side splits 50/50 into creator payout and
launch-token buyback, and the protocol side 50/50 into treasury accrual and SFUND buyback.

**This is OPERATOR-STATED and was not verified on-chain.** It is recorded in
`PROTOCOL_CONSTANTS.operatorStatedSecondLevelSplits` for reference, is labelled as unverified
in `output/fees.json`, and is **not used in any calculation** here. Reconstructing it would
require tracing vault withdrawals and keeper swap paths per launch.

---

## Wei-level effects to expect

- **Rounding.** Integer division at wei scale means a fee can differ from the exact
  percentage by 1-2 wei. The sanity checks use a 2-wei tolerance rather than exact equality.
- **Dust makes rates meaningless.** Trades observed with gross of 179, 200 and 254 **wei**
  computed to 167, 150 and 157 bps respectively, purely from a 1-wei remainder. Any effective-
  rate metric needs a denominator floor; this indexer excludes gross below 1,000 wei from rate
  statistics and reports the excluded count.
- **Graduation overshoots slightly.** Observed at `5000000000000000016` and
  `5000000000000000021` wei against a 5 ETH target. Never assert equality on the target.

---

## Verifying this yourself

```bash
npm test                       # asserts both policies and the fail-safe path
npm run index -- --enrich-limit 500 --trade-window 100000
```

The run prints, per generation, how many trades matched their expected policy:

```
[PASS] total fee matches each generation's policy
       observed: 35669/35669 within 2 wei
       [current:25302/25302@125bps, legacy:10197/10197@125bps, retired:170/170@100bps]
```

If a generation that is **configured** appears with a different rate, that check **fails
loudly** rather than quietly averaging it away. That is the intended behaviour, and it is how
the retired generation's divergence was discovered in the first place.

It does not help with a factory that was never configured: those launches are absent from the
input entirely, so there is nothing for the check to disagree with.
