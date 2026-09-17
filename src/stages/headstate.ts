import type { Address, Hex } from "viem";
import { client, withRetry, isPrunedStateError } from "../lib/rpc.js";
import { CURVE_READS, TOKEN_READS, QUOTE_REGISTRY_READS, ERC8056_READS, TREASURY_READS } from "../../config/abis.js";
import { SHARED, ASSETS, GENERATIONS } from "../../config/factories.js";
import { RAW_DIR, fmt, writeRaw } from "../lib/cache.js";
import { sanitizeErrorMessage } from "../lib/redact.js";
import path from "node:path";
import type { LaunchRecord } from "./launches.js";
import type { MulticallResult } from "./burns.js";

/**
 * STAGE 4: HEAD STATE
 *
 * Everything here is a SNAPSHOT AT HEAD and can never be anything else on this
 * RPC: eth_call at head-4096 works, head-16384 returns "metadata is not found",
 * head-65536 returns "missing trie node". There is no archive node available to
 * an outside builder on the public endpoint.
 *
 * Practical consequence: token name/symbol, lifecycle flags, reserves and
 * balances are all "as of block N". Historical values must come from events.
 */

export interface TokenState {
  token: Address;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  transfersUnlocked: boolean | null;
  burnedAtDeadAddress: string | null;
  readError: string | null;
}

export interface CurveState {
  curve: Address;
  complete: boolean | null;
  graduated: boolean | null;
  graduatedPoolId: Hex | null;
  quoteCurrency: Address | null;
  tokensSoldFromCurve: string | null;
  curveTokensRemaining: string | null;
  realEthReserve: string | null;
  virtualEthReserve: string | null;
  creatorFeesAccrued: string | null;
  protocolFeesAccrued: string | null;
  launchTimestamp: string | null;
  totalFeeBps: string | null;
  readError: string | null;
}

export async function readTokenStates(
  launches: LaunchRecord[],
  limit: number
): Promise<Map<string, TokenState>> {
  const subset = launches.slice(0, limit);
  console.log(`\n[stage 4a] token state: ${fmt(subset.length)} tokens (HEAD-ONLY)`);
  const c = client();
  const out = new Map<string, TokenState>();
  const BATCH = 100;

  for (let i = 0; i < subset.length; i += BATCH) {
    const slice = subset.slice(i, i + BATCH);
    const contracts = slice.flatMap((l) => [
      { address: l.token, abi: TOKEN_READS, functionName: "name" },
      { address: l.token, abi: TOKEN_READS, functionName: "symbol" },
      { address: l.token, abi: TOKEN_READS, functionName: "decimals" },
      { address: l.token, abi: TOKEN_READS, functionName: "totalSupply" },
      { address: l.token, abi: TOKEN_READS, functionName: "transfersUnlocked" },
      { address: l.token, abi: TOKEN_READS, functionName: "balanceOf", args: [SHARED.burnAddress] },
    ]);

    try {
      const res = (await withRetry(
        () => c.multicall({ contracts: contracts as never, allowFailure: true }),
        `multicall tokenState ${i}`
      )) as MulticallResult[];
      slice.forEach((l, idx) => {
        const base = idx * 6;
        const g = (k: number) => {
          const r = res[base + k];
          return r && r.status === "success" ? r.result : null;
        };
        out.set(l.token, {
          token: l.token,
          name: g(0) as string | null,
          symbol: g(1) as string | null,
          decimals: g(2) !== null ? Number(g(2)) : null,
          totalSupply: g(3) !== null ? String(g(3)) : null,
          transfersUnlocked: g(4) as boolean | null,
          burnedAtDeadAddress: g(5) !== null ? String(g(5)) : null,
          readError: null,
        });
      });
    } catch (err) {
      // Scrub BEFORE truncating: viem puts the request URL near the front of
      // the message, so slicing first would preserve a key, not remove it.
      const msg = isPrunedStateError(err)
        ? "state pruned: RPC is not an archive node"
        : sanitizeErrorMessage(err, 120);
      slice.forEach((l) =>
        out.set(l.token, {
          token: l.token, name: null, symbol: null, decimals: null, totalSupply: null,
          transfersUnlocked: null, burnedAtDeadAddress: null, readError: msg,
        })
      );
    }
    process.stdout.write(`\r  .. tokens ${Math.min(i + BATCH, subset.length)}/${subset.length}   `);
  }
  process.stdout.write("\n");
  const named = [...out.values()].filter((t) => t.name).length;
  console.log(`  = ${fmt(out.size)} token states read, ${fmt(named)} with name/symbol`);
  writeRaw(path.join(RAW_DIR, "token-state.json"), [...out.values()], 0);
  return out;
}

