import type { TradeRecord } from "../stages/trades.js";
import type { ProjectRecord } from "../derive/projects.js";
import type { CurveState } from "../stages/headstate.js";
import {
  PROTOCOL_CONSTANTS,
  GENERATIONS,
  type Generation,
} from "../../config/factories.js";

/**
 * SANITY CHECKS
 *
 * These re-run, against freshly indexed data, the fee and burn accounting that
 * the due-diligence pass verified by hand.
 *
 * Two design rules, both learned the hard way:
 *
 * 1. ASSERT THE EXPECTED CONSTANTS, never adapt to the data. The first run
 *    "failed" these checks, and the failure was the finding: the retired
 *    factory generation runs 100 bps with a 50/50 split, which appears in no
 *    documentation and in no operator API response. A check that quietly fitted
 *    itself to observed data would have hidden that.
 *
 * 2. BE GENERATION-AWARE. Applying the published 125/75/25 to every generation
 *    is exactly the mistake this harness exists to catch.
 */

export interface CheckResult {
  name: string;
  passed: boolean;
  expected: string;
  observed: string;
  sampleSize: number;
  detail?: string;
}

/**
 * Below roughly 1,000 wei of gross, a 1-wei integer-division remainder swings
 * the implied bps by tens of points, so a bps comparison is meaningless. We
 * compare absolute wei (tolerance 2) and report dust separately rather than
 * letting it pollute the result.
 */
const DUST_GROSS_WEI = 1_000n;

/** Curve address (lowercased) -> which factory generation created it. */
export type GenerationLookup = (curve: `0x${string}`) => Generation | null;

function expectedFeeBps(gen: Generation | null): bigint | null {
  if (!gen) return null;
  return GENERATIONS.find((x) => x.generation === gen)?.economics.totalFeeBps ?? null;
}
function expectedCreatorShareBps(gen: Generation | null): bigint | null {
  if (!gen) return null;
  return GENERATIONS.find((x) => x.generation === gen)?.economics.creatorShareOfFeeBps ?? null;
}

/** Total fee matches that generation's policy. */
export function checkTotalFeeBps(trades: TradeRecord[], genOf: GenerationLookup): CheckResult {
  let ok = 0, dust = 0, unknownPolicy = 0, examined = 0;
  const byGen = new Map<string, { ok: number; bad: number }>();
  const outliers: string[] = [];

  for (const t of trades) {
    const gross = BigInt(t.grossWei);
    if (gross === 0n) continue;
    const gen = genOf(t.curve);
    const policy = expectedFeeBps(gen);
    if (policy === null) { unknownPolicy++; continue; }
    if (gross < DUST_GROSS_WEI) { dust++; continue; }

    examined++;
    const expected = (gross * policy) / PROTOCOL_CONSTANTS.bpsDenominator;
    const fee = BigInt(t.totalFeeWei);
    const diff = fee > expected ? fee - expected : expected - fee;
    const acc = byGen.get(gen!) ?? { ok: 0, bad: 0 };
    if (diff <= 2n) { ok++; acc.ok++; }
    else {
      acc.bad++;
      if (outliers.length < 5) {
        outliers.push(`${gen} ${t.txHash} gross=${gross} fee=${fee} expected=${expected}`);
      }
    }
    byGen.set(gen!, acc);
  }

  const perGen = [...byGen.entries()]
    .map(([g, v]) => `${g}:${v.ok}/${v.ok + v.bad}@${expectedFeeBps(g as Generation)}bps`)
    .join(", ");

  return {
    name: "total fee matches each generation's policy",
    passed: examined > 0 && ok === examined,
    expected: "retired=100 bps, legacy=125 bps, current=125 bps",
    observed:
      `${ok}/${examined} within 2 wei [${perGen}]; ` +
      `${dust} dust trades (<${DUST_GROSS_WEI} wei gross) excluded; ` +
      `${unknownPolicy} on generations with no observed policy`,
    sampleSize: examined,
    detail: outliers.length ? `outliers: ${outliers.join(" | ")}` : undefined,
  };
}

/** Creator/protocol split matches that generation's policy. */
export function checkFeeSplit(trades: TradeRecord[], genOf: GenerationLookup): CheckResult {
  let ok = 0, dust = 0, unknownPolicy = 0, examined = 0;
  const byGen = new Map<string, { ok: number; bad: number }>();
  const outliers: string[] = [];

  for (const t of trades) {
    const total = BigInt(t.totalFeeWei);
    if (total === 0n) continue;
    const gen = genOf(t.curve);
    const policy = expectedCreatorShareBps(gen);
    if (policy === null) { unknownPolicy++; continue; }
    if (BigInt(t.grossWei) < DUST_GROSS_WEI) { dust++; continue; }

    examined++;
    const expected = (total * policy) / PROTOCOL_CONSTANTS.bpsDenominator;
    const creator = BigInt(t.creatorFeeWei);
    const diff = creator > expected ? creator - expected : expected - creator;
    const acc = byGen.get(gen!) ?? { ok: 0, bad: 0 };
    if (diff <= 2n) { ok++; acc.ok++; }
    else {
      acc.bad++;
      if (outliers.length < 5) {
        outliers.push(`${gen} ${t.txHash} creator=${creator} total=${total} expected=${expected}`);
      }
    }
    byGen.set(gen!, acc);
  }

  const perGen = [...byGen.entries()]
    .map(([g, v]) => `${g}:${v.ok}/${v.ok + v.bad}@${expectedCreatorShareBps(g as Generation)}bps`)
    .join(", ");

  return {
    name: "creator/protocol split matches each generation's policy",
    passed: examined > 0 && ok === examined,
    expected: "retired=5000 bps (50/50), legacy=7500 bps, current=7500 bps (75/25)",
    observed: `${ok}/${examined} within 2 wei [${perGen}]; ${dust} dust excluded; ${unknownPolicy} unknown-policy`,
    sampleSize: examined,
    detail: outliers.length ? `outliers: ${outliers.join(" | ")}` : undefined,
  };
}

