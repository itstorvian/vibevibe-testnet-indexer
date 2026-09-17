import type { Address, Hex } from "viem";
import type { LaunchRecord } from "../stages/launches.js";
import type { TradeRecord, LifecycleEvent, TradeScanResult } from "../stages/trades.js";
import type { TokenState, CurveState } from "../stages/headstate.js";
import {
  fromEvent, fromRead, derived, fromConfig, unavailable, partial,
  type Provenance,
} from "../lib/provenance.js";
import { ASSETS, SHARED, FACTORY_BY_ADDRESS, resolveFeePolicy } from "../../config/factories.js";

/**
 * DERIVED PROJECT RECORDS
 *
 * Raw chain data lives in data/raw/. This module is the only place where facts
 * are combined, and every field it emits carries its provenance so a reader can
 * tell a decoded event from a head-only read from an arithmetic derivation.
 */

export type Lifecycle =
  | "CURVE_TRADING"
  | "CURVE_COMPLETE_AWAITING_GRADUATION"
  | "GRADUATED"
  | "UNKNOWN";

export interface ProjectRecord {
  key: string;
  identity: {
    launchId: Provenance<string>;
    generation: Provenance<string>;
    factory: Provenance<Address>;
    factoryVersionNote: Provenance<string>;
    token: Provenance<Address>;
    curve: Provenance<Address>;
    creator: Provenance<Address>;
    creatorFeeRecipient: Provenance<Address>;
    creatorVault: Provenance<Address>;
    name: Provenance<string>;
    symbol: Provenance<string>;
    decimals: Provenance<number>;
    metadataURI: Provenance<string>;
    metadataDigest: Provenance<Hex>;
  };
  timing: {
    deploymentBlock: Provenance<number>;
    deploymentTxHash: Provenance<Hex>;
    launchTimestamp: Provenance<string>;
  };
  lifecycle: {
    state: Provenance<Lifecycle>;
    transfersUnlocked: Provenance<boolean>;
    curveCompletedBlock: Provenance<number>;
    graduated: Provenance<boolean>;
    graduationTxHash: Provenance<Hex>;
    graduationBlock: Provenance<number>;
    poolId: Provenance<Hex>;
    poolManager: Provenance<Address>;
  };
  market: {
    quoteAsset: Provenance<Address>;
    quoteAssetSymbol: Provenance<string>;
    isQuotedLaunch: Provenance<boolean>;
    quoteAssetIsMockStock: Provenance<boolean>;
    quoteAssetIsRealRobinhoodStockToken: Provenance<boolean>;
  };
  activity: {
    totalTrades: Provenance<number>;
    buyCount: Provenance<number>;
    sellCount: Provenance<number>;
    buyVolumeWei: Provenance<string>;
    sellVolumeWei: Provenance<string>;
    totalVolumeWei: Provenance<string>;
    uniqueTraders: Provenance<number>;
  };
  fees: {
    totalFeesWei: Provenance<string>;
    creatorFeesWei: Provenance<string>;
    protocolFeesWei: Provenance<string>;
    observedFeeBps: Provenance<number>;
    observedCreatorShareBps: Provenance<number>;
    creatorFeesAccruedOnCurve: Provenance<string>;
    protocolFeesAccruedOnCurve: Provenance<string>;
    creatorFeesForwardedWei: Provenance<string>;
  };
  buybackBurn: {
    burnedToDeadAddressWei: Provenance<string>;
    heldForBurnInVaultWei: Provenance<string>;
    totalSupplyCommittedToBurnWei: Provenance<string>;
    burnEventCount: Provenance<number>;
  };
  treasuries: {
    projectTreasury: Provenance<Address>;
    protocolTreasury: Provenance<Address>;
  };
  provenanceSummary: {
    onchainEventFields: number;
    contractReadFields: number;
    derivedFields: number;
    unavailableFields: number;
  };
}

export interface DeriveInput {
  launches: LaunchRecord[];
  tradeScan: TradeScanResult;
  tokenStates: Map<string, TokenState>;
  curveStates: Map<string, CurveState>;
  vaultHoldings: Map<string, { held: bigint; vault: Address }>;
  burnedByToken: Map<string, bigint>;
  burnCountByToken: Map<string, number>;
  burnScanFrom: number;
  burnScanTo: number;
  headBlock: number;
}