export async function readCurveStates(
  launches: LaunchRecord[],
  limit: number
): Promise<Map<string, CurveState>> {
  const subset = launches.slice(0, limit);
  console.log(`\n[stage 4b] curve state: ${fmt(subset.length)} curves (HEAD-ONLY)`);
  const c = client();
  const out = new Map<string, CurveState>();
  const BATCH = 60;
  const fns = [
    "complete", "graduated", "graduatedPoolId", "quoteCurrency",
    "tokensSoldFromCurve", "curveTokensRemaining", "realEthReserve",
    "virtualEthReserve", "creatorFeesAccrued", "protocolFeesAccrued",
    "launchTimestamp", "TOTAL_FEE_BPS",
  ] as const;

  for (let i = 0; i < subset.length; i += BATCH) {
    const slice = subset.slice(i, i + BATCH);
    const contracts = slice.flatMap((l) =>
      fns.map((fn) => ({ address: l.curve, abi: CURVE_READS, functionName: fn }))
    );
    try {
      const res = (await withRetry(
        () => c.multicall({ contracts: contracts as never, allowFailure: true }),
        `multicall curveState ${i}`
      )) as MulticallResult[];
      slice.forEach((l, idx) => {
        const base = idx * fns.length;
        const g = (k: number) => {
          const r = res[base + k];
          return r && r.status === "success" ? r.result : null;
        };
        const str = (k: number) => (g(k) !== null ? String(g(k)) : null);
        out.set(l.curve, {
          curve: l.curve,
          complete: g(0) as boolean | null,
          graduated: g(1) as boolean | null,
          graduatedPoolId: g(2) as Hex | null,
          quoteCurrency: g(3) ? (String(g(3)).toLowerCase() as Address) : null,
          tokensSoldFromCurve: str(4),
          curveTokensRemaining: str(5),
          realEthReserve: str(6),
          virtualEthReserve: str(7),
          creatorFeesAccrued: str(8),
          protocolFeesAccrued: str(9),
          launchTimestamp: str(10),
          totalFeeBps: str(11),
          readError: null,
        });
      });
    } catch (err) {
      // Scrub BEFORE truncating: viem puts the request URL near the front of
      // the message, so slicing first would preserve a key, not remove it.
      const msg = isPrunedStateError(err)
        ? "state pruned: RPC is not an archive node"
        : sanitizeErrorMessage(err, 120);
      slice.forEach((l) =>
        out.set(l.curve, {
          curve: l.curve, complete: null, graduated: null, graduatedPoolId: null,
          quoteCurrency: null, tokensSoldFromCurve: null, curveTokensRemaining: null,
          realEthReserve: null, virtualEthReserve: null, creatorFeesAccrued: null,
          protocolFeesAccrued: null, launchTimestamp: null, totalFeeBps: null, readError: msg,
        })
      );
    }
    process.stdout.write(`\r  .. curves ${Math.min(i + BATCH, subset.length)}/${subset.length}   `);
  }
  process.stdout.write("\n");
  const graduated = [...out.values()].filter((s) => s.graduated).length;
  console.log(`  = ${fmt(out.size)} curve states read, ${fmt(graduated)} graduated`);
  writeRaw(path.join(RAW_DIR, "curve-state.json"), [...out.values()], 0);
  return out;
}

