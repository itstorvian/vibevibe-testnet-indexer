import type { Address, Hex } from "viem";
import { client, withRetry, isRangeError } from "../lib/rpc.js";
import { sortLogs } from "../lib/logscan.js";
import { config } from "../../config/network.js";
import { SHARED } from "../../config/factories.js";
import { RAW_DIR, readChunk, writeChunk, fmt, writeRaw } from "../lib/cache.js";
import { sanitizeErrorMessage } from "../lib/redact.js";
import { parseAbiItem } from "viem";
import path from "node:path";
import type { LaunchRecord } from "./launches.js";

/**
 * STAGE 3: BUYBACKS, BURNS, AND THE VAULT-HELD SUBTLETY
 *
 * This is the stage that catches naive indexers out.
 *
 * There is NO protocol-level burn event. Burns are ordinary ERC-20
 * `Transfer(x, 0x...dEaD, amount)` logs, so you must watch tokens, not the
 * protocol.
 *
 * And the trap: while a launch is still on the curve, `transfersUnlocked()` is
 * false, so the keeper's bought-back tokens CANNOT be sent to the burn address,
 * because the transfer would revert with TransfersLocked(). They sit in the launch's
 * CreatorVault (an EIP-1167 clone) until graduation, and only then move to
 * 0x...dEaD.
 *
 * Counting only balanceOf(0x...dEaD) therefore under-reports supply reduction
 * for every pre-graduation token. Correct accounting is:
 *
 *     supplyRemovedOrCommitted = burned(at 0x...dEaD) + heldForBurn(in vault)
 *
 * Verified during due diligence, and note which direction the agreement runs:
 * for a token whose vault was EMPTY, balanceOf(0x...dEaD) matched the operator's
 * reported burn figure to the wei. Where the vault was non-empty, counting only
 * the dead address under-reported by exactly the vault balance.
 *
 * So the dead-address balance is NOT itself `burned + held`. It is the `burned`
 * leg alone, and it happens to equal the total only when `held` is zero.
 * `scripts/verify-burn-model.mjs` checks precisely this.
 */

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

/**
 * viem's multicall return type collapses to `never` when the contracts array is
 * built dynamically. We keep the runtime call and narrow the result ourselves.
 */
export type MulticallResult =
  | { status: "success"; result: unknown }
  | { status: "failure"; error: unknown };

export interface BurnRecord {
  token: Address;
  from: Address;
  amount: string;
  blockNumber: number;
  txHash: Hex;
  logIndex: number;
}

export interface BurnScanResult {
  burns: BurnRecord[];
  burnedByToken: Map<string, bigint>;
  fromBlock: number;
  toBlock: number;
  foreignBurnsIgnored: number;
}

/**
 * Scan Transfer(*, 0x...dEaD, *) chain-wide and keep only Vibe launch tokens.
 * Indexed-arg filtering happens at the node, so this is one cheap topic query
 * rather than a per-token fan-out.
 */
