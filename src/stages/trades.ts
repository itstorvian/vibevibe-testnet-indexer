import type { Address, Hex } from "viem";
import { scanLogs, sortLogs } from "../lib/logscan.js";
import { CURVE_EVENTS } from "../../config/abis.js";
import { RAW_DIR, fmt, writeRaw } from "../lib/cache.js";
import path from "node:path";
import type { LaunchRecord } from "./launches.js";

/**
 * STAGE 2: TRADES, COMPLETIONS, GRADUATIONS
 *
 * Curve events are emitted by tens of thousands of per-launch curve contracts,
 * so filtering by address is impractical. This RPC accepts topic-only queries
 * across all addresses, which is what makes a complete trade index possible at
 * all.
 *
 * CORRECTNESS NOTE: a topic-only query returns logs from ANY contract whose
 * event happens to share topic0. On a public testnet full of user-deployed
 * copycats this is a real risk, not a theoretical one. Every log is therefore
 * checked against the set of curve addresses reconstructed in stage 1, and
 * non-matching logs are counted and reported rather than silently dropped.
 */

export interface TradeRecord {
  curve: Address;
  token: Address | null;
  side: "buy" | "sell";
  trader: Address;
  recipient: Address | null;
  /** ETH (or quote asset) in for a buy; gross curve quote for a sell. */
  grossWei: string;
  curveQuoteWei: string;
  /** ETH out, sells only. */
  ethReceivedWei: string | null;
  tokenAmount: string;
  creatorFeeWei: string;
  protocolFeeWei: string;
  totalFeeWei: string;
  blockNumber: number;
  txHash: Hex;
  logIndex: number;
}

export interface LifecycleEvent {
  curve: Address;
  token: Address | null;
  kind: "CurveCompleted" | "Graduated" | "CreatorFeesForwarded";
  blockNumber: number;
  txHash: Hex;
  logIndex: number;
  /** Graduated */
  poolId?: Hex;
  ethAmount?: string;
  tokenAmount?: string;
  /** CurveCompleted */
  netEthReserve?: string;
  timestamp?: string;
  /** CreatorFeesForwarded */
  vault?: Address;
  amount?: string;
}

export interface TradeScanResult {
  trades: TradeRecord[];
  lifecycle: LifecycleEvent[];
  fromBlock: number;
  toBlock: number;
  isFullHistory: boolean;
  foreignLogsIgnored: number;
  foreignAddressSample: string[];
}

export async function indexTrades(
  launches: LaunchRecord[],
  fromBlock: number,
  toBlock: number,
  isFullHistory: boolean
): Promise<TradeScanResult> {
  const curveToToken = new Map<string, Address>();
  for (const l of launches) curveToToken.set(l.curve.toLowerCase(), l.token);

  console.log(
    `\n[stage 2] trades: blocks ${fmt(fromBlock)}..${fmt(toBlock)} ` +
      `(${fmt(toBlock - fromBlock + 1)} blocks, ${isFullHistory ? "FULL HISTORY" : "WINDOW"})`
  );
  console.log(`  .. matching against ${fmt(curveToToken.size)} known curve addresses`);

  const logs = await scanLogs({
    scan: `trades-${fromBlock}-${toBlock}`,
    fromBlock,
    toBlock,
    // No address filter: topic-only across the whole chain.
    events: CURVE_EVENTS,
    onProgress: (done, total, rows) => {
      const pct = ((done / total) * 100).toFixed(1);
      if (Number(pct) % 5 < 0.3) {
        process.stdout.write(`\r  .. trades ${pct}%, ${rows} curve logs   `);
      }
    },
  });
  process.stdout.write("\n");

  const trades: TradeRecord[] = [];
  const lifecycle: LifecycleEvent[] = [];
  let foreign = 0;
  const foreignAddrs = new Set<string>();

  for (const log of sortLogs(logs)) {
    const curve = log.address.toLowerCase() as Address;
    const token = curveToToken.get(curve) ?? null;

    if (!token) {
      // Same topic0, different contract. Not a vibe/vibe curve.
      foreign++;
      if (foreignAddrs.size < 20) foreignAddrs.add(curve);
      continue;
    }

    const a = log.args as Record<string, unknown>;

    if (log.eventName === "Bought") {
      const creatorFee = BigInt(String(a.creatorFee ?? 0));
      const protocolFee = BigInt(String(a.protocolFee ?? 0));
      trades.push({
        curve,
        token,
        side: "buy",
        trader: String(a.buyer).toLowerCase() as Address,
        recipient: String(a.recipient).toLowerCase() as Address,
        grossWei: String(a.grossEthUsed ?? 0),
        curveQuoteWei: String(a.curveQuote ?? 0),
        ethReceivedWei: null,
        tokenAmount: String(a.tokenAmount ?? 0),
        creatorFeeWei: creatorFee.toString(),
        protocolFeeWei: protocolFee.toString(),
        totalFeeWei: (creatorFee + protocolFee).toString(),
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
      });
    } else if (log.eventName === "Sold") {
      const creatorFee = BigInt(String(a.creatorFee ?? 0));
      const protocolFee = BigInt(String(a.protocolFee ?? 0));
      trades.push({
        curve,
        token,
        side: "sell",
        trader: String(a.seller).toLowerCase() as Address,
        recipient: null,
        grossWei: String(a.grossCurveQuote ?? 0),
        curveQuoteWei: String(a.grossCurveQuote ?? 0),
        ethReceivedWei: String(a.ethReceived ?? 0),
        tokenAmount: String(a.tokenAmount ?? 0),
        creatorFeeWei: creatorFee.toString(),
        protocolFeeWei: protocolFee.toString(),
        totalFeeWei: (creatorFee + protocolFee).toString(),
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
      });
    } else if (log.eventName === "CurveCompleted") {
      lifecycle.push({
        curve,
        token,
        kind: "CurveCompleted",
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        netEthReserve: String(a.netEthReserve ?? 0),
        timestamp: String(a.timestamp ?? 0),
      });
    } else if (log.eventName === "Graduated") {
      lifecycle.push({
        curve,
        token,
        kind: "Graduated",
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        poolId: a.poolId as Hex,
        ethAmount: String(a.ethAmount ?? 0),
        tokenAmount: String(a.tokenAmount ?? 0),
      });
    } else if (log.eventName === "CreatorFeesForwarded") {
      lifecycle.push({
        curve,
        token,
        kind: "CreatorFeesForwarded",
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        vault: String(a.vault).toLowerCase() as Address,
        amount: String(a.amount ?? 0),
      });
    }
  }

  const buys = trades.filter((t) => t.side === "buy").length;
  console.log(
    `  = ${fmt(trades.length)} trades (${fmt(buys)} buys, ` +
      `${fmt(trades.length - buys)} sells), ${fmt(lifecycle.length)} lifecycle events`
  );
  if (foreign > 0) {
    console.log(
      `  ! ${fmt(foreign)} logs shared a curve topic0 but came from non-Vibe contracts, ignored`
    );
  }

  writeRaw(path.join(RAW_DIR, "trades.json"), trades, 0);
  writeRaw(path.join(RAW_DIR, "lifecycle.json"), lifecycle, 0);

  return {
    trades,
    lifecycle,
    fromBlock,
    toBlock,
    isFullHistory,
    foreignLogsIgnored: foreign,
    foreignAddressSample: [...foreignAddrs],
  };
}
