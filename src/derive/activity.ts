import type { LaunchRecord } from "../stages/launches.js";
import type { TradeScanResult } from "../stages/trades.js";

/**
 * DERIVED ACTIVITY SUMMARY: HOW MANY TRANSACTIONS DID WE ACTUALLY SEE?
 *
 * The trap this module exists to avoid: an event count is not a transaction
 * count, and a trade count is not a transaction count either.
 *
 * One transaction can emit several of the events this indexer decodes. A buy
 * that tips a curve over its graduation target emits `Bought` and
 * `CurveCompleted` in the same transaction; `CreatorFeesForwarded` rides along
 * with a trade; a launch with a non-zero `initialBuy` emits `TokenLaunched` and
 * the curve's first `Bought` from one call. Summing event rows therefore
 * overstates transactions, in a way that grows with exactly the activity a
 * reader would most want counted.
 *
 * So the unit of counting here is the TRANSACTION HASH, deduplicated globally
 * across every surface that contributes, and the component counts below are
 * themselves distinct-hash counts rather than row counts. The platform-wide
 * figure is the UNION of the components, never their sum.
 *
 * SCOPE HONESTY. This counts the transactions that produced the events this
 * indexer decodes. It is not "all Vibe/Vibe transactions", and nothing in this
 * repository could substantiate that claim: see `EXCLUSIONS` for what a
 * transaction can be and still not appear here.
 */

export const ACTIVITY_SCOPE = "launch-and-curve-events" as const;
export type ActivityScope = typeof ACTIVITY_SCOPE;

/** The event surfaces whose transactions are counted. */
export const INCLUDED_EVENT_SURFACES = [
  "TokenLaunched",
  "TokenLaunchedQuoted",
  "Bought",
  "Sold",
  "CurveCompleted",
  "Graduated",
  "CreatorFeesForwarded",
] as const;

/**
 * What a Vibe/Vibe-related transaction can be and still be absent from this
 * count. Published alongside the number so a reader can tell what it is not.
 */
export const EXCLUSIONS = [
  "Post-graduation trading. Graduated tokens trade on Uniswap v4 and those swaps are not indexed by this project at all.",
  "Buyback and burn transfers. Burns are ordinary ERC-20 Transfer logs, found by a separate scan with its own block window, so they fall outside this scope.",
  "LaunchFeesClaimed. The factory emits it when the operator sweeps accrued launch fees; it is a treasury action rather than launch or curve activity.",
  "Any transaction that emitted none of the included events: an approval, a plain token transfer, a failed call, or a read.",
  "Launches from a factory generation that is not configured in config/factories.ts. An unconfigured factory is never scanned, silently.",
] as const;

export const DEFINITION =
  "Distinct transaction hashes observed across the launch and curve event surfaces " +
  "indexed by this project. Multiple events emitted by one transaction count once, " +
  "and the platform-wide figure is the union of the component categories, not their sum.";

export interface ScanScope {
  fromBlock: number;
  toBlock: number;
  isFullHistory: boolean;
}

export interface ActivitySummary {
  scope: ActivityScope;
  definition: string;
  /**
   * True only when EVERY contributing scan covered full history.
   *
   * A windowed curve scan makes this false, and a false value must never be
   * presented next to lifetime launch totals as though it were one.
   */
  isFullHistory: boolean;
  /** Union of the three categories below. Never their sum. */
  uniqueTransactionCount: number;
  /** Distinct hashes within each category, for auditability. */
  launchTransactionCount: number;
  tradeTransactionCount: number;
  lifecycleTransactionCount: number;
  /**
   * How much the naive sum would have overstated by: the number of hashes that
   * appear in more than one category. Zero is a real observation, not a default.
   */
  sharedAcrossCategories: number;
  /**
   * Rows whose transaction hash could not be normalised to a 32-byte value and
   * were therefore not counted. Reported rather than silently dropped.
   */
  unusableTransactionHashes: number;
  launchScan: ScanScope;
  curveScan: ScanScope;
  includedEventSurfaces: readonly string[];
  exclusions: readonly string[];
}

export interface ActivityInput {
  launches: readonly LaunchRecord[];
  tradeScan: TradeScanResult;
  /** Bounds of the launch scan, which the CLI always runs over full history. */
  launchScan: ScanScope;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Canonical form for a transaction hash, or null if it is not one.
 *
 * Deduplication is string equality, so normalisation has to be exact in both
 * directions: it must fold representations of the same hash together (case, a
 * missing `0x`, stray whitespace) without folding distinct hashes together or
 * admitting a value that is not a hash at all. viem already returns lowercase
 * 0x-prefixed hashes; this is the guard for anything that does not.
 */
export function normalizeTxHash(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const lowered = raw.trim().toLowerCase();
  const bare = lowered.startsWith("0x") ? lowered.slice(2) : lowered;
  return HEX_64.test(bare) ? `0x${bare}` : null;
}

/**
 * Add every normalisable hash to `into`, returning how many were rejected.
 *
 * Takes an accessor rather than a `{ txHash }` shape so that millions of rows
 * can be walked without materialising an intermediate array.
 */
function collect<T>(
  into: Set<string>,
  rows: readonly T[],
  hashOf: (row: T) => unknown
): number {
  let unusable = 0;
  for (const row of rows) {
    const hash = normalizeTxHash(hashOf(row));
    if (hash === null) unusable++;
    else into.add(hash);
  }
  return unusable;
}

export function summariseActivity(input: ActivityInput): ActivitySummary {
  const { launches, tradeScan, launchScan } = input;

  /**
   * MEMORY. A full-history curve scan produces millions of trade rows, and a
   * Set of 66-character hashes is not free. Building a separate union Set
   * would hold every trade hash twice, so the trade set doubles as the union
   * base and only the launch and lifecycle hashes missing from it are held
   * separately. The result is identical to unioning three sets.
   */
  const tradeHashes = new Set<string>();
  const launchHashes = new Set<string>();
  const lifecycleHashes = new Set<string>();

  let unusable = 0;
  unusable += collect(tradeHashes, tradeScan.trades, (t) => t.txHash);
  unusable += collect(lifecycleHashes, tradeScan.lifecycle, (e) => e.txHash);
  unusable += collect(launchHashes, launches, (l) => l.deploymentTxHash);

  const outsideTrades = new Set<string>();
  for (const hash of launchHashes) if (!tradeHashes.has(hash)) outsideTrades.add(hash);
  for (const hash of lifecycleHashes) if (!tradeHashes.has(hash)) outsideTrades.add(hash);

  const unique = tradeHashes.size + outsideTrades.size;
  const componentSum = launchHashes.size + tradeHashes.size + lifecycleHashes.size;

  return {
    scope: ACTIVITY_SCOPE,
    definition: DEFINITION,
    isFullHistory: launchScan.isFullHistory && tradeScan.isFullHistory,
    uniqueTransactionCount: unique,
    launchTransactionCount: launchHashes.size,
    tradeTransactionCount: tradeHashes.size,
    lifecycleTransactionCount: lifecycleHashes.size,
    sharedAcrossCategories: componentSum - unique,
    unusableTransactionHashes: unusable,
    launchScan,
    curveScan: {
      fromBlock: tradeScan.fromBlock,
      toBlock: tradeScan.toBlock,
      isFullHistory: tradeScan.isFullHistory,
    },
    includedEventSurfaces: INCLUDED_EVENT_SURFACES,
    exclusions: EXCLUSIONS,
  };
}