export async function indexBurns(
  launches: LaunchRecord[],
  fromBlock: number,
  toBlock: number
): Promise<BurnScanResult> {
  const vibeTokens = new Set(launches.map((l) => l.token.toLowerCase()));
  console.log(
    `\n[stage 3] burns: Transfer -> ${SHARED.burnAddress} over blocks ` +
      `${fmt(fromBlock)}..${fmt(toBlock)}`
  );

  const c = client();
  const burns: BurnRecord[] = [];
  let foreign = 0;
  let cursor = fromBlock;
  let chunkSize = config.logChunkBlocks;
  const safeTip = toBlock - 32;
  const scan = `burns-${fromBlock}-${toBlock}`;

  while (cursor <= toBlock) {
    const end = Math.min(cursor + chunkSize - 1, toBlock);
    const cacheable = end <= safeTip;

    let rows = cacheable ? readChunk<BurnRecord>(scan, cursor, end) : null;

    if (!rows) {
      try {
        const logs = await withRetry(
          () =>
            c.getLogs({
              event: TRANSFER_EVENT,
              args: { to: SHARED.burnAddress },
              fromBlock: BigInt(cursor),
              toBlock: BigInt(end),
            }),
          `getLogs burns ${cursor}-${end}`
        );
        rows = (logs as unknown[]).map((l) => {
          const log = l as {
            address: Address;
            args: { from?: Address; value?: bigint };
            blockNumber: bigint;
            transactionHash: Hex;
            logIndex: number;
          };
          return {
            token: log.address.toLowerCase() as Address,
            from: (log.args.from ?? SHARED.zeroAddress).toLowerCase() as Address,
            amount: String(log.args.value ?? 0n),
            blockNumber: Number(log.blockNumber),
            txHash: log.transactionHash,
            logIndex: Number(log.logIndex),
          };
        });
        if (cacheable) writeChunk(scan, cursor, end, rows);
      } catch (err) {
        if (isRangeError(err) && chunkSize > config.minLogChunkBlocks) {
          chunkSize = Math.max(config.minLogChunkBlocks, Math.floor(chunkSize / 2));
          console.warn(`  ~ burns: shrinking chunk to ${chunkSize}`);
          continue;
        }
        throw err;
      }
    }

    for (const r of rows) {
      if (vibeTokens.has(r.token)) burns.push(r);
      else foreign++;
    }
    cursor = end + 1;
  }

  const burnedByToken = new Map<string, bigint>();
  for (const b of sortLogs(burns)) {
    burnedByToken.set(b.token, (burnedByToken.get(b.token) ?? 0n) + BigInt(b.amount));
  }

  console.log(
    `  = ${fmt(burns.length)} burns across ${fmt(burnedByToken.size)} Vibe tokens ` +
      `(${fmt(foreign)} non-Vibe burns ignored)`
  );

  writeRaw(path.join(RAW_DIR, "burns.json"), burns, 0);
  return { burns, burnedByToken, fromBlock, toBlock, foreignBurnsIgnored: foreign };
}

/**
 * Read current vault token balances = the "held for burn" leg.
 *
 * HEAD-ONLY. This RPC prunes state after roughly 4k blocks, so there is no way
 * to reconstruct a historical vault balance. These figures are a snapshot at
 * `atBlock` and outputs label them as such.
 */
export async function readVaultHoldings(
  launches: LaunchRecord[],
  atBlock: number,
  limit: number
): Promise<Map<string, { held: bigint; vault: Address }>> {
  const subset = launches.slice(0, limit);
  console.log(
    `\n[stage 3b] vault holdings: balanceOf(creatorVault) for ${fmt(subset.length)} launches ` +
      `(HEAD-ONLY snapshot @ block ${fmt(atBlock)})`
  );

  const c = client();
  const out = new Map<string, { held: bigint; vault: Address }>();
  const BATCH = 200;

  for (let i = 0; i < subset.length; i += BATCH) {
    const slice = subset.slice(i, i + BATCH);
    const calls = slice.map((l) => ({
      address: l.token,
      abi: [
        parseAbiItem("function balanceOf(address account) view returns (uint256)"),
      ] as const,
      functionName: "balanceOf" as const,
      args: [l.creatorVault] as const,
    }));

    try {
      const res = (await withRetry(
        () => c.multicall({ contracts: calls as never, allowFailure: true }),
        `multicall vaultBalances ${i}-${i + slice.length}`
      )) as MulticallResult[];
      res.forEach((r, idx) => {
        const l = slice[idx];
        if (r.status === "success") {
          out.set(l.token, { held: r.result as bigint, vault: l.creatorVault });
        }
      });
    } catch (err) {
      console.warn(`  ! vault batch ${i} failed: ${sanitizeErrorMessage(err, 90)}`);
    }

    process.stdout.write(`\r  .. vaults ${Math.min(i + BATCH, subset.length)}/${subset.length}   `);
  }
  process.stdout.write("\n");

  const nonZero = [...out.values()].filter((v) => v.held > 0n).length;
  console.log(`  = ${fmt(out.size)} vault balances read, ${fmt(nonZero)} holding tokens`);
  return out;
}
