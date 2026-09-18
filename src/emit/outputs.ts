import path from "node:path";
import fs from "node:fs";
import { OUTPUT_DIR, writeJson, stringify, writeJsonStreamed, writeNdjson, fmt, writeBulk, bulkOutputEnabled } from "../lib/cache.js";
import { flatten } from "../lib/provenance.js";
import { looksCredentialBearing } from "../lib/redact.js";
import { GENERATIONS, PROTOCOL_CONSTANTS, SHARED, ASSETS, KEEPERS, VERIFIED_AT } from "../../config/factories.js";
import { config } from "../../config/network.js";
import type { ProjectRecord } from "../derive/projects.js";
import type { ActivitySummary } from "../derive/activity.js";
import type { TradeScanResult } from "../stages/trades.js";
import type { CheckResult } from "../verify/checks.js";
import type { ApiComparison } from "../verify/apiCompare.js";
import type { LaunchRecord } from "../stages/launches.js";

export interface RunMeta {
  startedAt: string;
  finishedAt: string;
  headBlock: number;
  chainId: number;
  network: string;
  /**
   * SANITIZED endpoint description, never a raw URL. Produced by
   * `sanitizeRpcUrl` at construction time in `src/cli.ts`, so no emitter can
   * leak a keyed RPC URL into a public artifact by forgetting to redact.
   */
  rpcEndpoint: string;
  enrichLimit: number;
  tradeFromBlock: number;
  tradeToBlock: number;
  tradesAreFullHistory: boolean;
  burnFromBlock: number;
  burnToBlock: number;
  rpcStats: Record<string, number>;
  launchIdAudit: Record<string, unknown>;
  foreignActivity: ForeignActivity;
}

/**
 * Curve-shaped and burn-shaped activity from contracts this indexer does not
 * recognise.
 *
 * WHAT THIS IS: the trade scan queries curve events by topic0 across all
 * addresses, because filtering on tens of thousands of curve addresses is not
 * practical. Any contract emitting a log with the same topic0 therefore appears,
 * and anything not in the known-curve set is counted here instead of indexed.
 *
 * WHAT THIS IS NOT: proof of a new factory. A topic0 is a hash of an event
 * signature, not a namespace. An unrelated contract, a fork, or another
 * launchpad reusing the same event shape produces identical evidence. This
 * signal cannot distinguish those cases, and nothing in this repository can.
 *
 * It is surfaced because a NEW Vibe factory generation WOULD show up here, and a
 * non-zero count is the only automatic hint available that the configured
 * address book may be incomplete. Treat it as a prompt to look, never as a
 * conclusion.
 */
export interface ForeignActivity {
  /** Curve-topic logs from unrecognised contracts, within the trade scan window. */
  curveLogsIgnored: number;
  /** Burn-shaped transfers of non-Vibe tokens, within the burn scan window. */
  burnLogsIgnored: number;
  /** Up to 20 distinct unrecognised contract addresses, for manual review. */
  addressSample: string[];
  /** Null when nothing foreign was seen. */
  warning: string | null;
}

/**
 * Build the foreign-activity block, including the hedged warning.
 *
 * Zero is reported as zero, not omitted: "we looked and saw none" is a different
 * statement from "we did not look".
 */
export function summariseForeignActivity(
  curveLogsIgnored: number,
  burnLogsIgnored: number,
  addressSample: string[]
): ForeignActivity {
  // The two legs carry very different weight, so they are reported separately.
  //
  // A foreign CURVE log is the interesting one: some contract emitted a curve
  // event this indexer does not recognise, which is what a new factory
  // generation would look like.
  //
  // A foreign BURN is close to noise. The burn scan looks at every
  // Transfer(*, 0x...dEaD, *) on the chain and keeps only Vibe tokens, so any
  // unrelated ERC-20 burning supply lands in this count. Saying "curve-related
  // activity was observed" on the strength of that alone would be wrong, and
  // pointing the reader at addressSample would be worse: addresses are only
  // collected for the curve leg, so on a burn-only trigger that list is empty.
  const parts: string[] = [];
  if (curveLogsIgnored > 0) {
    parts.push(
      `${curveLogsIgnored} curve-topic log(s) came from contracts this indexer does not ` +
        "recognise. This may indicate an unconfigured factory or unrelated contracts, and " +
        "requires manual review. A shared topic0 is not evidence of a Vibe/Vibe deployment: " +
        "it only means some contract emitted an event with the same signature." +
        (addressSample.length > 0
          ? " Check addressSample by hand before concluding anything, and see " +
            "config/factories.ts for how to add a factory if one is found."
          : "")
    );
  }
  if (burnLogsIgnored > 0) {
    parts.push(
      `${burnLogsIgnored} transfer(s) to the burn address involved tokens that are not Vibe ` +
        "launches. The burn scan is chain-wide, so unrelated ERC-20 activity is expected " +
        "here and this on its own does not suggest an unconfigured factory."
    );
  }

  return {
    curveLogsIgnored,
    burnLogsIgnored,
    addressSample,
    warning: parts.length > 0 ? parts.join(" ") : null,
  };
}

