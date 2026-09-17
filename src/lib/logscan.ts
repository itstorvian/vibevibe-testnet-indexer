import type { AbiEvent, Address, Hex } from "viem";
import { client, withRetry, isRangeError, stats } from "./rpc.js";
import { config } from "../../config/network.js";
import { readChunk, writeChunk, writeCheckpoint, fmt } from "./cache.js";

export interface ScanOptions {
  /** Cache namespace. Include anything that changes the result set. */
  scan: string;
  fromBlock: number;
  toBlock: number;
  /** Omit to query by topic across ALL addresses (works on this RPC). */
  address?: Address | Address[];
  events: readonly AbiEvent[];
  /** Blocks within `toBlock - reorgSafety` are cached; the tip is not. */
  reorgSafety?: number;
  onProgress?: (done: number, total: number, rows: number) => void;
}

export interface RawLog {
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
  address: Address;
  eventName: string;
  args: Record<string, unknown>;
}

/**
 * Chunked, cached, adaptive eth_getLogs.
 *
 * Measured limits on the public RPC (2026-09-13): a 100k-block span succeeds;
 * 1M times out with "log query timed out". We start at config.logChunkBlocks
 * and halve on any range error, down to minLogChunkBlocks, then give up on that
 * chunk rather than spinning.
 *
 * Chunks below the reorg-safety line are cached on disk and replayed on
 * subsequent runs, which is what keeps repeated runs off the public endpoint.
 */
export async function scanLogs(opts: ScanOptions): Promise<RawLog[]> {
  const { scan, fromBlock, toBlock, address, events } = opts;
  const reorgSafety = opts.reorgSafety ?? 32;
  const safeTip = toBlock - reorgSafety;
  const c = client();

  const out: RawLog[] = [];
  let cursor = fromBlock;
  let chunkSize = config.logChunkBlocks;
  const totalBlocks = Math.max(1, toBlock - fromBlock + 1);
  let cacheHits = 0;
  let networkChunks = 0;
  // After a shrink, creep back up on sustained success. Log density varies
  // enormously across this chain's history: quiet early regions tolerate 50k
  // spans, busy recent ones hit the 10k-result cap inside 30k blocks.
  let consecutiveOk = 0;
  const RE_GROW_AFTER = 8;

  while (cursor <= toBlock) {
    const end = Math.min(cursor + chunkSize - 1, toBlock);
    const cacheable = end <= safeTip;

    if (cacheable) {
      const hit = readChunk<RawLog>(scan, cursor, end);
      if (hit) {
        out.push(...hit);
        cacheHits++;
        cursor = end + 1;
        opts.onProgress?.(cursor - fromBlock, totalBlocks, out.length);
        continue;
      }
    }

    let rows: RawLog[] | null = null;
    try {
      const logs = await withRetry(
        () =>
          c.getLogs({
            ...(address ? { address: address as Address } : {}),
            events: events as AbiEvent[],
            fromBlock: BigInt(cursor),
            toBlock: BigInt(end),
          }),
        `getLogs ${scan} ${cursor}-${end}`,
        { onRangeError: () => {} }
      );

      rows = (logs as unknown[]).map((l) => {
        const log = l as {
          blockNumber: bigint;
          blockHash: Hex;
          transactionHash: Hex;
          logIndex: number;
          address: Address;
          eventName: string;
          args: Record<string, unknown>;
        };
        return {
          blockNumber: Number(log.blockNumber),
          blockHash: log.blockHash,
          transactionHash: log.transactionHash,
          logIndex: Number(log.logIndex),
          address: log.address.toLowerCase() as Address,
          eventName: log.eventName,
          args: log.args ?? {},
        };
      });
      networkChunks++;
    } catch (err) {
      if (isRangeError(err) && chunkSize > config.minLogChunkBlocks) {
        chunkSize = Math.max(config.minLogChunkBlocks, Math.floor(chunkSize / 2));
        consecutiveOk = 0;
        stats.chunkSplits++;
        console.warn(
          `  ~ ${scan}: query too large (${String((err as Error).message).match(/exceeds limit of \d+|timed out/)?.[0] ?? "range"})` +
            `, shrinking chunk to ${chunkSize} blocks`
        );
        continue; // retry the same cursor with a smaller window
      }
      throw err;
    }

    if (++consecutiveOk >= RE_GROW_AFTER && chunkSize < config.logChunkBlocks) {
      chunkSize = Math.min(config.logChunkBlocks, Math.floor(chunkSize * 1.5));
      consecutiveOk = 0;
    }

    if (cacheable) writeChunk(scan, cursor, end, rows);
    out.push(...rows);
    cursor = end + 1;

    writeCheckpoint({
      scan,
      fromBlock,
      lastCompletedBlock: end,
      updatedAt: "",
      rowCount: out.length,
    });

    opts.onProgress?.(cursor - fromBlock, totalBlocks, out.length);
  }

  console.log(
    `  = ${scan}: ${fmt(out.length)} logs over ${fmt(totalBlocks)} blocks ` +
      `(${cacheHits} cached chunks, ${networkChunks} fetched)`
  );
  return out;
}

/** Stable ordering: chain order, then log order within a block. */
export function sortLogs<T extends { blockNumber: number; logIndex: number }>(rows: T[]): T[] {
  return rows.sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber - b.blockNumber
  );
}
