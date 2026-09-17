import type { Address } from "viem";

/**
 * ============================================================================
 * FACTORY CONFIGURATION: MANUALLY MAINTAINED. READ THIS BEFORE TRUSTING OUTPUT.
 * ============================================================================
 *
 * No canonical on-chain registry enumerating Vibe/Vibe factory deployments was
 * identified during this research. This file is a hand-maintained address book,
 * verified on-chain on the date below.
 *
 * CONSEQUENCE YOU MUST UNDERSTAND:
 *
 *   If a NEW factory generation is deployed and is not added to this file, this
 *   indexer will silently under-count. It will not error. It will not warn. It
 *   will produce a complete-looking dataset that is missing every launch from
 *   the unknown factory.
 *
 *   During research, indexing only the newest factory would have captured
 *   ~27% of observed launches while appearing internally consistent.
 *
 * LAUNCH IDS ARE FACTORY-SCOPED, NOT GLOBALLY UNIQUE:
 *
 *   Every factory observed numbers its launches from 0 independently, so ids
 *   collide directly across generations. Key records on
 *   `${generation}:${launchId}` or on the token address, never on launchId
 *   alone. A full-history scan found each generation's id range to be dense
 *   (retired 0..14662, legacy 0..41857, current 0..20644) with no gaps and no
 *   duplicates, which is also how completeness is demonstrated: a missing launch
 *   would show up as a hole in the sequence.
 *
 * HOW TO CHECK WHETHER THIS FILE IS STALE:
 *
 *   1. Look for factories you DON'T have. The operator's (undocumented) config
 *      endpoint is the only published list of deployments we are aware of:
 *
 *        curl -s https://testnet.vibevibe.fun/api/v1/chains/46630/config \
 *          | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{ \
 *              const x=JSON.parse(d).data; \
 *              console.log('current :', x.deployments?.factory); \
 *              console.log('legacy  :', (x.legacyPublicGraphs||[]).map(g=>g.factory).join(', ')); \
 *              console.log('retired :', (x.retiredPublicGraphs||[]).map(g=>g.factory).join(', ')); \
 *            })"
 *
 *      Any factory it prints that is ABSENT from GENERATIONS below means this
 *      file is stale and you are under-counting.
 *
 *      *** THIS LIST IS ADDITIVE ONLY. NEVER REMOVE A FACTORY BECAUSE IT       ***
 *      *** DISAPPEARED FROM IT. Observed 2026-09-13: `retiredPublicGraphs`     ***
 *      *** went from one entry to ZERO entries, while that same factory        ***
 *      *** produced 10 launches in the following 30,000 blocks (most recent    ***
 *      *** at block 118,865,843). Delisting from the operator's API says       ***
 *      *** nothing about whether a factory is still producing launches.        ***
 *
 *   2. Verify liveness on-chain, not from any list. For each factory below,
 *      query `TokenLaunched` logs over a recent window. If it still emits, it is
 *      live regardless of what it is labelled or whether it is published.
 *
 *   3. Cross-check totals, and understand exactly what this can and cannot show.
 *      Sum `factory.launchCount()` across every entry below and compare against
 *      the launch count this indexer reports.
 *
 *        A MISMATCH means a scanning or indexing problem for a factory that is
 *        ALREADY CONFIGURED. The run summary prints a per-generation launchId
 *        audit to help localise it.
 *
 *        A MATCH PROVES NOTHING ABOUT UNKNOWN FACTORIES. An unconfigured factory
 *        contributes to neither side of the comparison: not to the sum, because
 *        it is not in this list, and not to the indexed total, because its logs
 *        are never scanned. The two sides agree precisely because both are blind
 *        to it.
 *
 *      Factory discovery therefore cannot come from this check. It requires an
 *      external observation: the operator's published list (step 1), bytecode
 *      matching against new deployments, or manual inspection of curve-shaped
 *      activity from unrecognised contracts (see `foreignActivity` in
 *      output/factories.json).
 *
 * All values below: TESTNET, chain 46630. Verified on-chain 2026-09-13.
 */

export type Generation = "retired" | "legacy" | "current";

/**
 * Economic policy for a generation.
 *
 * `null` means NOT VERIFIED. It is not a default and must not be treated as
 * one. Code that needs a policy for an unverified field must fail rather than
 * substitute a value from another generation. See `resolveFeePolicy()` below.
 */