/**
 * Refuse to write an artifact whose endpoint description could carry a secret.
 *
 * This is a guard, not the mechanism. The mechanism is that `RunMeta` only ever
 * receives a value that has already been through `sanitizeRpcUrl`.
 */
function assertNoCredentialLeak(meta: RunMeta): void {
  if (looksCredentialBearing(meta.rpcEndpoint)) {
    throw new Error(
      "Refusing to write output: RunMeta.rpcEndpoint still looks credential-bearing. " +
        "It must be produced by sanitizeRpcUrl() before reaching any emitter. " +
        "The offending value is deliberately not printed."
    );
  }
}

export function emitFactories(meta: RunMeta, launches: LaunchRecord[]): void {
  // Defence in depth. `rpcEndpoint` is sanitized at construction in src/cli.ts,
  // so this can only fire if someone reintroduces a raw URL upstream. Failing
  // the run is the correct response: a leaked credential cannot be un-written.
  assertNoCredentialLeak(meta);

  const counts = new Map<string, { launches: number; first: number; last: number }>();
  for (const l of launches) {
    const c = counts.get(l.generation) ?? { launches: 0, first: Infinity, last: 0 };
    c.launches++;
    c.first = Math.min(c.first, l.deploymentBlock);
    c.last = Math.max(c.last, l.deploymentBlock);
    counts.set(l.generation, c);
  }

  writeJson(path.join(OUTPUT_DIR, "factories.json"), {
    network: config.label,
    chainId: config.chainId,
    warning:
      "TESTNET. No vibe/vibe mainnet deployment was identified during this research: the operator API returned UNSUPPORTED_CHAIN for chain 4663, and the Terms state chain 4663 is disabled.",
    generationsIndexed: GENERATIONS.length,
    note:
      "No on-chain registry enumerating factory generations was identified. An indexer that follows only the newest factory silently under-counts. launchId counters restart per factory, so launchId alone is not a unique key.",
    generations: GENERATIONS.map((g) => {
      const c = counts.get(g.generation);
      return {
        generation: g.generation,
        label: g.label,
        factory: g.factory,
        deploymentBlock: g.deploymentBlock,
        graduationAdapter: g.graduationAdapter,
        feeHook: g.feeHook,
        liquidityLocker: g.liquidityLocker,
        protocolTreasury: g.protocolTreasury,
        notes: g.notes,
        launchesIndexed: c?.launches ?? 0,
        firstLaunchBlock: c && c.first !== Infinity ? c.first : null,
        lastLaunchBlock: c?.last ?? null,
      };
    }),
    shared: SHARED,
    keepers: {
      ...KEEPERS,
      note: "Buyback execution is NOT permissionless. Both are hot EOAs owned by the operator.",
    },
    quoteAssets: {
      registered: [ASSETS.mockStockSPCX],
      warning:
        "The only quote asset observed as registered is a MOCK deployed by the operator. It is not a Robinhood Stock Token. At the time of verification, all 194 RHJ stock tokens listed by the issuer API were deployed on mainnet 4663, and none were found on testnet.",
    },
    protocolConstants: Object.fromEntries(
      Object.entries(PROTOCOL_CONSTANTS).map(([k, v]) => [
        k,
        typeof v === "bigint" ? v.toString() : v,
      ])
    ),
    verifiedAt: VERIFIED_AT,
    run: meta,
  }, 1);
}

