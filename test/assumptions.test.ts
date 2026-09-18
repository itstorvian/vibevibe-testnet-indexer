import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  GENERATIONS,
  FACTORY_BY_ADDRESS,
  FACTORY_ADDRESSES,
  EARLIEST_DEPLOYMENT_BLOCK,
  PROTOCOL_CONSTANTS,
  resolveFeePolicy,
  hasVerifiedFeePolicy,
  generationOf,
  UnsupportedGenerationError,
} from "../config/factories.js";
import { isRangeError, isPrunedStateError } from "../src/lib/rpc.js";
import { config, assertTestnet, TESTNET_CHAIN_ID, MAINNET_CHAIN_ID } from "../config/network.js";
import {
  sanitizeRpcUrl,
  looksCredentialBearing,
  sanitizeErrorMessage,
  scrubCredentials,
  NO_ENDPOINT,
  UNPARSEABLE,
} from "../src/lib/redact.js";
import { summariseForeignActivity } from "../src/emit/outputs.js";
import { summariseActivity, normalizeTxHash } from "../src/derive/activity.js";
import type { LaunchRecord } from "../src/stages/launches.js";
import type { TradeRecord, LifecycleEvent, TradeScanResult } from "../src/stages/trades.js";

/**
 * These tests guard the assumptions that, if wrong, produce a working-looking
 * indexer that is quantifiably incorrect. They are about CORRECTNESS TRAPS, not
 * code coverage.
 *
 * Each one corresponds to a mistake that was actually made or nearly made while
 * building this. None of them require network access.
 */

describe("1. launch identity must be namespaced by factory", () => {
  test("launchId ranges overlap across generations, so launchId alone is NOT unique", () => {
    const ranges = GENERATIONS.map((g) => g.observedLaunchIdRange).filter(
      (r): r is { min: number; max: number } => r !== null
    );
    assert.ok(ranges.length >= 2, "need at least two generations to prove collision");

    // Every generation observed starts numbering at 0.
    for (const r of ranges) {
      assert.equal(r.min, 0, "each factory numbers its launches from 0 independently");
    }

    // Therefore low ids exist in more than one generation simultaneously.
    const idZeroAppearsIn = ranges.filter((r) => 0 >= r.min && 0 <= r.max).length;
    assert.ok(
      idZeroAppearsIn >= 2,
      `launchId 0 exists in ${idZeroAppearsIn} generations, so it cannot be a primary key`
    );
  });

  test("composite key {generation}:{launchId} is unique where launchId alone is not", () => {
    const collidingRaw = ["0", "0", "0", "1", "1"];
    const generations = ["retired", "legacy", "current", "retired", "legacy"];

    const naive = new Set(collidingRaw);
    const composite = new Set(collidingRaw.map((id, i) => `${generations[i]}:${id}`));

    assert.equal(naive.size, 2, "naive keying collapses 5 distinct projects into 2");
    assert.equal(composite.size, 5, "composite keying preserves all 5");
  });

  test("every configured factory resolves to exactly one generation", () => {
    assert.equal(FACTORY_BY_ADDRESS.size, GENERATIONS.length);
    for (const g of GENERATIONS) {
      assert.equal(generationOf(g.factory), g.generation);
      // case-insensitive: addresses arrive from logs in varying case
      assert.equal(generationOf(g.factory.toLowerCase()), g.generation);
      assert.equal(generationOf(g.factory.toUpperCase().replace("0X", "0x")), g.generation);
    }
  });
});

describe("2. fee policy is generation-specific, never global", () => {
  test("no single platform-wide fee rate exists across generations", () => {
    const rates = new Set(
      GENERATIONS.map((g) => g.economics.totalFeeBps).filter((v) => v !== null).map(String)
    );
    assert.ok(
      rates.size > 1,
      `expected divergent fee rates across generations, saw only: ${[...rates].join(",")}`
    );
  });

  test("no single platform-wide creator split exists across generations", () => {
    const splits = new Set(
      GENERATIONS.map((g) => g.economics.creatorShareOfFeeBps).filter((v) => v !== null).map(String)
    );
    assert.ok(splits.size > 1, "expected divergent creator splits across generations");
  });
});

describe("3. retired generation: 100 bps at a 50/50 split", () => {
  const policy = resolveFeePolicy("retired");

  test("policy constants match what was verified on-chain", () => {
    assert.equal(policy.totalFeeBps, 100n);
    assert.equal(policy.creatorShareOfFeeBps, 5_000n);
  });

  test("fee arithmetic on a realistic trade", () => {
    const gross = 1_000_000_000_000_000n; // 0.001 ETH
    const fee = (gross * policy.totalFeeBps!) / PROTOCOL_CONSTANTS.bpsDenominator;
    assert.equal(fee, 10_000_000_000_000n, "1.00% of gross");

    const creator = (fee * policy.creatorShareOfFeeBps!) / PROTOCOL_CONSTANTS.bpsDenominator;
    const protocolShare = fee - creator;
    assert.equal(creator, protocolShare, "50/50 split");
    assert.equal(creator + protocolShare, fee, "shares must sum to the fee exactly");
  });

  test("applying the newer 125 bps policy here would overstate the fee by 25%", () => {
    const gross = 1_000_000_000_000_000n;
    const correct = (gross * 100n) / PROTOCOL_CONSTANTS.bpsDenominator;
    const wrong = (gross * 125n) / PROTOCOL_CONSTANTS.bpsDenominator;
    assert.equal((wrong * 100n) / correct, 125n, "25% overstatement, the trap this guards");
  });

  test("graduation target is 1000x smaller than the current generation", () => {
    const retired = resolveFeePolicy("retired").netGraduationTargetWei!;
    const current = resolveFeePolicy("current").netGraduationTargetWei!;
    assert.equal(current / retired, 1000n);
  });
});