export interface FeePolicy {
  /** Total trading fee in basis points, from `curve.TOTAL_FEE_BPS()`. */
  totalFeeBps: bigint | null;
  /** Creator's share of that fee in bps. Remainder goes to the protocol. */
  creatorShareOfFeeBps: bigint | null;
  /** `curve.NET_GRADUATION_TARGET()`, in wei of the quote asset. */
  netGraduationTargetWei: bigint | null;
  /** `curve.INITIAL_VIRTUAL_ETH_RESERVE()`. */
  initialVirtualEthReserveWei: bigint | null;
  /** Whether curves of this generation expose `quoteCurrency()`. */
  hasQuoteCurrencySupport: boolean | null;
  /** How each field above was established. */
  evidence: string;
}

export interface FactoryGeneration {
  generation: Generation;
  label: string;
  factory: Address;
  /** Block of the factory's creation transaction. Event scans start here. */
  deploymentBlock: number;
  graduationAdapter: Address | null;
  feeHook: Address | null;
  liquidityLocker: Address | null;
  protocolTreasury: Address | null;
  /**
   * Whether this factory was still emitting TokenLaunched at the last check.
   *
   * DO NOT infer this from the operator's label or from their published list.
   * A factory that was filed under `retiredPublicGraphs`, and was later dropped
   * from that response entirely, was still producing launches when checked
   * on-chain. Liveness is an on-chain observation, not a label.
   */
  observedStillProducingLaunches: boolean;
  /** Highest block at which a launch from this factory was observed. */
  /**
   * The most recent block at which this factory was SEEN emitting TokenLaunched,
   * as of VERIFIED_AT.date. It is a point-in-time observation, not a final
   * block: the factory may well have produced launches since, and a value older
   * than the others does not mean a factory went quiet. Re-check on-chain rather
   * than reading anything into the gaps between these numbers.
   */
  lastObservedLaunchBlock: number | null;
  /** Observed launchId range. Every factory numbers from 0 independently. */
  observedLaunchIdRange: { min: number; max: number } | null;
  economics: FeePolicy;
  notes: string;
  verificationSource: string;
}

export const VERIFIED_AT = {
  date: "2026-09-13",
  chainId: 46630,
  headBlock: 118_831_657,
  method:
    "eth_getCode + eth_call against the public testnet RPC; deployment blocks from the creation transaction receipt via Blockscout; economics measured across 92,404 non-dust indexed trades.",
};