export function deriveProjects(input: DeriveInput): ProjectRecord[] {
  const {
    launches, tradeScan, tokenStates, curveStates, vaultHoldings,
    burnedByToken, burnCountByToken, headBlock,
  } = input;

  // Bucket trades and lifecycle events by curve, once.
  const tradesByCurve = new Map<string, TradeRecord[]>();
  for (const t of tradeScan.trades) {
    const arr = tradesByCurve.get(t.curve) ?? [];
    arr.push(t);
    tradesByCurve.set(t.curve, arr);
  }
  const lifecycleByCurve = new Map<string, LifecycleEvent[]>();
  for (const e of tradeScan.lifecycle) {
    const arr = lifecycleByCurve.get(e.curve) ?? [];
    arr.push(e);
    lifecycleByCurve.set(e.curve, arr);
  }

  const windowNote = tradeScan.isFullHistory
    ? undefined
    : `bounded scan: blocks ${tradeScan.fromBlock}..${tradeScan.toBlock} only, not full history`;

  return launches.map((l) => {
    const gen = FACTORY_BY_ADDRESS.get(l.factory.toLowerCase());
    // Generation-aware: NEVER assume one platform-wide fee policy. Throws
    // UnsupportedGenerationError if a factory appears that config/factories.ts
    // has no verified policy for. Deliberately loud rather than defaulting.
    const expectedPolicy = resolveFeePolicy(l.generation);
    const ts = tokenStates.get(l.token);
    const cs = curveStates.get(l.curve);
    const trades = tradesByCurve.get(l.curve) ?? [];
    const events = lifecycleByCurve.get(l.curve) ?? [];

    // ---- activity ------------------------------------------------------
    const buys = trades.filter((t) => t.side === "buy");
    const sells = trades.filter((t) => t.side === "sell");
    const buyVol = buys.reduce((a, t) => a + BigInt(t.grossWei), 0n);
    const sellVol = sells.reduce((a, t) => a + BigInt(t.grossWei), 0n);
    const traders = new Set(trades.map((t) => t.trader));

    // ---- fees ----------------------------------------------------------
    const creatorFees = trades.reduce((a, t) => a + BigInt(t.creatorFeeWei), 0n);
    const protocolFees = trades.reduce((a, t) => a + BigInt(t.protocolFeeWei), 0n);
    const totalFees = creatorFees + protocolFees;
    const grossAll = buyVol + sellVol;
    const observedFeeBps =
      grossAll > 0n ? Number((totalFees * 10_000n * 100n) / grossAll) / 100 : null;
    const observedCreatorShareBps =
      totalFees > 0n ? Number((creatorFees * 10_000n) / totalFees) : null;

    // ---- lifecycle -----------------------------------------------------
    const gradEvent = events.find((e) => e.kind === "Graduated");
    const completeEvent = events.find((e) => e.kind === "CurveCompleted");
    const forwarded = events
      .filter((e) => e.kind === "CreatorFeesForwarded")
      .reduce((a, e) => a + BigInt(e.amount ?? "0"), 0n);

    let lifecycleState: Lifecycle = "UNKNOWN";
    let lifecycleProv: Provenance<Lifecycle>;
    if (cs?.graduated === true) {
      lifecycleState = "GRADUATED";
      lifecycleProv = fromRead(lifecycleState, `head-only read @ block ${headBlock}`);
    } else if (gradEvent) {
      lifecycleState = "GRADUATED";
      lifecycleProv = fromEvent(lifecycleState);
    } else if (cs?.complete === true) {
      lifecycleState = "CURVE_COMPLETE_AWAITING_GRADUATION";
      lifecycleProv = fromRead(lifecycleState, `head-only read @ block ${headBlock}`);
    } else if (completeEvent) {
      lifecycleState = "CURVE_COMPLETE_AWAITING_GRADUATION";
      lifecycleProv = fromEvent(lifecycleState);
    } else if (cs?.complete === false) {
      lifecycleState = "CURVE_TRADING";
      lifecycleProv = fromRead(lifecycleState, `head-only read @ block ${headBlock}`);
    } else {
      lifecycleProv = unavailable<Lifecycle>(
        "no head-state read for this curve (outside --enrich-limit) and no lifecycle event in the scanned window"
      );
    }

    // ---- buyback / burn ------------------------------------------------
    // The subtlety: pre-graduation, bought-back tokens cannot reach 0x...dEaD
    // because transfers are locked. They sit in the CreatorVault. Correct
    // supply-impact accounting sums both legs.
    const burnedFromEvents = burnedByToken.get(l.token) ?? null;
    const burnedFromRead = ts?.burnedAtDeadAddress ? BigInt(ts.burnedAtDeadAddress) : null;
    const vault = vaultHoldings.get(l.token);
    const held = vault?.held ?? null;

    // Prefer the head read (complete by construction) over the windowed event
    // sum (only complete when the burn scan covered full history).
    const burnedAuthoritative = burnedFromRead ?? burnedFromEvents;
    const burnedProv: Provenance<string> =
      burnedFromRead !== null
        ? fromRead(burnedFromRead.toString(), `balanceOf(0x...dEaD) @ block ${headBlock}`)
        : burnedFromEvents !== null
        ? partial(
            burnedFromEvents.toString(),
            `summed from Transfer->dEaD logs over blocks ${input.burnScanFrom}..${input.burnScanTo}`
          )
        : unavailable<string>("no head read and no burn events in the scanned window");

    const committed =
      burnedAuthoritative !== null && held !== null ? burnedAuthoritative + held : null;

    // ---- quote asset ---------------------------------------------------
    const quote = l.quoteCurrency ?? cs?.quoteCurrency ?? null;
    const isEthQuoted = !quote || quote === SHARED.zeroAddress;
    const isMock = !!quote && quote.toLowerCase() === ASSETS.mockStockSPCX.address.toLowerCase();

    // ---- assemble ------------------------------------------------------
    const rec: ProjectRecord = {
      key: l.key,
      identity: {
        launchId: fromEvent(l.launchId, "per-factory counter; NOT globally unique"),
        generation: fromConfig(l.generation),
        factory: fromEvent(l.factory),
        factoryVersionNote: fromConfig(gen?.notes ?? "unknown generation"),
        token: fromEvent(l.token),
        curve: fromEvent(l.curve),
        creator: fromEvent(l.creator),
        creatorFeeRecipient: fromEvent(l.creatorFeeRecipient),
        creatorVault: fromEvent(l.creatorVault),
        name: ts?.name
          ? fromRead(ts.name, `head-only read @ block ${headBlock}`)
          : unavailable<string>(
              ts
                ? "token name() read returned nothing"
                : "outside --enrich-limit; name/symbol live only in contract state, not in any event"
            ),
        symbol: ts?.symbol
          ? fromRead(ts.symbol, `head-only read @ block ${headBlock}`)
          : unavailable<string>(
              ts ? "token symbol() read returned nothing" : "outside --enrich-limit"
            ),
        decimals:
          ts?.decimals !== null && ts?.decimals !== undefined
            ? fromRead(ts.decimals)
            : unavailable<number>("outside --enrich-limit"),
        metadataURI: l.metadataURI
          ? fromEvent(l.metadataURI, "IPFS URI; content not fetched by this indexer")
          : unavailable<string>("empty metadataURI in the launch event"),
        metadataDigest: fromEvent(l.metadataDigest, "on-chain commitment to the IPFS content"),
      },
      timing: {
        deploymentBlock: fromEvent(l.deploymentBlock),
        deploymentTxHash: fromEvent(l.deploymentTxHash),
        launchTimestamp: cs?.launchTimestamp
          ? fromRead(cs.launchTimestamp, "unix seconds")
          : unavailable<string>(
              "curve.launchTimestamp() not read (outside --enrich-limit). Block timestamp would require an extra eth_getBlockByNumber per launch."
            ),
      },
      lifecycle: {
        state: lifecycleProv,
        transfersUnlocked:
          ts?.transfersUnlocked !== null && ts?.transfersUnlocked !== undefined
            ? fromRead(ts.transfersUnlocked, `head-only @ block ${headBlock}`)
            : unavailable<boolean>("outside --enrich-limit"),
        curveCompletedBlock: completeEvent
          ? fromEvent(completeEvent.blockNumber)
          : unavailable<number>(
              windowNote ?? "no CurveCompleted event found; curve has not completed"
            ),
        graduated:
          cs?.graduated !== null && cs?.graduated !== undefined
            ? fromRead(cs.graduated)
            : gradEvent
            ? fromEvent(true)
            : unavailable<boolean>(windowNote ?? "no graduation evidence"),
        graduationTxHash: gradEvent
          ? fromEvent(gradEvent.txHash)
          : unavailable<Hex>(
              windowNote ??
                "no Graduated event in scanned range; if the project graduated earlier, widen --trade-from"
            ),
        graduationBlock: gradEvent
          ? fromEvent(gradEvent.blockNumber)
          : unavailable<number>(windowNote ?? "no Graduated event in scanned range"),
        poolId: gradEvent?.poolId
          ? fromEvent(gradEvent.poolId)
          : cs?.graduatedPoolId && cs.graduatedPoolId !== ("0x" + "0".repeat(64))
          ? fromRead(cs.graduatedPoolId)
          : unavailable<Hex>("not graduated, or no graduation evidence in scanned range"),
        poolManager: fromConfig(SHARED.poolManager, "Uniswap v4 PoolManager (verified source)"),
      },
      market: {
        quoteAsset: isEthQuoted
          ? fromEvent(SHARED.zeroAddress as Address, "native ETH-quoted launch")
          : fromEvent(quote as Address),
        quoteAssetSymbol: isEthQuoted
          ? fromConfig("ETH")
          : isMock
          ? fromConfig(ASSETS.mockStockSPCX.symbol)
          : unavailable<string>("unrecognised quote asset; symbol not read"),
        isQuotedLaunch: fromEvent(l.isQuotedLaunch),
        quoteAssetIsMockStock: fromConfig(
          isMock,
          isMock
            ? "Seedify Mock Stock SPCX, deployed and owned by the operator Safe"
            : "not a stock-quoted launch"
        ),
        quoteAssetIsRealRobinhoodStockToken: fromConfig(
          false,
          "No real Robinhood Stock Token exists on testnet 46630. All 194 RHJ assets are mainnet-4663-only."
        ),
      },
      activity: {
        totalTrades: windowNote
          ? partial(trades.length, windowNote)
          : fromEvent(trades.length),
        buyCount: windowNote ? partial(buys.length, windowNote) : fromEvent(buys.length),
        sellCount: windowNote ? partial(sells.length, windowNote) : fromEvent(sells.length),
        buyVolumeWei: windowNote
          ? partial(buyVol.toString(), windowNote)
          : derived(buyVol.toString(), "high", "sum of Bought.grossEthUsed"),
        sellVolumeWei: windowNote
          ? partial(sellVol.toString(), windowNote)
          : derived(sellVol.toString(), "high", "sum of Sold.grossCurveQuote"),
        totalVolumeWei: windowNote
          ? partial((buyVol + sellVol).toString(), windowNote)
          : derived((buyVol + sellVol).toString()),
        uniqueTraders: windowNote
          ? partial(traders.size, `${windowNote}; distinct msg.sender only, not beneficial owners`)
          : derived(traders.size, "medium", "distinct msg.sender; one person may use many wallets"),
      },
      fees: {
        totalFeesWei: windowNote
          ? partial(totalFees.toString(), windowNote)
          : derived(totalFees.toString(), "high", "sum of creatorFee+protocolFee from trade events"),
        creatorFeesWei: windowNote
          ? partial(creatorFees.toString(), windowNote)
          : derived(creatorFees.toString()),
        protocolFeesWei: windowNote
          ? partial(protocolFees.toString(), windowNote)
          : derived(protocolFees.toString()),
        observedFeeBps:
          observedFeeBps === null
            ? unavailable<number>("no trades observed in the scanned range")
            : derived(observedFeeBps, "high", `expected ${expectedPolicy.totalFeeBps ?? "UNVERIFIED"} bps for generation "${l.generation}"`),
        observedCreatorShareBps:
          observedCreatorShareBps === null
            ? unavailable<number>("no fees observed in the scanned range")
            : derived(observedCreatorShareBps, "high", `expected ${expectedPolicy.creatorShareOfFeeBps ?? "UNVERIFIED"} bps for generation "${l.generation}"`),
        creatorFeesAccruedOnCurve: cs?.creatorFeesAccrued
          ? fromRead(cs.creatorFeesAccrued, `unclaimed balance @ block ${headBlock}`)
          : unavailable<string>("outside --enrich-limit"),
        protocolFeesAccruedOnCurve: cs?.protocolFeesAccrued
          ? fromRead(cs.protocolFeesAccrued, `unclaimed balance @ block ${headBlock}`)
          : unavailable<string>("outside --enrich-limit"),
        creatorFeesForwardedWei: events.some((e) => e.kind === "CreatorFeesForwarded")
          ? fromEvent(forwarded.toString())
          : unavailable<string>(windowNote ?? "no CreatorFeesForwarded event in scanned range"),
      },
      buybackBurn: {
        burnedToDeadAddressWei: burnedProv,
        heldForBurnInVaultWei:
          held !== null
            ? fromRead(
                held.toString(),
                `CreatorVault token balance @ block ${headBlock}. Pre-graduation buybacks are held here because transfersUnlocked()==false blocks a transfer to the burn address.`
              )
            : unavailable<string>("vault balance not read (outside --enrich-limit)"),
        totalSupplyCommittedToBurnWei:
          committed !== null
            ? derived(
                committed.toString(),
                // "medium", not "high". The ARITHMETIC is exact; the ATTRIBUTION
                // is an assumption. See the note: nothing observed in this
                // research rules out an unrelated inbound transfer to the vault,
                // and after graduation transfersUnlocked()==true, so any holder
                // can send the launch token to any address, the vault included.
                "medium",
                "burned(at 0x...dEaD) + heldForBurn(in vault). Counting only the burn address under-reports pre-graduation tokens. ASSUMPTION: the entire vault token balance is treated as buyback-origin. That was consistent with every token inspected, but it was not proven: no mechanism was identified that prevents an unrelated transfer into the vault, and after graduation transfers are unlocked for everyone. Treat this as an upper bound on supply committed to burn."
              )
            : unavailable<string>("needs both the burn read and the vault read"),
        burnEventCount: burnCountByToken.has(l.token)
          ? partial(
              burnCountByToken.get(l.token)!,
              `Transfer->dEaD logs over blocks ${input.burnScanFrom}..${input.burnScanTo}`
            )
          : unavailable<number>("no burn events for this token in the scanned window"),
      },
      treasuries: {
        projectTreasury: fromEvent(
          l.creatorVault,
          "the per-launch CreatorVault (EIP-1167 clone) is the project-side treasury: it receives the creator fee share and holds buyback tokens pre-graduation"
        ),
        protocolTreasury: gen?.protocolTreasury
          ? fromConfig(gen.protocolTreasury, `generation-specific (${l.generation})`)
          : unavailable<Address>("no protocol treasury recorded for this generation"),
      },
      provenanceSummary: { onchainEventFields: 0, contractReadFields: 0, derivedFields: 0, unavailableFields: 0 },
    };

    rec.provenanceSummary = summarise(rec);
    return rec;
  });
}

function summarise(rec: ProjectRecord) {
  let ev = 0, rd = 0, dv = 0, un = 0;
  const walk = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    if ("source" in (o as object) && "value" in (o as object)) {
      const s = (o as Provenance<unknown>).source;
      if (s === "onchain_event") ev++;
      else if (s === "contract_read") rd++;
      else if (s === "derived") dv++;
      else if (s === "unavailable") un++;
      return;
    }
    for (const v of Object.values(o as Record<string, unknown>)) walk(v);
  };
  for (const [k, v] of Object.entries(rec)) {
    if (k === "provenanceSummary" || k === "key") continue;
    walk(v);
  }
  return { onchainEventFields: ev, contractReadFields: rd, derivedFields: dv, unavailableFields: un };
}