describe("4. legacy and current generations: 125 bps at 75/25", () => {
  for (const gen of ["legacy", "current"] as const) {
    test(`${gen} policy constants`, () => {
      const p = resolveFeePolicy(gen);
      assert.equal(p.totalFeeBps, 125n);
      assert.equal(p.creatorShareOfFeeBps, 7_500n);
    });
  }

  test("fee arithmetic on a realistic trade", () => {
    const p = resolveFeePolicy("current");
    const gross = 1_000_000_000_000_000n; // 0.001 ETH
    const fee = (gross * p.totalFeeBps!) / PROTOCOL_CONSTANTS.bpsDenominator;
    assert.equal(fee, 12_500_000_000_000n, "1.25% of gross");

    const creator = (fee * p.creatorShareOfFeeBps!) / PROTOCOL_CONSTANTS.bpsDenominator;
    const protocolShare = fee - creator;
    assert.equal(creator, 9_375_000_000_000n, "75%");
    assert.equal(protocolShare, 3_125_000_000_000n, "25%");
    assert.equal(creator + protocolShare, fee);
  });
});

describe("5. burn accounting distinguishes vault-held from dead-address", () => {
  // Mirrors the real shape: committed = burned(at 0x..dEaD) + heldForBurn(in vault)
  const committed = (burned: bigint, held: bigint) => burned + held;

  test("a locked (pre-graduation) token can hold a vault balance with zero burned", () => {
    const burned = 0n;
    const held = 448_959_670_681_245_187_318_299n; // observed on a real testnet token
    assert.equal(committed(burned, held), held);
    assert.notEqual(
      burned,
      committed(burned, held),
      "dead-address balance alone would report ZERO here: the core trap"
    );
  });

  test("dead-address-only accounting understates committed supply", () => {
    const burned = 503_074_289_815_168_282_419_874_179n;
    const held = 462_920_251_173_372_895_707_299_015n;
    const total = committed(burned, held);
    const missedPct = Number((held * 1000n) / total) / 10;
    assert.ok(missedPct > 40, `dead-address-only would miss ${missedPct}% of committed supply`);
  });

  test("invariant: a token with transfers locked must have zero at the burn address", () => {
    // transfersUnlocked === false => transfer to 0x..dEaD reverts (TransfersLocked)
    const rows = [
      { transfersUnlocked: false, burned: 0n, held: 100n },
      { transfersUnlocked: false, burned: 0n, held: 0n },
      { transfersUnlocked: true, burned: 500n, held: 0n },
    ];
    for (const r of rows) {
      if (!r.transfersUnlocked) {
        assert.equal(r.burned, 0n, "locked token must not hold a burn-address balance");
      }
    }
  });

  test("a vacuous sample must not be treated as verification", () => {
    // The check that nearly shipped false confidence: it passed on a sample
    // containing no buyback activity at all.
    const sample = [{ transfersUnlocked: false, burned: 0n, held: 0n }];
    const sawActivity = sample.some((r) => r.held > 0n || r.burned > 0n);
    assert.equal(sawActivity, false);
    // Therefore the correct verdict is INCONCLUSIVE, not PASS.
    const verdict = sawActivity ? "PASS" : "INCONCLUSIVE";
    assert.equal(verdict, "INCONCLUSIVE");
  });
});

describe("6. an unknown future generation fails safely", () => {
  test("resolveFeePolicy throws rather than defaulting", () => {
    assert.throws(
      () => resolveFeePolicy("gen4-unknown"),
      UnsupportedGenerationError,
      "must refuse to invent a policy for an unconfigured generation"
    );
  });

  test("a null generation throws", () => {
    assert.throws(() => resolveFeePolicy(null), UnsupportedGenerationError);
  });

  test("the error names the offending generation and points at the config", () => {
    try {
      resolveFeePolicy("gen4-unknown");
      assert.fail("should have thrown");
    } catch (e) {
      const msg = String((e as Error).message);
      assert.match(msg, /gen4-unknown/);
      assert.match(msg, /config\/factories\.ts/);
      assert.match(msg, /will NOT assume/i);
    }
  });

  test("an unrecognised factory address resolves to null, not a guess", () => {
    assert.equal(generationOf("0x000000000000000000000000000000000000beef"), null);
  });

  test("hasVerifiedFeePolicy is false for unknown generations and true for known", () => {
    assert.equal(hasVerifiedFeePolicy("gen4-unknown"), false);
    assert.equal(hasVerifiedFeePolicy(null), false);
    assert.equal(hasVerifiedFeePolicy("retired"), true);
    assert.equal(hasVerifiedFeePolicy("current"), true);
  });

  test("unverified policy fields stay null and are never filled from a sibling generation", () => {
    const legacy = resolveFeePolicy("legacy");
    assert.equal(
      legacy.netGraduationTargetWei,
      null,
      "legacy graduation target was not read on-chain; it must not inherit gen3's value"
    );
    assert.notEqual(resolveFeePolicy("current").netGraduationTargetWei, null);
  });
});

describe("7. log scanner reacts to the result-count limit", () => {
  test("recognises the undocumented 10,000-result cap as a range error", () => {
    assert.equal(
      isRangeError(new Error("logs matched by query exceeds limit of 10000")),
      true,
      "this is the BINDING limit for dense event ranges"
    );
  });

  test("recognises the time limit as a range error", () => {
    assert.equal(isRangeError(new Error("log query timed out")), true);
  });

  test("does not misclassify unrelated failures as range errors", () => {
    assert.equal(isRangeError(new Error("ECONNRESET")), false);
    assert.equal(isRangeError(new Error("Internal JSON-RPC error")), false);
  });

  test("pruned-state errors are distinguished from range errors and are NOT retried", () => {
    const pruned = new Error("metadata is not found, 118607767");
    const trie = new Error("missing trie node f4e5c98f");
    assert.equal(isPrunedStateError(pruned), true);
    assert.equal(isPrunedStateError(trie), true);
    assert.equal(isRangeError(pruned), false, "retrying or shrinking cannot recover pruned state");
  });

  test("halving from the default chunk reaches the floor in a bounded number of steps", () => {
    let size = config.logChunkBlocks;
    let steps = 0;
    while (size > config.minLogChunkBlocks && steps < 50) {
      size = Math.max(config.minLogChunkBlocks, Math.floor(size / 2));
      steps++;
    }
    assert.ok(steps < 20, `chunk backoff terminates (took ${steps} halvings)`);
    assert.equal(size, config.minLogChunkBlocks);
  });

  test("a fixed block range is never assumed safe", () => {
    assert.ok(
      config.minLogChunkBlocks < config.logChunkBlocks,
      "there must be room to shrink below the default"
    );
  });
});