export const GENERATIONS: FactoryGeneration[] = [
  {
    generation: "retired",
    label: "gen1",
    factory: "0x4FEbC267e0C24440bcDEF72B5DBC5FE7BED091dF",
    deploymentBlock: 95_916_239,
    graduationAdapter: "0x1fD0f2BD38ADa69e2eF138FAf5377c5a5A574e8f",
    feeHook: "0x30534B7601878E2043335c4BF99B4c50A75B90cc",
    liquidityLocker: "0xB0079D46C8FE759Ef02453041A077BF445aeb4c4",
    protocolTreasury: "0x3b13605865D7164d1dfe2080E22910df3a701899",
    observedStillProducingLaunches: true,
    lastObservedLaunchBlock: 118_865_843,
    observedLaunchIdRange: { min: 0, max: 14_662 },
    economics: {
      totalFeeBps: 100n,
      creatorShareOfFeeBps: 5_000n,
      netGraduationTargetWei: 5_000_000_000_000_000n, // 0.005 ETH
      initialVirtualEthReserveWei: 1_764_594_628_672_298n,
      hasQuoteCurrencySupport: false,
      evidence:
        "VERIFIED ONCHAIN: direct TOTAL_FEE_BPS() reads on 6 curves returned 100; 126/126 indexed non-dust trades matched 100 bps at a 5000 bps creator share, within 2 wei. NET_GRADUATION_TARGET() read 5e15. quoteCurrency() reverts (function absent).",
    },
    notes:
      "STILL PRODUCING LAUNCHES despite being delisted by the operator. It was filed under `retiredPublicGraphs` when first discovered; by 2026-09-13 that array had been emptied entirely, yet the factory produced 10 launches in the following 30,000 blocks (most recent observed at block 118,865,843). It also runs materially different economics from the newer generations: 100 bps at a 50/50 split, and a graduation target 1000x smaller. Its most recent launches were not served by the operator's public API during testing. This entry is the clearest reason the address book here is maintained by on-chain observation rather than by mirroring the operator's published list.",
    verificationSource:
      "Originally operator config API `retiredPublicGraphs[0]` (since removed from that response). Addresses, economics and continued liveness independently confirmed on-chain.",
  },
  {
    generation: "legacy",
    label: "gen2",
    factory: "0xB5B7A2f6c4EAFa2D73918fcA32d50e2126339eb9",
    deploymentBlock: 108_435_450,
    graduationAdapter: "0x1eD9E88AE14713ca4bc964BADe2Bc1e3f5CD501a",
    feeHook: "0xC5b22F31f247A6Ee33592792d44BdE31C0ef10cc",
    liquidityLocker: "0x0d0c44BfEb2a60F9b81C221C4cD24Ca89acBacEc",
    protocolTreasury: "0x29b1B6031df02D68332502FBD39Aee874dE24e03",
    observedStillProducingLaunches: true,
    lastObservedLaunchBlock: 118_829_603,
    observedLaunchIdRange: { min: 0, max: 41_857 },
    economics: {
      totalFeeBps: 125n,
      creatorShareOfFeeBps: 7_500n,
      netGraduationTargetWei: null,
      initialVirtualEthReserveWei: null,
      hasQuoteCurrencySupport: null,
      evidence:
        "VERIFIED ONCHAIN for fee and split: TOTAL_FEE_BPS() reads 125 on enriched gen2 curves and 28,805/28,805 indexed non-dust trades matched 125 bps at 7500 bps. Graduation target and virtual reserve NOT read for this generation; left null rather than assumed equal to gen3.",
    },
    notes:
      "Filed under `legacyPublicGraphs`. Largest generation by launch count. Fee economics match the current generation; graduation parameters were not independently verified.",
    verificationSource:
      "Operator config API `legacyPublicGraphs[0]`; fee economics independently confirmed on-chain.",
  },
  {
    generation: "current",
    label: "gen3",
    factory: "0x40f1be6faf8DAB9C143cce1a0A04c2075Fb2DF59",
    deploymentBlock: 115_025_604,
    graduationAdapter: "0xA6a5D4C098dA8f79eae1203A8E42ff9AC7a17F06",
    feeHook: "0x2779651feE12F6fB5A187578De6b63709f85d0Cc",
    liquidityLocker: "0xc0a2DEEbdc40b7083dC9a067F6992F884Fb6074D",
    protocolTreasury: "0x91719A47f855079678b3D5E3af69CDe2b830c5C9",
    observedStillProducingLaunches: true,
    lastObservedLaunchBlock: 118_831_636,
    observedLaunchIdRange: { min: 0, max: 20_644 },
    economics: {
      totalFeeBps: 125n,
      creatorShareOfFeeBps: 7_500n,
      netGraduationTargetWei: 5_000_000_000_000_000_000n, // 5 ETH
      initialVirtualEthReserveWei: 1_764_594_628_672_298_575n,
      hasQuoteCurrencySupport: true,
      evidence:
        "VERIFIED ONCHAIN: TOTAL_FEE_BPS() constant across 2,499 enriched curves; 63,473/63,473 indexed non-dust trades matched 125 bps at 7500 bps.",
    },
    notes:
      "The `deployments` block of the operator's config API: the generation their interface launches into today.",
    verificationSource:
      "Operator config API `deployments`; addresses and economics independently confirmed on-chain.",
  },
];

export const FACTORY_ADDRESSES = GENERATIONS.map((g) => g.factory);

export const EARLIEST_DEPLOYMENT_BLOCK = Math.min(
  ...GENERATIONS.map((g) => g.deploymentBlock)
);

/** Lowercased factory address -> generation record. */
export const FACTORY_BY_ADDRESS = new Map<string, FactoryGeneration>(
  GENERATIONS.map((g) => [g.factory.toLowerCase(), g])
);

export function generationOf(factory: string): Generation | null {
  return FACTORY_BY_ADDRESS.get(factory.toLowerCase())?.generation ?? null;
}

/**
 * Thrown when the indexer is asked for the policy of a generation it has no
 * verified economics for.
 *
 * This is deliberate. A future generation might use different economics again,
 * and quietly applying the current generation's numbers to it would produce
 * confident, wrong output. Failing loudly is the safe behaviour.
 *
 * SCOPE: this only fires for a generation that reached the indexer at all, which
 * in practice means one listed in GENERATIONS below. A factory that is NOT in
 * this file is never scanned, so it never reaches this code path and is missed
 * in silence. This error is not, and cannot be, a factory-discovery mechanism.
 */