/**
 * NOTE INTERNING.
 *
 * Provenance notes are the honest part of this dataset, but they are also
 * heavily repeated: the same "outside --enrich-limit" sentence appears on ~10
 * fields of ~75,000 records. Emitted verbatim, projects.json came to 571 MB, of
 * which the overwhelming majority was duplicated prose.
 *
 * So each distinct note is assigned a short code and emitted once in a legend.
 * Nothing is lost: `noteCode` resolves through `noteLegend`. Records that carry
 * a unique note keep it inline.
 */
function internNotes(projects: ProjectRecord[]): {
  legend: Record<string, string>;
  interned: ProjectRecord[];
} {
  const counts = new Map<string, number>();
  const walkCount = (o: unknown): void => {
    if (!o || typeof o !== "object") return;
    const p = o as { source?: string; note?: string };
    if (p.source && typeof p.note === "string") {
      counts.set(p.note, (counts.get(p.note) ?? 0) + 1);
      return;
    }
    for (const v of Object.values(o as Record<string, unknown>)) walkCount(v);
  };
  for (const p of projects) walkCount(p);

  // Only intern notes that actually repeat; a one-off note stays inline.
  const legend: Record<string, string> = {};
  const codeOf = new Map<string, string>();
  let i = 0;
  for (const [note, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (n < 25) continue;
    const code = `n${i++}`;
    legend[code] = note;
    codeOf.set(note, code);
  }

  const walkApply = (o: unknown): void => {
    if (!o || typeof o !== "object") return;
    const p = o as { source?: string; note?: string; noteCode?: string };
    if (p.source && typeof p.note === "string") {
      const code = codeOf.get(p.note);
      if (code) {
        p.noteCode = code;
        delete p.note;
      }
      return;
    }
    for (const v of Object.values(o as Record<string, unknown>)) walkApply(v);
  };
  for (const p of projects) walkApply(p);

  return { legend, interned: projects };
}

export function emitProjects(projects: ProjectRecord[]): void {
  const { legend, interned } = internNotes(projects);

  const header = {
    network: config.label,
    chainId: config.chainId,
    generatedAt: new Date().toISOString(),
    count: interned.length,
    provenanceLegend: {
      onchain_event: "decoded from a contract event log (strongest)",
      contract_read: "eth_call, HEAD-ONLY on this RPC (state is pruned after ~4k blocks)",
      vibe_api: "operator API, never used as a source of truth in this file",
      derived: "computed from other fields in this record",
      config: "constant from the verified address book",
      unavailable: "value is null; the note explains why",
    },
    noteLegend: legend,
    noteLegendUsage:
      "A field with `noteCode` resolves its explanation through noteLegend. A field with an inline `note` carries a one-off explanation.",
  };

  // Bulk artifacts are opt-in: a full run is ~77k records and ~400 MB each.
  // Streamed rather than JSON.stringify'd, which would exceed Node's max string length.
  writeBulk(path.join(OUTPUT_DIR, "projects.json"), () =>
    writeJsonStreamed(path.join(OUTPUT_DIR, "projects.json"), header, "projects", interned)
  );
  writeBulk(path.join(OUTPUT_DIR, "projects.ndjson"), () =>
    writeNdjson(path.join(OUTPUT_DIR, "projects.ndjson"), interned)
  );

  // A human-openable slice: the fully enriched records, notes expanded inline.
  const enrichedSlice = interned
    .filter((p) => p.identity.name.value !== null)
    .slice(0, 500);
  writeJson(
    path.join(OUTPUT_DIR, "projects-enriched-sample.json"),
    {
      ...header,
      count: enrichedSlice.length,
      note:
        "500 fully enriched projects, for reading by hand. The complete set of " +
        `${interned.length} projects is in projects.json / projects.ndjson.`,
      projects: enrichedSlice,
    },
    1
  );

  // CSV: one flat row per project, provenance stripped to bare values.
  // Bulk artifact -> opt-in via --emit-bulk.
  writeBulk(path.join(OUTPUT_DIR, "projects.csv"), () => {
    const rows = projects.map((p) => flatten(p as unknown as Record<string, unknown>));
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const esc = (v: unknown) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      cols.join(","),
      ...rows.map((r) => cols.map((c) => esc(r[c])).join(",")),
    ].join("\n");
    fs.writeFileSync(path.join(OUTPUT_DIR, "projects.csv"), csv);
  });
}