/** creatorFee + protocolFee must equal the reported total, exactly, everywhere. */
export function checkFeeAdditivity(trades: TradeRecord[]): CheckResult {
  let ok = 0;
  for (const t of trades) {
    if (BigInt(t.creatorFeeWei) + BigInt(t.protocolFeeWei) === BigInt(t.totalFeeWei)) ok++;
  }
  return {
    name: "creatorFee + protocolFee == totalFee",
    passed: ok === trades.length && trades.length > 0,
    expected: "exact equality on every trade, all generations",
    observed: `${ok}/${trades.length}`,
    sampleSize: trades.length,
  };
}

/**
 * THE BURN TRAP.
 *
 * Pre-graduation, transfersUnlocked()==false means bought-back tokens cannot be
 * moved to 0x...dEaD; they are held in the launch's CreatorVault. Expected:
 *   - locked tokens:   burned == 0, held may be > 0
 *   - unlocked tokens: burned may be > 0
 * A locked token with a non-zero burn balance would falsify the model.
 */
export function checkPreGraduationBurnAccounting(projects: ProjectRecord[]): CheckResult {
  let preGradWithHeld = 0, preGradWithBurn = 0, gradWithBurn = 0, examined = 0;
  const violations: string[] = [];

  for (const p of projects) {
    const unlocked = p.lifecycle.transfersUnlocked.value;
    const burned = p.buybackBurn.burnedToDeadAddressWei.value;
    const held = p.buybackBurn.heldForBurnInVaultWei.value;
    if (unlocked === null || burned === null || held === null) continue;
    examined++;

    const b = BigInt(burned);
    const h = BigInt(held);
    if (unlocked === false) {
      if (h > 0n) preGradWithHeld++;
      if (b > 0n) {
        preGradWithBurn++;
        if (violations.length < 5) {
          violations.push(`${p.identity.token.value} burned=${b} while transfers locked`);
        }
      }
    } else if (b > 0n) gradWithBurn++;
  }

  // A sample with no buyback activity satisfies the invariant vacuously and
  // proves nothing. Say so rather than banking an empty PASS.
  const vacuous = examined > 0 && preGradWithHeld === 0 && gradWithBurn === 0;

  return {
    name: "pre-graduation buybacks are held in vault, not burned",
    passed: preGradWithBurn === 0 && examined > 0 && !vacuous,
    expected: "zero locked tokens with a non-zero balance at 0x...dEaD",
    observed:
      `${examined} projects examined; ${preGradWithHeld} locked-with-vault-holdings, ` +
      `${preGradWithBurn} locked-with-burn (must be 0), ${gradWithBurn} unlocked-with-burn` +
      (vacuous ? " (INCONCLUSIVE: no buyback activity in this sample)" : ""),
    sampleSize: examined,
    detail: violations.length
      ? violations.join(" | ")
      : vacuous
      ? "Run `npx tsx scripts/verify-burn-model.mjs` for a targeted test against tokens known to have buyback activity."
      : undefined,
  };
}

/** TOTAL_FEE_BPS is constant WITHIN a generation, but differs BETWEEN them. */
export function checkCurveFeeConstant(
  curveStates: Map<string, CurveState>,
  genOf: GenerationLookup
): CheckResult {
  const byGen = new Map<string, Set<string>>();
  let reads = 0;
  for (const [curve, cs] of curveStates) {
    if (cs.totalFeeBps === null) continue;
    const gen = genOf(curve as `0x${string}`) ?? "unknown";
    const s = byGen.get(gen) ?? new Set<string>();
    s.add(cs.totalFeeBps);
    byGen.set(gen, s);
    reads++;
  }

  const bad: string[] = [];
  for (const [gen, vals] of byGen) {
    const expect = expectedFeeBps(gen as Generation);
    if (vals.size !== 1) bad.push(`${gen} has multiple values: ${[...vals].join("/")}`);
    else if (expect !== null && [...vals][0] !== expect.toString()) {
      bad.push(`${gen} reads ${[...vals][0]}, expected ${expect}`);
    }
  }

  return {
    name: "TOTAL_FEE_BPS is uniform within each generation",
    passed: bad.length === 0 && reads > 0,
    observed:
      [...byGen.entries()].map(([g, v]) => `${g}=${[...v].join("/")}`).join(", ") +
      ` across ${reads} curves`,
    expected: "one value per generation, matching that generation's recorded policy",
    sampleSize: reads,
    detail: bad.length ? bad.join(" | ") : undefined,
  };
}

export function runAllChecks(
  trades: TradeRecord[],
  projects: ProjectRecord[],
  curveStates: Map<string, CurveState>,
  genOf: GenerationLookup
): CheckResult[] {
  return [
    checkTotalFeeBps(trades, genOf),
    checkFeeSplit(trades, genOf),
    checkFeeAdditivity(trades),
    checkPreGraduationBurnAccounting(projects),
    checkCurveFeeConstant(curveStates, genOf),
  ];
}

export function printChecks(results: CheckResult[]): void {
  console.log(`\n[verify] sanity checks`);
  for (const r of results) {
    console.log(`  [${r.passed ? "PASS" : "FAIL"}] ${r.name}`);
    console.log(`         expected: ${r.expected}`);
    console.log(`         observed: ${r.observed}`);
    if (r.detail) console.log(`         detail:   ${r.detail}`);
  }
}