/**
 * Protocol-level state: treasuries per generation, the quote registry, and the
 * (mock) stock quote asset.
 */
export async function readProtocolState(atBlock: number) {
  console.log(`\n[stage 4c] protocol state @ block ${fmt(atBlock)} (HEAD-ONLY)`);
  const c = client();

  const treasuries: Record<string, unknown> = {};
  for (const g of GENERATIONS) {
    if (!g.protocolTreasury) continue;
    const r: Record<string, string | null> = {};
    for (const fn of ["treasuryClaimable", "buybackBalance", "buybackExecutor", "treasury", "BURN_ADDRESS"] as const) {
      try {
        const v = await withRetry(
          () => c.readContract({ address: g.protocolTreasury as Address, abi: TREASURY_READS, functionName: fn }),
          `treasury.${fn} (${g.generation})`,
          { retries: 1 }
        );
        r[fn] = String(v);
      } catch {
        r[fn] = null; // older generations may not expose the same surface
      }
    }
    try {
      r.ethBalance = String(
        await withRetry(() => c.getBalance({ address: g.protocolTreasury as Address }), "getBalance")
      );
    } catch { r.ethBalance = null; }
    treasuries[g.generation] = { address: g.protocolTreasury, ...r };
  }

  // Quote registry: the stock-pair gate.
  let quoteRegistry: Record<string, unknown> = {};
  try {
    const admin = await withRetry(
      () => c.readContract({ address: SHARED.quoteRegistry, abi: QUOTE_REGISTRY_READS, functionName: "admin" }),
      "quoteRegistry.admin"
    );
    const econ = await withRetry(
      () => c.readContract({
        address: SHARED.quoteRegistry, abi: QUOTE_REGISTRY_READS,
        functionName: "quoteEconomics", args: [ASSETS.mockStockSPCX.address],
      }),
      "quoteRegistry.quoteEconomics(SPCX)"
    );
    const e = econ as readonly [bigint, bigint, bigint, boolean];
    quoteRegistry = {
      address: SHARED.quoteRegistry,
      admin: String(admin),
      adminIsPermissionless: false,
      registeredQuoteAssets: [
        {
          address: ASSETS.mockStockSPCX.address,
          symbol: ASSETS.mockStockSPCX.symbol,
          name: ASSETS.mockStockSPCX.onChainName,
          isMockStock: true,
          isRealRobinhoodStockToken: false,
          registered: e[3],
          initialVirtualReserve: String(e[0]),
          netGraduationTarget: String(e[1]),
          launchFee: String(e[2]),
        },
      ],
    };
  } catch (err) {
    quoteRegistry = { address: SHARED.quoteRegistry, error: sanitizeErrorMessage(err, 140) };
  }

  // ERC-8056 surface on the mock, to show what a real Stock Token would expose.
  let mockStock: Record<string, unknown> = {};
  try {
    const vals: Record<string, string> = {};
    for (const fn of ["uiMultiplier", "newUIMultiplier", "effectiveAt", "hasPendingUIMultiplierUpdate", "paused", "oraclePaused"] as const) {
      const v = await withRetry(
        () => c.readContract({ address: ASSETS.mockStockSPCX.address, abi: ERC8056_READS, functionName: fn }),
        `mockSPCX.${fn}`, { retries: 1 }
      );
      vals[fn] = String(v);
    }
    mockStock = {
      ...ASSETS.mockStockSPCX,
      erc8056: vals,
      warning:
        "MOCK. Not a Robinhood Stock Token. Real RHJ stock tokens exist only on mainnet 4663.",
    };
  } catch (err) {
    mockStock = { ...ASSETS.mockStockSPCX, error: sanitizeErrorMessage(err, 140) };
  }

  const state = { atBlock, treasuries, quoteRegistry, mockStock };
  writeRaw(path.join(RAW_DIR, "protocol-state.json"), state, 1);
  console.log(`  = treasuries: ${Object.keys(treasuries).length}, quote assets registered: 1 (mock)`);
  return state;
}