/**
 * Trades. The full tape can run to hundreds of thousands of records, so the
 * monolithic file is opt-in. Aggregates in fees.json and the run summary
 * always emit, so a default run is still useful.
 */
export function emitTrades(scan: TradeScanResult): void {
  writeBulk(path.join(OUTPUT_DIR, "trades.json"), () =>
    writeJsonStreamed(path.join(OUTPUT_DIR, "trades.json"), {
    network: config.label,
    chainId: config.chainId,
    scope: {
      fromBlock: scan.fromBlock,
      toBlock: scan.toBlock,
      isFullHistory: scan.isFullHistory,
      note: scan.isFullHistory
        ? "Full history from the earliest factory deployment."
        : "BOUNDED WINDOW. Per-project trade counts, volumes and fees in projects.json are scoped to this range and are marked confidence=medium there.",
    },
    counts: {
      trades: scan.trades.length,
      buys: scan.trades.filter((t) => t.side === "buy").length,
      sells: scan.trades.filter((t) => t.side === "sell").length,
      lifecycleEvents: scan.lifecycle.length,
      graduations: scan.lifecycle.filter((e) => e.kind === "Graduated").length,
      curveCompletions: scan.lifecycle.filter((e) => e.kind === "CurveCompleted").length,
    },
    integrity: {
      foreignLogsIgnored: scan.foreignLogsIgnored,
      foreignAddressSample: scan.foreignAddressSample,
      note:
        "Curve events are found by topic-only query across all addresses (no address filter is practical for tens of thousands of curves). Logs from contracts that share a topic0 but are not known Vibe curves are counted here and excluded.",
    },
  }, "trades", scan.trades)
  );

  // Lifecycle events are a much smaller set; keep them in their own file.
  writeJson(path.join(OUTPUT_DIR, "lifecycle.json"), {
    network: config.label,
    scope: { fromBlock: scan.fromBlock, toBlock: scan.toBlock, isFullHistory: scan.isFullHistory },
    count: scan.lifecycle.length,
    lifecycle: scan.lifecycle,
  }, 0);
}

/**
 * The transaction-count artifact.
 *
 * Small and always emitted, like fees.json: it is the artifact a downstream
 * consumer reads to publish "indexed transactions", so it has to travel with
 * the scope and provenance that make the number quotable. Aggregates only; the
 * hashes themselves stay in the opt-in bulk artifacts, where a reader who wants
 * to reproduce the count can recompute it from trades.json and launches.
 */
export function emitActivity(meta: RunMeta, activity: ActivitySummary): void {
  assertNoCredentialLeak(meta);

  writeJson(path.join(OUTPUT_DIR, "activity.json"), {
    network: config.label,
    chainId: config.chainId,
    generatedAt: new Date().toISOString(),
    headBlock: meta.headBlock,
    metric: "indexedTransactions",
    ...activity,
    reproduce:
      "Re-run with --full-trades --emit-bulk and take the size of the set of " +
      "lowercased transactionHash values across launches, trades and lifecycle events.",
    warning: activity.isFullHistory
      ? null
      : "NOT A LIFETIME TOTAL. At least one contributing scan was windowed, so this " +
        "figure counts transactions within the block ranges above only. Do not publish " +
        "it beside lifetime launch totals. Re-run with --full-trades for a lifetime figure.",
  }, 1);
}

