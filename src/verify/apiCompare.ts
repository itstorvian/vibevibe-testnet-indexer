import { config } from "../../config/network.js";
import { sleep } from "../lib/rpc.js";
import { sanitizeErrorMessage } from "../lib/redact.js";
import type { ProjectRecord } from "../derive/projects.js";

/**
 * OPERATOR API COMPARISON: opt-in, off by default (--compare-api).
 *
 * This is a CROSS-CHECK, never a source of truth. Rules observed here:
 *
 *  - Read-only GETs, a handful of them, one at a time, with a delay. The
 *    operator rate-limits at 60 req/min and their Terms prohibit probing or
 *    overloading the service, and prohibit scraping to build a competing
 *    dataset. Spot-checking a reconstruction is neither.
 *  - We send no Origin header. With one, the edge returns 403 "Origin not
 *    allowed"; server-side calls with no Origin return 200. That asymmetry is
 *    itself a finding and is recorded in the output.
 *  - Nothing from here is ever written into a project record. It only lands in
 *    output/api-comparison.json next to our own numbers.
 */

export interface ApiComparison {
  enabled: boolean;
  note: string;
  apiReachable: boolean;
  corsPolicy: {
    withoutOriginHeader: string;
    withForeignOriginHeader: string;
    conclusion: string;
  } | null;
  configEcho: {
    curveFeeBps: number | null;
    creatorShareOfFeeBps: number | null;
    protocolShareOfFeeBps: number | null;
    deploymentVersion: string | null;
    /**
     * Whether the operator's single published config matches the CURRENT
     * generation's on-chain constants. It is not a platform-wide agreement
     * check: the retired generation runs 100 bps / 50-50, which this endpoint
     * does not describe at all.
     */
    matchesCurrentGenerationConstants: boolean | null;
  } | null;
  spotChecks: Array<{
    token: string;
    field: string;
    ours: string | null;
    theirs: string | null;
    agrees: boolean | null;
    note?: string;
  }>;
  rateLimit: { limit: string | null; remaining: string | null } | null;
}

async function getJson(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ ok: boolean; status: number; body: unknown; headers: Headers }> {
  const res = await fetch(url, { headers: { accept: "application/json", ...headers } });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body, headers: res.headers };
}

