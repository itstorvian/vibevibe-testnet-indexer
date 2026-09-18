#!/usr/bin/env node
import { getHead, statsSummary } from "./lib/rpc.js";
import { config } from "../config/network.js";
import { EARLIEST_DEPLOYMENT_BLOCK, GENERATIONS } from "../config/factories.js";
import { indexLaunches, auditLaunchIds } from "./stages/launches.js";
import { indexTrades } from "./stages/trades.js";
import { indexBurns, readVaultHoldings } from "./stages/burns.js";
import { readTokenStates, readCurveStates, readProtocolState } from "./stages/headstate.js";
import { deriveProjects } from "./derive/projects.js";
import { summariseActivity } from "./derive/activity.js";
import { runAllChecks, printChecks } from "./verify/checks.js";
import { compareWithApi, disabledComparison } from "./verify/apiCompare.js";
import {
  emitFactories, emitProjects, emitTrades, emitFees, emitActivity, emitSummary,
  emitApiComparison, summariseForeignActivity,
  type RunMeta,
} from "./emit/outputs.js";
import { OUTPUT_DIR, fmt, setBulkOutputEnabled, bulkOutputEnabled } from "./lib/cache.js";
import { sanitizeRpcUrl, scrubCredentials } from "./lib/redact.js";

/**
 * vibe-indexer: read-only research harness for Robinhood Chain TESTNET.
 *
 * Never signs a transaction. Never writes on-chain. Never calls a private API.
 * The chain is the source of truth; the operator API is a cross-check only.
 */

interface Args {
  enrichLimit: number;
  tradeWindow: number;
  tradeFrom: number | null;
  fullTrades: boolean;
  burnWindow: number;
  fullBurns: boolean;
  compareApi: boolean;
  emitBulk: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i === -1 || !argv[i + 1]) return fallback;
    const n = Number(argv[i + 1].replace(/_/g, ""));
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  };
  return {
    enrichLimit: get("--enrich-limit", 1_500),
    tradeWindow: get("--trade-window", 200_000),
    tradeFrom: argv.includes("--trade-from") ? get("--trade-from", 0) : null,
    fullTrades: argv.includes("--full-trades"),
    burnWindow: get("--burn-window", 200_000),
    fullBurns: argv.includes("--full-burns"),
    compareApi: argv.includes("--compare-api"),
    emitBulk: argv.includes("--emit-bulk"),
  };
}