export function emitFees(
  projects: ProjectRecord[],
  scan: TradeScanResult,
  checks: CheckResult[]
): void {
  let creator = 0n, protocol = 0n, gross = 0n;
  for (const t of scan.trades) {
    creator += BigInt(t.creatorFeeWei);
    protocol += BigInt(t.protocolFeeWei);
    gross += BigInt(t.grossWei);
  }
  const total = creator + protocol;

  let burned = 0n, held = 0n, withBurn = 0, withHeld = 0;
  for (const p of projects) {
    const b = p.buybackBurn.burnedToDeadAddressWei.value;
    const h = p.buybackBurn.heldForBurnInVaultWei.value;
    if (b) { const v = BigInt(b); burned += v; if (v > 0n) withBurn++; }
    if (h) { const v = BigInt(h); held += v; if (v > 0n) withHeld++; }
  }

  writeJson(path.join(OUTPUT_DIR, "fees.json"), {
    network: config.label,
    chainId: config.chainId,
    scope: { fromBlock: scan.fromBlock, toBlock: scan.toBlock, isFullHistory: scan.isFullHistory },
    /**
     * Fee policy is PER GENERATION. There is deliberately no single
     * platform-wide rate here: the retired generation runs different
     * economics from the newer ones. See docs/fee-models.md.
     */
    policyByGeneration: Object.fromEntries(
      GENERATIONS.map((g) => [
        g.generation,
        {
          factory: g.factory,
          totalFeeBps: g.economics.totalFeeBps?.toString() ?? null,
          creatorShareOfFeeBps: g.economics.creatorShareOfFeeBps?.toString() ?? null,
          protocolShareOfFeeBps:
            g.economics.creatorShareOfFeeBps === null
              ? null
              : (PROTOCOL_CONSTANTS.bpsDenominator - g.economics.creatorShareOfFeeBps).toString(),
          netGraduationTargetWei: g.economics.netGraduationTargetWei?.toString() ?? null,
          evidence: g.economics.evidence,
        },
      ])
    ),
    policySource:
      "curve.TOTAL_FEE_BPS() is a per-curve constant with no setter. Values above were read on-chain and cross-checked against decoded trade events. null means NOT VERIFIED, never a default.",
    operatorStatedSecondLevelSplits: Object.fromEntries(
      Object.entries(PROTOCOL_CONSTANTS.operatorStatedSecondLevelSplits).map(([k, v]) => [
        k,
        typeof v === "bigint" ? v.toString() : v,
      ])
    ),
    observed: {
      grossVolumeWei: gross.toString(),
      totalFeesWei: total.toString(),
      creatorFeesWei: creator.toString(),
      protocolFeesWei: protocol.toString(),
      impliedFeeBps: gross > 0n ? Number((total * 1_000_000n) / gross) / 100 : null,
      impliedCreatorShareBps: total > 0n ? Number((creator * 10_000n) / total) : null,
      tradeCount: scan.trades.length,
    },
    buybackBurn: {
      note:
        "Two legs. Pre-graduation, transfersUnlocked()==false prevents a transfer to 0x...dEaD, so bought-back tokens are HELD in the launch CreatorVault. Counting only the burn address under-reports supply impact.",
      burnAddress: SHARED.burnAddress,
      totalBurnedBaseUnits: burned.toString(),
      totalHeldForBurnBaseUnits: held.toString(),
      totalCommittedBaseUnits: (burned + held).toString(),
      projectsWithBurn: withBurn,
      projectsWithVaultHoldings: withHeld,
    },
    checks,
  }, 1);
}

export function emitSummary(
  meta: RunMeta,
  projects: ProjectRecord[],
  launches: LaunchRecord[],
  scan: TradeScanResult,
  activity: ActivitySummary,
  checks: CheckResult[],
  api: ApiComparison
): void {
  const byGen = new Map<string, number>();
  for (const l of launches) byGen.set(l.generation, (byGen.get(l.generation) ?? 0) + 1);

  const enriched = projects.filter((p) => p.identity.name.value !== null).length;
  const graduated = projects.filter((p) => p.lifecycle.state.value === "GRADUATED").length;
  const completeAwaiting = projects.filter(
    (p) => p.lifecycle.state.value === "CURVE_COMPLETE_AWAITING_GRADUATION"
  ).length;
  const trading = projects.filter((p) => p.lifecycle.state.value === "CURVE_TRADING").length;
  const quoted = projects.filter((p) => p.market.isQuotedLaunch.value === true).length;

  const provTotals = projects.reduce(
    (a, p) => {
      a.event += p.provenanceSummary.onchainEventFields;
      a.read += p.provenanceSummary.contractReadFields;
      a.derived += p.provenanceSummary.derivedFields;
      a.unavailable += p.provenanceSummary.unavailableFields;
      return a;
    },
    { event: 0, read: 0, derived: 0, unavailable: 0 }
  );
  const provTotal = provTotals.event + provTotals.read + provTotals.derived + provTotals.unavailable;
  const pct = (n: number) => ((n / Math.max(1, provTotal)) * 100).toFixed(1);

  const md = `# Vibe/Vibe Local Indexer: Run Summary

**NETWORK: Robinhood Chain TESTNET (chain ${meta.chainId}).** No vibe/vibe mainnet
deployment was identified during this research: the operator API returns \`UNSUPPORTED_CHAIN\` for chain 4663 and the Terms state
"Chain ID 4663 is disabled". Every figure below is test-value.

- Run started: ${meta.startedAt}
- Run finished: ${meta.finishedAt}
- Head block: ${fmt(meta.headBlock)}
- RPC endpoint: ${meta.rpcEndpoint}

## Unrecognised contract activity

| Signal | Count |
|---|---|
| Curve-topic logs from unrecognised contracts | ${fmt(meta.foreignActivity.curveLogsIgnored)} |
| Burn-shaped transfers of non-Vibe tokens | ${fmt(meta.foreignActivity.burnLogsIgnored)} |

${meta.foreignActivity.warning
    ? `> **${meta.foreignActivity.warning}**\n${
        meta.foreignActivity.addressSample.length > 0
          ? `>\n> Sample of unrecognised contract addresses:\n${meta.foreignActivity.addressSample
              .map((a) => `> - \`${a}\``)
              .join("\n")}\n`
          : ""
      }`
    : "No curve-shaped or burn-shaped activity from unrecognised contracts was seen in the scanned windows. This is a negative observation within those windows only, not proof that no other factory exists.\n"}

