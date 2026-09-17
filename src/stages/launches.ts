import type { Address, Hex } from "viem";
import { scanLogs, sortLogs, type RawLog } from "../lib/logscan.js";
import { FACTORY_EVENTS } from "../../config/abis.js";
import {
  FACTORY_ADDRESSES,
  FACTORY_BY_ADDRESS,
  EARLIEST_DEPLOYMENT_BLOCK,
  type Generation,
} from "../../config/factories.js";
import { RAW_DIR, fmt, writeRaw } from "../lib/cache.js";
import path from "node:path";

/**
 * STAGE 1: LAUNCHES
 *
 * The headline test: can an outsider enumerate EVERY vibe/vibe launch without
 * the operator's backend?
 *
 * We scan all three factory generations in a single address-array query (the
 * public RPC supports address arrays), from the earliest factory deployment
 * block to head. Nothing here depends on the operator.
 */

export interface LaunchRecord {
  /** Composite key. launchId alone is NOT unique; counters restart per factory. */
  key: string;
  generation: Generation;
  factory: Address;
  launchId: string;
  token: Address;
  curve: Address;
  creator: Address;
  creatorFeeRecipient: Address;
  creatorVault: Address;
  /** Non-null only for TokenLaunchedQuoted, i.e. stock-paired launches. */
  quoteCurrency: Address | null;
  isQuotedLaunch: boolean;
  initialBuy: string;
  initialTokensBought: string;
  metadataSchemaVersion: number;
  metadataDigest: Hex;
  metadataURI: string;
  deploymentBlock: number;
  deploymentTxHash: Hex;
  logIndex: number;
}

export async function indexLaunches(head: number): Promise<LaunchRecord[]> {
  console.log(
    `\n[stage 1] launches: scanning ${FACTORY_ADDRESSES.length} factory generations ` +
      `from block ${fmt(EARLIEST_DEPLOYMENT_BLOCK)} to ${fmt(head)}`
  );

  const logs = await scanLogs({
    scan: "launches-all-generations",
    fromBlock: EARLIEST_DEPLOYMENT_BLOCK,
    toBlock: head,
    address: FACTORY_ADDRESSES as Address[],
    events: FACTORY_EVENTS,
    onProgress: (done, total, rows) => {
      const pct = ((done / total) * 100).toFixed(1);
      if (Number(pct) % 5 < 0.2) {
        process.stdout.write(`\r  .. launches ${pct}%, ${rows} launches found   `);
      }
    },
  });
  process.stdout.write("\n");

  const launches: LaunchRecord[] = [];
  const byGeneration: Record<string, number> = {};
  let feeClaims = 0;

  for (const log of sortLogs(logs)) {
    if (log.eventName === "LaunchFeesClaimed") {
      feeClaims++;
      continue;
    }
    if (log.eventName !== "TokenLaunched" && log.eventName !== "TokenLaunchedQuoted") continue;

    const gen = FACTORY_BY_ADDRESS.get(log.address.toLowerCase());
    if (!gen) {
      // Should be impossible given the address filter, but never silently drop.
      console.warn(`  ! launch from unknown factory ${log.address} at block ${log.blockNumber}`);
      continue;
    }

    const a = log.args as Record<string, unknown>;
    const quoted = log.eventName === "TokenLaunchedQuoted";

    launches.push({
      key: `${gen.generation}:${String(a.launchId)}`,
      generation: gen.generation,
      factory: gen.factory,
      launchId: String(a.launchId),
      token: String(a.token).toLowerCase() as Address,
      curve: String(a.curve).toLowerCase() as Address,
      creator: String(a.creator).toLowerCase() as Address,
      creatorFeeRecipient: String(a.creatorFeeRecipient).toLowerCase() as Address,
      creatorVault: String(a.creatorVault).toLowerCase() as Address,
      quoteCurrency: quoted ? (String(a.quoteCurrency).toLowerCase() as Address) : null,
      isQuotedLaunch: quoted,
      initialBuy: String(a.initialBuy ?? "0"),
      initialTokensBought: String(a.initialTokensBought ?? "0"),
      metadataSchemaVersion: Number(a.metadataSchemaVersion ?? 0),
      metadataDigest: a.metadataDigest as Hex,
      metadataURI: String(a.metadataURI ?? ""),
      deploymentBlock: log.blockNumber,
      deploymentTxHash: log.transactionHash,
      logIndex: log.logIndex,
    });

    byGeneration[gen.generation] = (byGeneration[gen.generation] ?? 0) + 1;
  }

  const quotedCount = launches.filter((l) => l.isQuotedLaunch).length;

  console.log(`  = ${fmt(launches.length)} launches reconstructed`);
  for (const [g, n] of Object.entries(byGeneration)) {
    console.log(`      ${g.padEnd(9)} ${fmt(n)}`);
  }
  console.log(`      quoted (stock-paired): ${quotedCount}`);
  console.log(`      LaunchFeesClaimed events seen: ${feeClaims}`);

  writeRaw(path.join(RAW_DIR, "launches.json"), launches, 0);
  return launches;
}

/** Sanity: launchIds should be dense and monotonic within each generation. */
export function auditLaunchIds(launches: LaunchRecord[]) {
  const byGen = new Map<Generation, bigint[]>();
  for (const l of launches) {
    const arr = byGen.get(l.generation) ?? [];
    arr.push(BigInt(l.launchId));
    byGen.set(l.generation, arr);
  }

  const report: Record<string, unknown> = {};
  for (const [gen, ids] of byGen) {
    ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const min = ids[0];
    const max = ids[ids.length - 1];
    const expected = max - min + 1n;
    const gaps: string[] = [];
    const seen = new Set(ids.map(String));
    // Only enumerate gaps when the range is small enough to be useful.
    if (expected <= 200_000n) {
      for (let i = min; i <= max; i++) {
        if (!seen.has(i.toString())) gaps.push(i.toString());
        if (gaps.length > 25) break;
      }
    }
    report[gen] = {
      count: ids.length,
      minLaunchId: min.toString(),
      maxLaunchId: max.toString(),
      expectedIfDense: expected.toString(),
      dense: BigInt(ids.length) === expected,
      duplicateIds: ids.length - seen.size,
      sampleMissingIds: gaps.slice(0, 25),
    };
  }
  return report;
}