function help(): void {
  console.log(`
vibe-indexer: local Vibe/Vibe indexer & research harness (TESTNET 46630)

Usage: npm run index -- [options]

  --enrich-limit N   head-state reads (name/symbol/lifecycle/vault) for the N most
                     recent launches. Head-only: this RPC prunes state after ~4k
                     blocks, so there is no historical alternative. (default 1500)
  --trade-window N   index curve events over the last N blocks (default 200000)
  --trade-from N     explicit start block for the trade scan (overrides --trade-window)
  --full-trades      scan trades from the earliest factory deployment. Complete, but
                     ~23M blocks, so expect a long run against the public RPC.
  --burn-window N    index Transfer->0x...dEaD over the last N blocks (default 200000)
  --full-burns       scan burns across full history
  --compare-api      cross-check a small sample against the operator REST API
  --emit-bulk        also write the large artifacts: projects.json / .ndjson / .csv,
                     trades.json and data/raw/ dumps. A full run is ~400 MB each,
                     so these are OFF by default. Summary artifacts always emit.
  --help             this message

Environment:
  RPC_URL                RPC endpoint (default: public Robinhood Chain testnet RPC)
  LOG_CHUNK_BLOCKS       blocks per eth_getLogs call (default 20000, adaptive)
  REQUEST_DELAY_MS       politeness delay between RPC calls (default 150)
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) return help();
  const args = parseArgs(argv);
  setBulkOutputEnabled(args.emitBulk);
  const startedAt = new Date().toISOString();

  console.log("=".repeat(78));
  console.log("  vibe-indexer: Vibe/Vibe local indexer & research harness");
  console.log(`  NETWORK: Robinhood Chain ${config.label} (chain ${config.chainId})`);
  console.log("  READ-ONLY. No transactions. No writes. No private APIs. No real funds.");
  console.log("=".repeat(78));

  const head = await getHead();
  console.log(`\nhead block: ${fmt(head)}`);
  console.log(
    `state retention: ~${fmt(config.observedStateRetentionBlocks)} blocks ` +
      `(measured); all contract reads are HEAD-ONLY`
  );

  // ---- stage 1: launches (always full history) -------------------------
  const launches = await indexLaunches(head);
  if (launches.length === 0) {
    console.error("No launches found, aborting. Check RPC connectivity and factory addresses.");
    process.exit(1);
  }
  const launchAudit = auditLaunchIds(launches);

  const launchesNewestFirst = [...launches].sort((a, b) => b.deploymentBlock - a.deploymentBlock);

  // ---- stage 2: trades -------------------------------------------------
  const tradeFrom = args.fullTrades
    ? EARLIEST_DEPLOYMENT_BLOCK
    : args.tradeFrom ?? Math.max(EARLIEST_DEPLOYMENT_BLOCK, head - args.tradeWindow);
  const tradeScan = await indexTrades(launches, tradeFrom, head, args.fullTrades);

  // ---- stage 3: burns ---------------------------------------------------
  // Runs before enrichment ordering: tokens with observed burn activity are the
  // only ones that can make the burn-accounting check conclusive.
  const burnFrom = args.fullBurns
    ? EARLIEST_DEPLOYMENT_BLOCK
    : Math.max(EARLIEST_DEPLOYMENT_BLOCK, head - args.burnWindow);
  const burnScan = await indexBurns(launches, burnFrom, head);
  const burnCountByToken = new Map<string, number>();
  for (const b of burnScan.burns) {
    burnCountByToken.set(b.token, (burnCountByToken.get(b.token) ?? 0) + 1);
  }
  const burnTokens = new Set(burnScan.burnedByToken.keys());

  /**
   * ENRICHMENT PRIORITY.
   *
   * --enrich-limit is a hard budget because every head-state read is an RPC
   * call and this node prunes state after ~4k blocks. Spending it purely on the
   * newest launches samples only pre-graduation tokens with no buyback history,
   * which makes the burn-accounting check pass vacuously and prove nothing.
   *
   * Priority: (0) tokens with observed burns, (1) graduation/completion events,
   * (2) traded in the window, (3) newest launches.
   */
  const priorityCurves = new Set<string>();
  for (const e of tradeScan.lifecycle) {
    // CreatorFeesForwarded is the signal that creator fees have reached the vault,
    // which is the precondition for a launch-token buyback, so these curves are
    // where vault-held (not yet burned) balances are found.
    if (e.kind === "Graduated" || e.kind === "CurveCompleted" || e.kind === "CreatorFeesForwarded") {
      priorityCurves.add(e.curve);
    }
  }
  const activeCurves = new Set(tradeScan.trades.map((t) => t.curve));

  const rank = (l: (typeof launches)[number]) =>
    burnTokens.has(l.token) ? 0
      : priorityCurves.has(l.curve) ? 1
      : activeCurves.has(l.curve) ? 2
      : 3;

  const ranked = [...launchesNewestFirst].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra !== rb ? ra - rb : b.deploymentBlock - a.deploymentBlock;
  });

  /**
   * GENERATION-BALANCED SAMPLING.
   *
   * Ranking alone fills the whole budget with current-generation launches,
   * because that is where all recent activity is. But the older generations are
   * exactly where the interesting differences live: the retired factory runs a
   * different fee policy entirely. So we reserve a quota per generation before
   * filling the remainder by rank.
   */
  const perGenQuota = Math.max(
    50,
    Math.floor(args.enrichLimit / (GENERATIONS.length * 4))
  );
  const reserved: typeof launches = [];
  const takenKeys = new Set<string>();
  for (const g of GENERATIONS) {
    let n = 0;
    for (const l of ranked) {
      if (n >= perGenQuota) break;
      if (l.generation !== g.generation || takenKeys.has(l.key)) continue;
      reserved.push(l);
      takenKeys.add(l.key);
      n++;
    }
  }
  const enrichmentOrder = [...reserved, ...ranked.filter((l) => !takenKeys.has(l.key))];

  const sampledByGen = new Map<string, number>();
  for (const l of enrichmentOrder.slice(0, args.enrichLimit)) {
    sampledByGen.set(l.generation, (sampledByGen.get(l.generation) ?? 0) + 1);
  }
  console.log(
    `\n[enrich] priority: ${fmt(priorityCurves.size)} with lifecycle events, ` +
      `${fmt(activeCurves.size)} traded in window, rest newest-first`
  );
  console.log(
    `  .. generation quota ${perGenQuota} each; sample = ` +
      [...sampledByGen.entries()].map(([g, n]) => `${g}:${n}`).join(", ")
  );

  // ---- stage 3b: vault holdings ----------------------------------------
  const vaultHoldings = await readVaultHoldings(enrichmentOrder, head, args.enrichLimit);

  // ---- stage 4: head state ---------------------------------------------
  const tokenStates = await readTokenStates(enrichmentOrder, args.enrichLimit);
  const curveStates = await readCurveStates(enrichmentOrder, args.enrichLimit);
  await readProtocolState(head);

  // ---- derive ----------------------------------------------------------
  console.log(`\n[derive] assembling ${fmt(launches.length)} project records`);
  const projects = deriveProjects({
    launches: enrichmentOrder,
    tradeScan,
    tokenStates,
    curveStates,
    vaultHoldings,
    burnedByToken: burnScan.burnedByToken,
    burnCountByToken,
    burnScanFrom: burnScan.fromBlock,
    burnScanTo: burnScan.toBlock,
    headBlock: head,
  });

  /**
   * TRANSACTION ACTIVITY.
   *
   * Derived once, from the same records the rest of the run is built on, so
   * the published figure is reproducible rather than counted ad hoc at an
   * emitter. Launch scanning is always full history; the curve scan is only
   * full history under --full-trades, and the summary carries that distinction
   * rather than blurring it.
   */
  const activity = summariseActivity({
    launches,
    tradeScan,
    launchScan: { fromBlock: EARLIEST_DEPLOYMENT_BLOCK, toBlock: head, isFullHistory: true },
  });
  console.log(
    `\n[derive] indexed transactions: ${fmt(activity.uniqueTransactionCount)} distinct tx hashes ` +
      `(${activity.isFullHistory ? "full history" : "WINDOWED, not a lifetime total"})`
  );

  // ---- verify ----------------------------------------------------------
  // Checks are generation-aware: the retired factory runs a different fee
  // policy (100 bps / 50-50) from the current one (125 bps / 75-25).
  const generationByCurve = new Map(launches.map((l) => [l.curve, l.generation]));
  const genOf = (curve: `0x${string}`) => generationByCurve.get(curve) ?? null;
  const checks = runAllChecks(tradeScan.trades, projects, curveStates, genOf);
  printChecks(checks);

  const api = args.compareApi ? await compareWithApi(projects, 5) : disabledComparison();

  // ---- emit ------------------------------------------------------------
  const meta: RunMeta = {
    startedAt,
    finishedAt: new Date().toISOString(),
    headBlock: head,
    chainId: config.chainId,
    network: config.network,
    rpcEndpoint: sanitizeRpcUrl(config.rpcUrl),
    enrichLimit: args.enrichLimit,
    tradeFromBlock: tradeScan.fromBlock,
    tradeToBlock: tradeScan.toBlock,
    tradesAreFullHistory: tradeScan.isFullHistory,
    burnFromBlock: burnScan.fromBlock,
    burnToBlock: burnScan.toBlock,
    rpcStats: statsSummary() as unknown as Record<string, number>,
    launchIdAudit: launchAudit,
    foreignActivity: summariseForeignActivity(
      tradeScan.foreignLogsIgnored,
      burnScan.foreignBurnsIgnored,
      tradeScan.foreignAddressSample
    ),
  };

  console.log(`\n[emit] writing outputs to ${OUTPUT_DIR}`);
  emitFactories(meta, launches);
  emitProjects(projects);
  emitTrades(tradeScan);
  emitFees(projects, tradeScan, checks);
  emitActivity(meta, activity);
  emitApiComparison(api);
  emitSummary(meta, projects, launches, tradeScan, activity, checks, api);

  console.log(`
done.
  launches       ${fmt(launches.length)} across ${GENERATIONS.length} generations
  trades         ${fmt(tradeScan.trades.length)} (${tradeScan.isFullHistory ? "full history" : "windowed"})
  transactions   ${fmt(activity.uniqueTransactionCount)} distinct tx hashes (${activity.isFullHistory ? "full history" : "windowed"})
  enriched       ${fmt(args.enrichLimit)} projects with head state
  rpc calls      ${meta.rpcStats.rpcCalls} in ${meta.rpcStats.elapsedSeconds}s
  checks         ${checks.filter((c) => c.passed).length}/${checks.length} passed
`);
}

main().catch((err) => {
  // Scrub the stack too, not just the message: a fatal transport error prints
  // the whole viem error, and that is the loudest place a keyed URL can appear.
  // The stack is preserved, because a crash is exactly when it is needed.
  console.error("\nFATAL:", scrubCredentials(String((err as Error)?.stack ?? err)));
  process.exit(1);
});