describe("8. API failure does not break on-chain indexing", () => {
  test("the disabled-comparison result is well formed and carries no data", async () => {
    const { disabledComparison } = await import("../src/verify/apiCompare.js");
    const r = disabledComparison();
    assert.equal(r.enabled, false);
    assert.equal(r.apiReachable, false);
    assert.deepEqual(r.spotChecks, []);
    assert.equal(r.corsPolicy, null);
    assert.match(r.note, /chain data regardless/i);
  });

  test("comparison is opt-in: the API is not consulted unless --compare-api is passed", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")
    );
    assert.match(src, /args\.compareApi\s*\?\s*await compareWithApi|args\.compareApi\s*$/m);
    assert.match(src, /disabledComparison\(\)/);
  });

  test("no provenance source in the emitted record model is the API", async () => {
    const { fromEvent, fromRead, derived, unavailable } = await import(
      "../src/lib/provenance.js"
    );
    for (const p of [fromEvent(1), fromRead(1), derived(1), unavailable<number>("x")]) {
      assert.notEqual(p.source, "vibe_api", "the API must never be a source of truth in records");
    }
  });
});

describe("9. network safety rails", () => {
  test("indexer is pinned to testnet and refuses other chains", () => {
    assert.equal(config.chainId, TESTNET_CHAIN_ID);
    assert.equal(TESTNET_CHAIN_ID, 46630);
    assert.doesNotThrow(() => assertTestnet(TESTNET_CHAIN_ID));
    assert.throws(() => assertTestnet(MAINNET_CHAIN_ID), /not Robinhood Chain TESTNET/);
    assert.throws(() => assertTestnet(1), /not Robinhood Chain TESTNET/);
  });

  test("scans start at the earliest configured factory deployment, not the newest", () => {
    assert.equal(EARLIEST_DEPLOYMENT_BLOCK, Math.min(...GENERATIONS.map((g) => g.deploymentBlock)));
    const newest = Math.max(...GENERATIONS.map((g) => g.deploymentBlock));
    assert.ok(
      EARLIEST_DEPLOYMENT_BLOCK < newest,
      "starting at the newest factory would skip older generations entirely"
    );
  });

  test("all configured factories are scanned, including ones labelled retired", () => {
    assert.equal(FACTORY_ADDRESSES.length, GENERATIONS.length);
    const retired = GENERATIONS.find((g) => g.generation === "retired");
    assert.ok(retired);
    assert.equal(
      retired!.observedStillProducingLaunches,
      true,
      '"retired" is an operator label, not an observed state; it was still producing launches'
    );
  });

  test("no credentials are embedded in the default configuration", () => {
    assert.match(config.rpcUrl, /^https?:\/\//);
    assert.doesNotMatch(config.rpcUrl, /[?&](api[_-]?key|key|token)=/i);
    // A keyed provider URL would carry a long opaque path segment.
    const lastSegment = new URL(config.rpcUrl).pathname.split("/").filter(Boolean).pop() ?? "";
    assert.ok(lastSegment.length < 24, "default RPC URL must not contain an API key");
  });
});

/**
 * 10. RPC ENDPOINT REDACTION
 *
 * A keyed RPC URL is a credential. It reaches this process through RPC_URL and
 * previously flowed verbatim into output/factories.json via RunMeta.
 *
 * Every secret below is a fake placeholder. Assertion messages deliberately do
 * not echo the fixture, so a real value pasted into these tests by mistake
 * would still not be printed.
 */
describe("10. RPC endpoint redaction", () => {
  const SECRET = "FAKEKEY000000000000DONOTUSE";
  const PASSWORD = "FAKEPASSWORD000DONOTUSE";

  const fixtures: Array<{ name: string; url: string; secrets: string[] }> = [
    {
      name: "public unkeyed Robinhood testnet RPC",
      url: "https://rpc.testnet.chain.robinhood.com",
      secrets: [],
    },
    {
      name: "Alchemy-style path key",
      url: `https://robinhood-testnet.g.alchemy.com/v2/${SECRET}`,
      secrets: [SECRET],
    },
    {
      name: "Infura-style path key",
      url: `https://mainnet.infura.io/v3/${SECRET}`,
      secrets: [SECRET],
    },
    {
      name: "QuickNode-style path key with trailing slash",
      url: `https://example-name.quiknode.pro/${SECRET}/`,
      secrets: [SECRET],
    },
    {
      name: "query-string API key",
      url: `https://rpc.example.com/?apikey=${SECRET}`,
      secrets: [SECRET],
    },
    {
      name: "URL basic-auth credentials",
      url: `https://someuser:${PASSWORD}@rpc.example.com/`,
      secrets: [PASSWORD, "someuser"],
    },
  ];

  for (const fx of fixtures) {
    test(`no secret fragment survives: ${fx.name}`, () => {
      const out = sanitizeRpcUrl(fx.url);
      for (const secret of fx.secrets) {
        assert.ok(
          !out.includes(secret),
          `sanitized endpoint for "${fx.name}" still contained a secret fragment`
        );
      }
      assert.ok(
        !looksCredentialBearing(out),
        `sanitized endpoint for "${fx.name}" still looks credential-bearing`
      );
    });
  }

  test("the public unkeyed endpoint stays recognisable", () => {
    // Redaction must not be so aggressive that the host is lost, otherwise the
    // artifact cannot say which network it read.
    assert.equal(
      sanitizeRpcUrl("https://rpc.testnet.chain.robinhood.com"),
      "https://rpc.testnet.chain.robinhood.com"
    );
  });

  test("path and query presence is recorded without revealing contents", () => {
    const out = sanitizeRpcUrl(`https://rpc.example.com/v2/${SECRET}?key=${SECRET}`);
    assert.ok(out.startsWith("https://rpc.example.com"), "host must survive");
    assert.ok(out.includes("<redacted>"), "redaction marker must be present");
    assert.ok(!out.includes(SECRET), "no secret fragment may survive");
    assert.ok(!out.includes("v2"), "path segments are discarded, not just the last one");
  });

  test("malformed input is refused without echoing it back", () => {
    const out = sanitizeRpcUrl("not a url ::: " + SECRET);
    assert.equal(out, UNPARSEABLE);
    assert.ok(!out.includes(SECRET), "unparseable input must not be echoed");
  });

  test("empty and missing input produce a marker, not a crash", () => {
    assert.equal(sanitizeRpcUrl(""), NO_ENDPOINT);
    assert.equal(sanitizeRpcUrl("   "), NO_ENDPOINT);
    assert.equal(sanitizeRpcUrl(undefined), NO_ENDPOINT);
    assert.equal(sanitizeRpcUrl(null), NO_ENDPOINT);
  });

  test("sanitizing an already-sanitized value is stable", () => {
    const once = sanitizeRpcUrl(`https://rpc.example.com/v2/${SECRET}`);
    assert.equal(sanitizeRpcUrl(once), once, "sanitization must be idempotent");
    assert.ok(!looksCredentialBearing(once));
  });

  /**
   * The two artifacts named in the audit finding. These are source-level
   * assertions rather than a live run, because proving the property matters
   * more than exercising the writer: the guarantee is that no raw URL is ever
   * placed in RunMeta, so no emitter can write one.
   */
  describe("generated artifacts cannot receive a raw URL", () => {
    const outputsSrc = fs.readFileSync(
      new URL("../src/emit/outputs.ts", import.meta.url),
      "utf8"
    );
    const cliSrc = fs.readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

    test("RunMeta has no raw rpcUrl field", () => {
      const iface = outputsSrc.slice(
        outputsSrc.indexOf("export interface RunMeta"),
        outputsSrc.indexOf("function assertNoCredentialLeak")
      );
      assert.ok(iface.includes("rpcEndpoint"), "RunMeta must carry a sanitized endpoint");
      assert.doesNotMatch(
        iface,
        /rpcUrl/,
        "RunMeta must not carry a raw rpcUrl; sanitize at the source instead"
      );
    });

    test("cli.ts populates RunMeta through the sanitizer", () => {
      assert.match(
        cliSrc,
        /rpcEndpoint:\s*sanitizeRpcUrl\(/,
        "RunMeta.rpcEndpoint must be produced by sanitizeRpcUrl"
      );
      assert.doesNotMatch(
        cliSrc,
        /rpcUrl:\s*config\.rpcUrl/,
        "a raw config.rpcUrl must not be assigned into RunMeta"
      );
    });

    test("the markdown summary uses the sanitized endpoint", () => {
      assert.match(outputsSrc, /RPC endpoint: \$\{meta\.rpcEndpoint\}/);
      assert.doesNotMatch(
        outputsSrc,
        /meta\.rpcUrl/,
        "no emitter may reference a raw rpcUrl"
      );
    });

    test("factories.json emit is guarded against a credential-bearing endpoint", () => {
      assert.match(
        outputsSrc,
        /export function emitFactories[\s\S]{0,400}?assertNoCredentialLeak\(meta\)/,
        "emitFactories must assert before writing"
      );
    });
  });
});

/**
 * 11. UNRECOGNISED CONTRACT ACTIVITY
 *
 * A new factory generation would show up as curve-topic logs from contracts the
 * address book does not know. That signal is worth surfacing, and worth being
 * honest about: it cannot tell a new Vibe factory from any other contract that
 * emits an event with the same signature.
 */
describe("11. unrecognised contract activity is surfaced without overclaiming", () => {
  test("zero foreign activity is reported as zero, not hidden", () => {
    const fa = summariseForeignActivity(0, 0, []);
    assert.equal(fa.curveLogsIgnored, 0);
    assert.equal(fa.burnLogsIgnored, 0);
    assert.equal(fa.warning, null, "a clean scan must not raise a warning");
    assert.deepEqual(fa.addressSample, []);
  });

  test("non-zero foreign activity raises a warning", () => {
    const fa = summariseForeignActivity(12, 0, ["0xabc"]);
    assert.ok(fa.warning, "foreign activity must produce a warning");
    assert.match(fa.warning!, /manual review/i);
  });

  test("burn-leg foreign activity alone also raises the warning", () => {
    const fa = summariseForeignActivity(0, 7, []);
    assert.ok(fa.warning, "the burn leg must not be ignored");
  });

  test("the warning does NOT claim an unconfigured factory was found", () => {
    const fa = summariseForeignActivity(500, 3, ["0xabc", "0xdef"]);
    const w = fa.warning!;
    // The whole point of M2: surface the signal, refuse the conclusion.
    assert.match(w, /may indicate/i, "must be hedged, not assertive");
    assert.match(w, /unrelated contracts/i, "must name the competing explanation");
    assert.doesNotMatch(
      w,
      /\b(new factory (was )?(found|detected|discovered)|is a vibe)\b/i,
      "must not assert that a factory was discovered"
    );
  });

  test("a burn-only trigger does not claim curve activity", () => {
    // Regression, found by the 2026-09-17 live validation run: the warning fired
    // on the combined total, so 1,804 unrelated ERC-20 burns produced the text
    // "Foreign curve-related activity was observed" while curveLogsIgnored was 0.
    const fa = summariseForeignActivity(0, 1804, []);
    assert.ok(fa.warning, "a burn-leg signal is still worth reporting");
    assert.doesNotMatch(
      fa.warning!,
      /curve-topic|curve-related|curve event/i,
      "must not describe burn-leg activity as curve activity"
    );
    assert.match(fa.warning!, /burn address/i, "must say what was actually seen");
    assert.match(
      fa.warning!,
      /does not suggest an unconfigured factory/i,
      "must not imply a new factory on burn-leg evidence alone"
    );
  });

  test("the warning never points at an empty address sample", () => {
    // addressSample is populated by the curve leg only, so a burn-only trigger
    // leaves it empty. Telling the reader to inspect it would be a dead end.
    for (const fa of [
      summariseForeignActivity(0, 50, []),
      summariseForeignActivity(7, 0, []),
    ]) {
      assert.ok(fa.warning);
      assert.equal(fa.addressSample.length, 0);
      assert.doesNotMatch(
        fa.warning!,
        /check addressSample/i,
        "must not direct the reader to an empty list"
      );
    }
    // With addresses present, the pointer is useful and should appear.
    const withAddrs = summariseForeignActivity(7, 0, ["0xabc"]);
    assert.match(withAddrs.warning!, /check addressSample/i);
  });

  test("both legs are reported when both are non-zero", () => {
    const fa = summariseForeignActivity(3, 9, ["0xabc"]);
    assert.match(fa.warning!, /curve-topic/i, "curve leg must be described");
    assert.match(fa.warning!, /burn address/i, "burn leg must be described");
  });

  test("the address sample is carried through for manual review", () => {
    const addrs = ["0x1", "0x2", "0x3"];
    assert.deepEqual(summariseForeignActivity(9, 0, addrs).addressSample, addrs);
  });

  test("foreign activity reaches an ALWAYS-emitted artifact, not just trades.json", () => {
    const outputsSrc = fs.readFileSync(
      new URL("../src/emit/outputs.ts", import.meta.url),
      "utf8"
    );
    // factories.json is written with writeJson (always), not writeBulk (opt-in),
    // and embeds RunMeta wholesale as `run`.
    const iface = outputsSrc.slice(
      outputsSrc.indexOf("export interface RunMeta"),
      outputsSrc.indexOf("export interface ForeignActivity")
    );
    assert.match(iface, /foreignActivity: ForeignActivity;/,
      "RunMeta must carry foreignActivity so factories.json receives it");
    assert.match(outputsSrc, /## Unrecognised contract activity/,
      "the markdown summary must surface it too");
  });
});

/**
 * 12. PERSISTED ERROR TEXT CARRIES NO CREDENTIAL
 *
 * viem embeds the request URL in error messages, and those messages are
 * persisted: readError in data/raw/token-state.json and curve-state.json, error
 * in protocol-state.json, note in the always-emitted api-comparison.json.
 *
 * The specific trap these tests pin: truncation is not redaction. viem puts
 * "URL: <the url>" near the FRONT of the message, so slice(0, 120) keeps the
 * secret. Scrubbing must happen first.
 *
 * All fixtures are obvious fakes.
 */
describe("12. persisted error text carries no credential", () => {
  const SECRET = "FAKEKEY000000000000DONOTUSE";
  const PASSWORD = "FAKEPASSWORD000DONOTUSE";

  /** Shaped like a real viem HttpRequestError: URL first, details after. */
  const viemish = (url: string) =>
    `HTTP request failed.\n\nURL: ${url}\nRequest body: {"method":"eth_call"}\n\nDetails: 401 Unauthorized\nVersion: viem@2.56.5`;

  const cases: Array<{ name: string; url: string; secrets: string[] }> = [
    {
      name: "Alchemy path key",
      url: `https://robinhood-testnet.g.alchemy.com/v2/${SECRET}`,
      secrets: [SECRET],
    },
    {
      name: "Infura path key",
      url: `https://mainnet.infura.io/v3/${SECRET}`,
      secrets: [SECRET],
    },
    {
      name: "QuickNode path key",
      url: `https://example-name.quiknode.pro/${SECRET}/`,
      secrets: [SECRET],
    },
    {
      name: "query-string key",
      url: `https://rpc.example.com/?apikey=${SECRET}`,
      secrets: [SECRET],
    },
    {
      name: "basic-auth URL",
      url: `https://someuser:${PASSWORD}@rpc.example.com/`,
      secrets: [PASSWORD, "someuser"],
    },
  ];

  for (const c of cases) {
    test(`secret does not survive a persisted error: ${c.name}`, () => {
      const out = sanitizeErrorMessage(new Error(viemish(c.url)));
      for (const secret of c.secrets) {
        assert.ok(!out.includes(secret), `persisted error for "${c.name}" retained a secret fragment`);
      }
      assert.ok(!out.includes(c.url), "the raw URL must not survive intact");
    });
  }

  test("scrubbing happens BEFORE truncation", () => {
    // The whole point. The URL sits inside the first 120 characters, so a
    // slice-then-scrub implementation would keep the key and still pass a naive
    // length check.
    const url = `https://rpc.example.com/v2/${SECRET}`;
    const msg = viemish(url);
    assert.ok(msg.indexOf(SECRET) < 120, "fixture must place the secret inside the truncation window");
    const out = sanitizeErrorMessage(new Error(msg), 120);
    assert.ok(!out.includes(SECRET), "scrub must run before slice");
    assert.ok(out.length <= 120, "truncation must still apply");
  });

  test("every occurrence is scrubbed, not just the first", () => {
    const url = `https://rpc.example.com/v2/${SECRET}`;
    const msg = `Request to ${url} failed. Retried ${url}. Giving up on ${url}.`;
    const out = sanitizeErrorMessage(new Error(msg), 500);
    assert.equal(out.includes(SECRET), false, "no occurrence may survive");
    assert.equal(
      out.split("<redacted>").length - 1,
      3,
      "all three occurrences should be replaced"
    );
  });

  test("malformed URL text is still scrubbed", () => {
    const out = sanitizeErrorMessage(new Error(`connect failed: htp:/${SECRET}@@@broken`), 200);
    // Not parseable as a URL, so the generic pass cannot help; the literal pass
    // must, because this is the configured endpoint shape.
    const viaLiteral = scrubCredentials(`connect failed: htp:/${SECRET}@@@broken`, [
      `htp:/${SECRET}@@@broken`,
    ]);
    assert.ok(!viaLiteral.includes(SECRET), "a known endpoint string must be scrubbed literally");
    assert.equal(typeof out, "string", "malformed input must not throw");
  });

  test("scrubbing is idempotent and the marker stays well formed", () => {
    // Regression: the generic pass stops at "<", so on already-scrubbed text it
    // once matched the trailing slash of "https://host/<redacted>" and collapsed
    // it to "https://host<redacted>". No secret escaped, but the marker was
    // malformed and a second pass kept changing the string.
    for (const url of [
      `https://provider.example/v2/${SECRET}`,
      `https://h.example/?apikey=${SECRET}`,
      `https://someuser:${PASSWORD}@h.example/`,
    ]) {
      const once = scrubCredentials(viemish(url));
      const twice = scrubCredentials(once);
      assert.equal(twice, once, "scrubbing must be idempotent");
      assert.ok(!once.includes(SECRET), "no secret may survive");
    }
    const out = scrubCredentials(`URL: https://provider.example/v2/${SECRET}`);
    assert.match(out, /https:\/\/provider\.example\/<redacted>/, "marker must keep its slash");
  });

  test("an ordinary error without a URL is left readable", () => {
    const out = sanitizeErrorMessage(new Error("execution reverted: TransfersLocked()"));
    assert.equal(out, "execution reverted: TransfersLocked()", "useful text must survive intact");
  });

  test("the scrubbed message stays useful for debugging", () => {
    const out = sanitizeErrorMessage(new Error(viemish(`https://provider.example/v2/${SECRET}`)), 300);
    assert.match(out, /HTTP request failed/, "the failure mode must remain visible");
    assert.match(out, /provider\.example/, "the host must remain visible");
    assert.match(out, /<redacted>/, "the redaction must be visible");
    assert.match(out, /401 Unauthorized/, "the cause must remain visible");
  });

  test("non-Error inputs do not throw", () => {
    assert.equal(typeof sanitizeErrorMessage("plain string"), "string");
    assert.equal(typeof sanitizeErrorMessage(undefined), "string");
    assert.equal(typeof sanitizeErrorMessage(null), "string");
    assert.equal(typeof sanitizeErrorMessage({ message: "objecty" }), "string");
  });

  /**
   * Source-level: no persisted field may be built from a raw `.message`.
   */
  describe("no persisted field bypasses the scrubber", () => {
    const readSrc = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

    test("headstate.ts persists only scrubbed errors", () => {
      const src = readSrc("../src/stages/headstate.ts");
      assert.doesNotMatch(
        src,
        /String\(\(err as Error\)\.message\)/,
        "headstate must not build a persisted message from a raw error"
      );
      assert.match(src, /sanitizeErrorMessage\(err, 120\)/);
      assert.match(src, /sanitizeErrorMessage\(err, 140\)/);
    });

    test("api-comparison note is scrubbed (that artifact is written every run)", () => {
      const src = readSrc("../src/verify/apiCompare.ts");
      assert.match(src, /note: sanitizeErrorMessage\(err, 90\)/);
    });
  });
});

/**
 * 13. HELPER SCRIPTS LEAK NO CREDENTIAL TO THE TERMINAL
 *
 * scripts/*.mjs run standalone under tsx. Their chain-ID guard interpolated a
 * raw err.message into a new Error, and a transport failure there puts the whole
 * configured RPC URL, key included, into that message.
 *
 * The scripts execute on import (top-level await, immediate side effects), so
 * they cannot be imported into a test without running them against the network.
 * These are therefore source-level assertions plus a behavioural test of the
 * exact expression the scripts now use.
 */
describe("13. helper scripts leak no credential to the terminal", () => {
  const SECRET = "FAKEKEY000000000000DONOTUSE";
  const PASSWORD = "FAKEPASSWORD000DONOTUSE";
  const SCRIPTS = ["../scripts/verify-burn-model.mjs", "../scripts/check-api-coverage.mjs"];
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

  for (const p of SCRIPTS) {
    const name = p.split("/").pop()!;

    test(`${name} builds no message from a raw error`, () => {
      const src = read(p);
      assert.doesNotMatch(
        src,
        /String\(\s*err\??\.message/,
        "a raw err.message must not be interpolated into terminal output"
      );
      assert.doesNotMatch(
        src,
        /String\(\s*e\.shortMessage\s*\|\|\s*e\.message\s*\)/,
        "a raw viem message must not be interpolated into terminal output"
      );
    });

    test(`${name} routes errors through the shared scrubber`, () => {
      const src = read(p);
      assert.match(
        src,
        /import \{ sanitizeErrorMessage \} from "\.\.\/src\/lib\/redact\.js";/,
        "must use the shared utility, not a local copy"
      );
      assert.match(
        src,
        /Could not read the chain ID from the configured RPC endpoint: \$\{sanitizeErrorMessage\(err, 200\)\}/,
        "the chain-ID guard must scrub before interpolating"
      );
    });

    test(`${name} keeps its chain-ID guard behaviour`, () => {
      const src = read(p);
      // The fix must not have weakened the guard itself.
      assert.match(src, /const EXPECTED_CHAIN_ID = 46630;/);
      assert.match(src, /await\s+\w+\.getChainId\(\)/);
      assert.match(src, /actual !== EXPECTED_CHAIN_ID/);
      assert.match(src, /Refusing to run: connected chain is/);
    });
  }

  test("the guard's message expression scrubs every credential shape", () => {
    // Exactly the expression the scripts now evaluate.
    const build = (err: unknown) =>
      `Could not read the chain ID from the configured RPC endpoint: ${sanitizeErrorMessage(err, 200)}`;

    const urls = [
      `https://provider.example/v2/${SECRET}`,
      `https://mainnet.infura.io/v3/${SECRET}`,
      `https://name.quiknode.pro/${SECRET}/`,
      `https://rpc.example.com/?apikey=${SECRET}`,
      `https://someuser:${PASSWORD}@rpc.example.com/`,
    ];

    for (const url of urls) {
      const out = build(new Error(`HTTP request failed.\n\nURL: ${url}\n\nDetails: 401`));
      assert.ok(!out.includes(SECRET), "no path or query key may survive");
      assert.ok(!out.includes(PASSWORD), "no basic-auth password may survive");
      assert.match(out, /Could not read the chain ID/, "diagnostic text must survive");
    }
  });

  test("repeated occurrences of the RPC URL are all scrubbed", () => {
    const url = `https://provider.example/v2/${SECRET}`;
    const out = sanitizeErrorMessage(
      new Error(`Failed ${url}; retried ${url}; gave up on ${url}`),
      400
    );
    assert.ok(!out.includes(SECRET), "no occurrence may survive");
    assert.equal(out.split("<redacted>").length - 1, 3, "all three must be replaced");
  });

  test("a malformed endpoint is not echoed back", () => {
    const out = sanitizeErrorMessage(new Error(`bad endpoint: ${SECRET}`), 200, [SECRET]);
    assert.ok(!out.includes(SECRET), "a known-bad endpoint string must be scrubbed literally");
  });
});

/**
 * 14. AN EVENT COUNT IS NOT A TRANSACTION COUNT
 *
 * The public "indexed transactions" metric counts distinct TRANSACTION HASHES,
 * not rows. One transaction routinely emits several indexed events: a buy that
 * tips a curve over its target emits Bought and CurveCompleted together, a
 * launch with a non-zero initialBuy emits TokenLaunched and the curve's first
 * Bought, and CreatorFeesForwarded rides along with a trade.
 *
 * Summing rows, or summing the per-category counts, therefore overstates the
 * figure by exactly the overlap, and the overlap grows with the activity a
 * reader most wants counted. These tests pin that the derivation takes the
 * union, normalises before comparing, and refuses to dress a windowed scan up
 * as a lifetime total.
 */
describe("14. transactions are counted by distinct hash, never by event row", () => {
  const hash = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;

  const launch = (tx: string, i = 0) =>
    ({
      key: `current:${i}`,
      generation: "current",
      factory: "0xfac",
      launchId: String(i),
      token: `0xtoken${i}`,
      curve: `0xcurve${i}`,
      creator: "0xcreator",
      creatorFeeRecipient: "0xrecipient",
      creatorVault: "0xvault",
      quoteCurrency: null,
      isQuotedLaunch: false,
      initialBuy: "0",
      initialTokensBought: "0",
      metadataSchemaVersion: 1,
      metadataDigest: "0x00",
      metadataURI: "",
      deploymentBlock: 100 + i,
      deploymentTxHash: tx,
      logIndex: 0,
    }) as unknown as LaunchRecord;

  const trade = (tx: string, logIndex = 0) =>
    ({
      curve: "0xcurve0",
      token: "0xtoken0",
      side: "buy",
      trader: "0xtrader",
      recipient: "0xtrader",
      grossWei: "0",
      curveQuoteWei: "0",
      ethReceivedWei: null,
      tokenAmount: "0",
      creatorFeeWei: "0",
      protocolFeeWei: "0",
      totalFeeWei: "0",
      blockNumber: 200,
      txHash: tx,
      logIndex,
    }) as unknown as TradeRecord;

  const lifecycle = (tx: string, logIndex = 1) =>
    ({
      curve: "0xcurve0",
      token: "0xtoken0",
      kind: "CurveCompleted",
      blockNumber: 200,
      txHash: tx,
      logIndex,
    }) as unknown as LifecycleEvent;

  const scan = (
    trades: TradeRecord[],
    lifecycleEvents: LifecycleEvent[],
    isFullHistory = true,
    bounds: [number, number] = [EARLIEST_DEPLOYMENT_BLOCK, 1_000_000]
  ): TradeScanResult => ({
    trades,
    lifecycle: lifecycleEvents,
    fromBlock: bounds[0],
    toBlock: bounds[1],
    isFullHistory,
    foreignLogsIgnored: 0,
    foreignAddressSample: [],
  });

  const FULL_LAUNCH_SCAN = {
    fromBlock: EARLIEST_DEPLOYMENT_BLOCK,
    toBlock: 1_000_000,
    isFullHistory: true,
  };

  const summarise = (
    launches: LaunchRecord[],
    tradeScan: TradeScanResult,
    launchScan = FULL_LAUNCH_SCAN
  ) => summariseActivity({ launches, tradeScan, launchScan });

  test("distinct launch transactions are counted once each", () => {
    const a = summarise(
      [launch(hash(1), 0), launch(hash(2), 1), launch(hash(3), 2)],
      scan([], [])
    );
    assert.equal(a.launchTransactionCount, 3);
    assert.equal(a.uniqueTransactionCount, 3);
  });

  test("a repeated launch transaction hash counts once", () => {
    // Two launches in one transaction: a batch deploy, or simply the same log
    // reaching the deriver twice through an overlapping cached chunk.
    const a = summarise([launch(hash(1), 0), launch(hash(1), 1)], scan([], []));
    assert.equal(a.launchTransactionCount, 1, "the hash is the unit, not the record");
    assert.equal(a.uniqueTransactionCount, 1);
  });

  test("several trade events from one transaction count once", () => {
    // A router buy touching three curves emits three Bought logs in one tx.
    const a = summarise([], scan([trade(hash(9), 0), trade(hash(9), 1), trade(hash(9), 2)], []));
    assert.equal(a.tradeTransactionCount, 1);
    assert.equal(a.uniqueTransactionCount, 1, "3 events, 1 transaction");
  });

  test("a trade and a lifecycle event sharing a transaction count once globally", () => {
    // The real case: the buy that completes the curve emits Bought and
    // CurveCompleted in the same transaction.
    const a = summarise([], scan([trade(hash(9))], [lifecycle(hash(9))]));
    assert.equal(a.tradeTransactionCount, 1);
    assert.equal(a.lifecycleTransactionCount, 1);
    assert.equal(a.uniqueTransactionCount, 1, "must be the union, not the sum");
    assert.equal(a.sharedAcrossCategories, 1, "the overlap must be reported, not hidden");
  });

  test("a launch and a curve event sharing a transaction count once globally", () => {
    // A launch with a non-zero initialBuy: TokenLaunched plus the first Bought.
    const a = summarise([launch(hash(5))], scan([trade(hash(5))], []));
    assert.equal(a.launchTransactionCount, 1);
    assert.equal(a.tradeTransactionCount, 1);
    assert.equal(a.uniqueTransactionCount, 1);
    assert.equal(a.sharedAcrossCategories, 1);
  });

  test("the platform total is the union of the categories, never their sum", () => {
    // 3 launches, 4 trade txs, 2 lifecycle txs, with hash(3) and hash(4) shared.
    const a = summarise(
      [launch(hash(1), 0), launch(hash(2), 1), launch(hash(3), 2)],
      scan(
        [trade(hash(3)), trade(hash(4)), trade(hash(5)), trade(hash(6))],
        [lifecycle(hash(4)), lifecycle(hash(7))]
      )
    );
    assert.equal(a.launchTransactionCount, 3);
    assert.equal(a.tradeTransactionCount, 4);
    assert.equal(a.lifecycleTransactionCount, 2);
    const naiveSum =
      a.launchTransactionCount + a.tradeTransactionCount + a.lifecycleTransactionCount;
    assert.equal(naiveSum, 9);
    assert.equal(a.uniqueTransactionCount, 7, "hashes 1..7, each exactly once");
    assert.equal(a.sharedAcrossCategories, naiveSum - a.uniqueTransactionCount);
  });

  test("different transaction hashes are counted separately", () => {
    const a = summarise([], scan([trade(hash(1)), trade(hash(2)), trade(hash(3))], []));
    assert.equal(a.uniqueTransactionCount, 3);
    assert.equal(a.sharedAcrossCategories, 0);
  });

  test("normalisation folds case and a missing prefix, and nothing else", () => {
    const canonical = hash(0xabc);
    const variants = [canonical, canonical.toUpperCase(), `  ${canonical}  `, canonical.slice(2)];
    for (const v of variants) {
      assert.equal(normalizeTxHash(v), canonical, `"${v}" must normalise to the canonical form`);
    }
    // ... and a hash that differs by one nibble must stay distinct.
    assert.notEqual(normalizeTxHash(hash(0xabc)), normalizeTxHash(hash(0xabd)));
  });

  test("normalisation creates neither duplicates nor misses in the count", () => {
    const canonical = hash(0xabc);
    const a = summarise(
      [launch(canonical.toUpperCase())],
      scan([trade(canonical.slice(2)), trade(` ${canonical} `)], [lifecycle(canonical)])
    );
    assert.equal(a.uniqueTransactionCount, 1, "four spellings of one hash are one transaction");
    assert.equal(a.unusableTransactionHashes, 0, "every spelling was usable");

    // Two genuinely different hashes must not be folded together by trimming.
    const b = summarise([], scan([trade(hash(1)), trade(hash(2))], []));
    assert.equal(b.uniqueTransactionCount, 2);
  });

  test("an unusable transaction hash is reported, never silently counted or dropped", () => {
    const a = summarise([], scan([trade("0xnothex"), trade(""), trade(hash(1))], []));
    assert.equal(a.tradeTransactionCount, 1, "only the real hash counts");
    assert.equal(a.uniqueTransactionCount, 1);
    assert.equal(a.unusableTransactionHashes, 2, "the rejects must surface in the artifact");
    for (const bad of [null, undefined, 42, {}, "0x", `${hash(1)}0`]) {
      assert.equal(normalizeTxHash(bad), null, `${String(bad)} is not a transaction hash`);
    }
  });

  test("a windowed curve scan cannot be presented as a full-history metric", () => {
    const windowed = summarise(
      [launch(hash(1))],
      scan([trade(hash(2))], [], false, [900_000, 1_000_000])
    );
    assert.equal(windowed.isFullHistory, false, "one windowed leg makes the whole metric windowed");
    assert.equal(windowed.curveScan.isFullHistory, false);
    assert.equal(windowed.launchScan.isFullHistory, true, "the launch leg is still full history");
    assert.deepEqual(
      [windowed.curveScan.fromBlock, windowed.curveScan.toBlock],
      [900_000, 1_000_000],
      "the bounds must travel with the number"
    );

    const full = summarise([launch(hash(1))], scan([trade(hash(2))], [], true));
    assert.equal(full.isFullHistory, true);

    // And a full-history curve scan cannot rescue a windowed launch scan either.
    const windowedLaunches = summarise([launch(hash(1))], scan([trade(hash(2))], [], true), {
      fromBlock: 900_000,
      toBlock: 1_000_000,
      isFullHistory: false,
    });
    assert.equal(windowedLaunches.isFullHistory, false);
  });

  test("a windowed run's artifact carries the warning, and a full one does not", () => {
    const outputsSrc = fs.readFileSync(new URL("../src/emit/outputs.ts", import.meta.url), "utf8");
    const emitter = outputsSrc.slice(
      outputsSrc.indexOf("export function emitActivity"),
      outputsSrc.indexOf("export function emitFees")
    );
    assert.match(
      emitter,
      /activity\.isFullHistory\s*[\r\n\s]*\?\s*null/,
      "a full-history run must not carry a warning it does not deserve"
    );
    assert.match(emitter, /NOT A LIFETIME TOTAL/,
      "a windowed run must say so in the artifact itself");
    assert.match(outputsSrc, /## Indexed transactions/,
      "the markdown summary must show the metric and its scope");
  });

  test("empty datasets return zero rather than throwing or guessing", () => {
    const a = summarise([], scan([], []));
    assert.equal(a.uniqueTransactionCount, 0);
    assert.equal(a.launchTransactionCount, 0);
    assert.equal(a.tradeTransactionCount, 0);
    assert.equal(a.lifecycleTransactionCount, 0);
    assert.equal(a.sharedAcrossCategories, 0);
    assert.equal(a.unusableTransactionHashes, 0);
  });

  test("the published scope names its surfaces and discloses what it excludes", () => {
    const a = summarise([], scan([], []));
    assert.equal(a.scope, "launch-and-curve-events", "the scope is not 'all transactions'");
    for (const ev of [
      "TokenLaunched", "TokenLaunchedQuoted", "Bought", "Sold",
      "CurveCompleted", "Graduated", "CreatorFeesForwarded",
    ]) {
      assert.ok(a.includedEventSurfaces.includes(ev), `${ev} must be listed as included`);
    }
    const exclusions = a.exclusions.join(" ");
    assert.match(exclusions, /post-graduation/i, "DEX trading after graduation must be disclosed");
    assert.match(exclusions, /burn/i, "the separately-scoped burn scan must be disclosed");
    assert.match(exclusions, /LaunchFeesClaimed/, "the factory event we skip must be disclosed");
    assert.match(exclusions, /not configured|unconfigured/i,
      "silent incompleteness from an unconfigured factory must be disclosed");
    assert.doesNotMatch(
      a.definition,
      /\b(all|total|every) (vibe|vibe\/vibe|protocol)? ?transactions\b/i,
      "the definition must not claim total protocol coverage"
    );
  });
});