## Reconstruction totals

| Metric | Value |
|---|---|
| Launches reconstructed (all generations) | **${fmt(launches.length)}** |
| Factory generations covered | **${GENERATIONS.length}** |
${[...byGen.entries()].map(([g, n]) => `| - ${g} | ${fmt(n)} |`).join("\n")}
| Stock-quoted launches | ${fmt(quoted)} |
| Projects enriched with head state | ${fmt(enriched)} (limit ${fmt(meta.enrichLimit)}) |
| Trades indexed | ${fmt(scan.trades.length)} |
| Graduations observed | ${fmt(scan.lifecycle.filter((e) => e.kind === "Graduated").length)} |
| Curve completions observed | ${fmt(scan.lifecycle.filter((e) => e.kind === "CurveCompleted").length)} |

## Indexed transactions

**${fmt(activity.uniqueTransactionCount)}** distinct transaction hashes${
    activity.isFullHistory ? " across full history" : " **within the scanned windows below**"
  }.

${activity.definition}

| Category | Distinct transactions |
|---|---|
| Launch (\`TokenLaunched\`, \`TokenLaunchedQuoted\`) | ${fmt(activity.launchTransactionCount)} |
| Curve trades (\`Bought\`, \`Sold\`) | ${fmt(activity.tradeTransactionCount)} |
| Curve lifecycle (\`CurveCompleted\`, \`Graduated\`, \`CreatorFeesForwarded\`) | ${fmt(activity.lifecycleTransactionCount)} |
| **Union (the published figure)** | **${fmt(activity.uniqueTransactionCount)}** |
| Counted in more than one category | ${fmt(activity.sharedAcrossCategories)} |
| Rows with an unusable transaction hash | ${fmt(activity.unusableTransactionHashes)} |

The components do **not** add up to the union, and should not: ${fmt(
    activity.sharedAcrossCategories
  )} transaction(s) emitted events from more than one category, so summing the rows above
would overstate the total by exactly that many. Raw event counts overstate it further
still: ${fmt(scan.trades.length)} trade events came from ${fmt(
    activity.tradeTransactionCount
  )} distinct transactions, and ${fmt(scan.lifecycle.length)} lifecycle events came from
${fmt(activity.lifecycleTransactionCount)}.

| Contributing scan | From | To | Full history? |
|---|---|---|---|
| Launch events | ${fmt(activity.launchScan.fromBlock)} | ${fmt(activity.launchScan.toBlock)} | ${activity.launchScan.isFullHistory ? "**yes**" : "**no**"} |
| Curve events | ${fmt(activity.curveScan.fromBlock)} | ${fmt(activity.curveScan.toBlock)} | ${activity.curveScan.isFullHistory ? "**yes**" : "**no**"} |

${
  activity.isFullHistory
    ? ""
    : "> **This is NOT a lifetime transaction count.** A contributing scan was windowed, so " +
      "publishing this figure beside lifetime launch totals would misrepresent it. Re-run " +
      "with `--full-trades`.\n"
}
Not counted, and not claimable from this number:

${activity.exclusions.map((e) => `- ${e}`).join("\n")}

### Lifecycle (within the enriched subset)

| State | Count |
|---|---|
| CURVE_TRADING | ${fmt(trading)} |
| CURVE_COMPLETE_AWAITING_GRADUATION | ${fmt(completeAwaiting)} |
| GRADUATED | ${fmt(graduated)} |
| UNKNOWN (not enriched / outside scan) | ${fmt(projects.length - trading - completeAwaiting - graduated)} |

> Note the gap between **${fmt(scan.lifecycle.filter((e) => e.kind === "Graduated").length)} graduation events** in the trade window and
> **${fmt(graduated)} projects reading \`graduated == true\`** at head. Both numbers are correct: the first
> counts transitions that happened inside the scanned block range, the second is current
> state for the enriched sample, including projects that graduated before the window opened.
> It is a clean illustration of why event scope and head state must be reported separately.

## Scan scope

| Scan | From | To | Full history? |
|---|---|---|---|
| Launches | ${fmt(Math.min(...GENERATIONS.map((g) => g.deploymentBlock)))} | ${fmt(meta.headBlock)} | **yes** |
| Trades | ${fmt(meta.tradeFromBlock)} | ${fmt(meta.tradeToBlock)} | ${meta.tradesAreFullHistory ? "**yes**" : "**no, bounded window**"} |
| Burns | ${fmt(meta.burnFromBlock)} | ${fmt(meta.burnToBlock)} | ${meta.burnFromBlock <= Math.min(...GENERATIONS.map((g) => g.deploymentBlock)) ? "yes" : "no, bounded window"} |

${meta.tradesAreFullHistory ? "" : `> Trade-derived fields (counts, volumes, fees) in \`projects.json\` are scoped to the window above and are marked \`confidence: "medium"\` with an explanatory note. They are **not** lifetime totals.\n`}