export async function compareWithApi(
  projects: ProjectRecord[],
  sampleSize = 5
): Promise<ApiComparison> {
  const base = `${config.apiBase}/chains/${config.chainId}`;
  const out: ApiComparison = {
    enabled: true,
    note:
      "Comparison only. Read-only GETs, rate-limit respected. The chain is the source of truth in every field of projects.json.",
    apiReachable: false,
    corsPolicy: null,
    configEcho: null,
    spotChecks: [],
    rateLimit: null,
  };

  console.log(`\n[verify] operator API cross-check (${sampleSize} projects)`);

  // 1. Reachability + the Origin asymmetry, demonstrated rather than asserted.
  try {
    const noOrigin = await getJson(`${base}/launches?limit=1`);
    await sleep(1100);
    const foreignOrigin = await getJson(`${base}/launches?limit=1`, {
      Origin: "https://example.invalid",
    });
    out.apiReachable = noOrigin.ok;
    out.rateLimit = {
      limit: noOrigin.headers.get("x-ratelimit-limit"),
      remaining: noOrigin.headers.get("x-ratelimit-remaining"),
    };
    out.corsPolicy = {
      withoutOriginHeader: `HTTP ${noOrigin.status}`,
      withForeignOriginHeader: `HTTP ${foreignOrigin.status}`,
      conclusion:
        noOrigin.ok && !foreignOrigin.ok
          ? "Server-side reads work; browser reads from a third-party origin are blocked at the edge. A third-party web app needs its own proxy."
          : "Unexpected: re-check the Origin policy manually.",
    };
    console.log(`  = no-Origin: HTTP ${noOrigin.status} | foreign Origin: HTTP ${foreignOrigin.status}`);
  } catch (err) {
    out.corsPolicy = null;
    console.warn(`  ! API unreachable: ${sanitizeErrorMessage(err, 100)}`);
    return out;
  }

  // 2. Do their published economics match the constants we read from the chain?
  await sleep(1100);
  try {
    const cfg = await getJson(`${base}/config`);
    const p = (cfg.body as { data?: { protocol?: Record<string, unknown>; deploymentVersion?: string } })?.data;
    const proto = p?.protocol ?? {};
    const curveFeeBps = Number(proto.curveFeeBps ?? NaN);
    const creator = Number(proto.creatorShareOfFeeBps ?? NaN);
    const protocol = Number(proto.protocolShareOfFeeBps ?? NaN);
    out.configEcho = {
      curveFeeBps: Number.isFinite(curveFeeBps) ? curveFeeBps : null,
      creatorShareOfFeeBps: Number.isFinite(creator) ? creator : null,
      protocolShareOfFeeBps: Number.isFinite(protocol) ? protocol : null,
      deploymentVersion: (p as { deploymentVersion?: string })?.deploymentVersion ?? null,
      // The operator publishes ONE set of constants. Those are the current
      // generation's. Comparing them to anything else would be a category error.
      matchesCurrentGenerationConstants:
        curveFeeBps === 125 && creator === 7500 && protocol === 2500,
    };
    console.log(
      `  = API config: fee=${curveFeeBps}bps split=${creator}/${protocol} ` +
        `-> matches CURRENT generation constants: ${out.configEcho.matchesCurrentGenerationConstants}`
    );
  } catch (err) {
    console.warn(`  ! config fetch failed: ${sanitizeErrorMessage(err, 90)}`);
  }

  /**
   * 3. Per-project spot checks on fields we reconstructed independently.
   *
   * Sampling note, learned by getting it wrong: an earlier version sampled the
   * first enriched projects, which after generation-balanced enrichment were all
   * RECENT `retired`-generation launches, and every one returned HTTP 404 from
   * the operator's API, producing five inconclusive checks and no signal.
   *
   * That 404 pattern is a real finding (see output/api-coverage-by-generation.json:
   * the "retired" factory is still producing launches the API does not serve), but
   * it is a COVERAGE question, not a FIELD-AGREEMENT question. So field agreement
   * is measured on launches the API actually serves, and coverage is measured
   * separately. Sampling across generations keeps the agreement test honest.
   */
  const enriched = projects.filter(
    (p) => p.identity.name.value && p.lifecycle.state.value !== "UNKNOWN"
  );
  const spread: typeof enriched = [];
  const seenGen = new Map<string, number>();
  const perGen = Math.max(1, Math.ceil(sampleSize / 3));
  for (const p of enriched) {
    const g = String(p.identity.generation.value);
    const n = seenGen.get(g) ?? 0;
    if (n >= perGen) continue;
    seenGen.set(g, n + 1);
    spread.push(p);
    if (spread.length >= sampleSize) break;
  }
  const sample = spread.length ? spread : enriched.slice(0, sampleSize);

  for (const proj of sample) {
    const token = proj.identity.token.value!;
    await sleep(1100);
    try {
      const res = await getJson(`${base}/launches/${token}`);
      if (!res.ok) {
        out.spotChecks.push({
          token, field: "launch", ours: "indexed", theirs: null, agrees: null,
          note: `API returned HTTP ${res.status}`,
        });
        continue;
      }
      const d = (res.body as { data?: Record<string, unknown> })?.data ?? {};

      const theirSymbol = (d.symbol as string) ?? null;
      out.spotChecks.push({
        token, field: "symbol",
        ours: proj.identity.symbol.value,
        theirs: theirSymbol,
        agrees: proj.identity.symbol.value === theirSymbol,
      });

      const curve = (d.curve as Record<string, unknown>) ?? {};
      const theirLifecycle = (curve.lifecycle as string) ?? null;
      out.spotChecks.push({
        token, field: "lifecycle",
        ours: proj.lifecycle.state.value,
        theirs: theirLifecycle,
        agrees: proj.lifecycle.state.value === theirLifecycle,
      });

      const theirCreator = ((d.creatorAddress as string) ?? "").toLowerCase() || null;
      out.spotChecks.push({
        token, field: "creator",
        ours: proj.identity.creator.value,
        theirs: theirCreator,
        agrees: proj.identity.creator.value === theirCreator,
      });

      const theirVault = ((d.creatorVaultAddress as string) ?? "").toLowerCase() || null;
      out.spotChecks.push({
        token, field: "creatorVault",
        ours: proj.identity.creatorVault.value,
        theirs: theirVault,
        agrees: proj.identity.creatorVault.value === theirVault,
      });
    } catch (err) {
      out.spotChecks.push({
        token, field: "launch", ours: "indexed", theirs: null, agrees: null,
        note: sanitizeErrorMessage(err, 90),
      });
    }
  }

  const agreed = out.spotChecks.filter((s) => s.agrees === true).length;
  const disagreed = out.spotChecks.filter((s) => s.agrees === false).length;
  console.log(`  = spot checks: ${agreed} agree, ${disagreed} disagree, ${out.spotChecks.length - agreed - disagreed} inconclusive`);
  return out;
}

export function disabledComparison(): ApiComparison {
  return {
    enabled: false,
    note: "Operator API comparison disabled. Run with --compare-api to cross-check. Every field in projects.json is reconstructed from chain data regardless.",
    apiReachable: false,
    corsPolicy: null,
    configEcho: null,
    spotChecks: [],
    rateLimit: null,
  };
}