export class UnsupportedGenerationError extends Error {
  constructor(readonly factoryOrGeneration: string) {
    super(
      `Unsupported factory/generation "${factoryOrGeneration}". This indexer has no verified ` +
        `economic policy for it, and will NOT assume one from another generation. ` +
        `Add a verified entry to config/factories.ts before indexing it. ` +
        `See docs/fee-models.md.`
    );
    this.name = "UnsupportedGenerationError";
  }
}

/**
 * Resolve the fee policy for a generation.
 *
 * Returns null ONLY for a known generation whose policy field is genuinely
 * unverified. Throws for an unknown generation, and never substitutes a default.
 */
export function resolveFeePolicy(generation: string | null): FeePolicy {
  if (!generation) throw new UnsupportedGenerationError("(null)");
  const g = GENERATIONS.find((x) => x.generation === generation);
  if (!g) throw new UnsupportedGenerationError(generation);
  return g.economics;
}

/** True only if we have a verified fee rate AND split for this generation. */
export function hasVerifiedFeePolicy(generation: string | null): boolean {
  if (!generation) return false;
  const g = GENERATIONS.find((x) => x.generation === generation);
  return !!g && g.economics.totalFeeBps !== null && g.economics.creatorShareOfFeeBps !== null;
}

/**
 * Shared infrastructure, generation-independent.
 *
 * QuoteRegistry note: this address appears in NO published list. It was found
 * by calling `factory.quoteRegistry()`. It gates the "stock pair" feature.
 */
export const SHARED = {
  quoteRegistry: "0x34f872e087A50d864957ae2a1D46808fD7a46b49" as Address,
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address,
  universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904" as Address,
  v4Quoter: "0x498928d32bf7649587C4C2D2944038500644c950" as Address,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
  burnAddress: "0x000000000000000000000000000000000000dEaD" as Address,
  zeroAddress: "0x0000000000000000000000000000000000000000" as Address,
};

export const ASSETS = {
  /** Protocol-level buyback-and-burn target. */
  tSFUND: {
    address: "0x728E721256D0708D23b00afCD32c096979259b16" as Address,
    symbol: "tSFUND",
  },
  /**
   * The only quote asset observed as registered at the time of verification.
   *
   * NOT A ROBINHOOD STOCK TOKEN. Its on-chain `name()` is
   * "Seedify Mock Stock SPCX". It is an EIP-1967 beacon proxy. No real
   * Robinhood-issued stock token exists on this testnet.
   */
  mockStockSPCX: {
    address: "0x5a5398155d98374c0e26265ea3cb9818169c2739" as Address,
    symbol: "SPCX",
    onChainName: "Seedify Mock Stock SPCX",
    isMockStock: true,
    isRealRobinhoodStockToken: false,
  },
};

/**
 * Protocol constants that are generation-independent as far as we verified.
 * Fee-related values deliberately live in `FeePolicy` per generation instead.
 */
/**
 * Buyback keeper EOAs. Buyback execution is NOT permissionless: these are
 * operator-controlled hot keys. Recorded so consumers can attribute buyback
 * transactions and monitor keeper liveness.
 */
export const KEEPERS = {
  protocolBuyback: "0xC9975c306b0bB34a2732a7b96FED54fe8e0e7D29" as Address,
  launchBuyback: "0x4b21a185Fdd3ff71c6C0f0b1e8dc068c48407ad4" as Address,
  note: "Operator-controlled EOAs. If these stop, buybacks stop; trading continues.",
};

export const PROTOCOL_CONSTANTS = {
  bpsDenominator: 10_000n,
  totalSupplyBaseUnits: 1_000_000_000_000_000_000_000_000_000n,
  curveAllocationBaseUnits: 793_100_000_000_000_000_000_000_000n,
  lpAllocationBaseUnits: 206_900_000_000_000_000_000_000_000n,
  launchFeeWei: 500_000_000_000_000n,
  curveWalletCapBps: 200n,
  creatorInitialBuyCapBps: 300n,
  /**
   * Second-level fee splits. OPERATOR-STATED, from their config API.
   * NOT independently verified on-chain and NOT used in any calculation here.
   */
  operatorStatedSecondLevelSplits: {
    creatorPayoutShareOfCreatorFeesBps: 5_000n,
    launchTokenBuybackShareOfCreatorFeesBps: 5_000n,
    treasuryShareOfProtocolFeesBps: 5_000n,
    sfundBuybackShareOfProtocolFeesBps: 5_000n,
    evidence: "OPERATOR-STATED (config API). Not verified on-chain.",
  },
};