## Provenance distribution

Across ${fmt(provTotal)} populated fields in \`projects.json\`:

| Source | Fields | Share |
|---|---|---|
| \`onchain_event\` | ${fmt(provTotals.event)} | ${pct(provTotals.event)}% |
| \`contract_read\` (head-only) | ${fmt(provTotals.read)} | ${pct(provTotals.read)}% |
| \`derived\` | ${fmt(provTotals.derived)} | ${pct(provTotals.derived)}% |
| \`unavailable\` (null + reason) | ${fmt(provTotals.unavailable)} | ${pct(provTotals.unavailable)}% |
| \`vibe_api\` | **0** | **0%** |

**Zero fields sourced from the operator API.** The API was used only for the optional
cross-check in \`output/api-comparison.json\`.

## Sanity checks

| Check | Result | Observed |
|---|---|---|
${checks.map((c) => `| ${c.name} | ${c.passed ? "**PASS**" : "**FAIL**"} | ${c.observed} |`).join("\n")}

## Operator API cross-check

${
  api.enabled
    ? `- API reachable: ${api.apiReachable}
- Rate limit: ${api.rateLimit?.limit ?? "?"} req/min (remaining at call time: ${api.rateLimit?.remaining ?? "?"})
- CORS: no Origin header -> ${api.corsPolicy?.withoutOriginHeader}; foreign Origin -> ${api.corsPolicy?.withForeignOriginHeader}
- ${api.corsPolicy?.conclusion ?? ""}
- Published economics match the CURRENT generation's on-chain constants: **${api.configEcho?.matchesCurrentGenerationConstants ?? "n/a"}**
- Field spot checks: ${api.spotChecks.filter((s) => s.agrees === true).length} agree, ${api.spotChecks.filter((s) => s.agrees === false).length} disagree, ${api.spotChecks.filter((s) => s.agrees === null).length} inconclusive`
    : "_Disabled. Re-run with `--compare-api` to cross-check against the operator API._"
}

## launchId audit

\`\`\`json
${stringify(meta.launchIdAudit, 1)}
\`\`\`

## RPC cost

\`\`\`json
${stringify(meta.rpcStats, 1)}
\`\`\`

---

_Generated by vibevibe-testnet-indexer. Read-only research harness: no transactions, no
writes, no private APIs. See docs/known-limitations.md for what this cannot do and why._
`;

  fs.writeFileSync(path.join(OUTPUT_DIR, "indexer-summary.md"), md);
}

export function emitApiComparison(api: ApiComparison): void {
  writeJson(path.join(OUTPUT_DIR, "api-comparison.json"), api, 1);
}
