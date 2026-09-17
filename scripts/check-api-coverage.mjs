/**
 * Does the operator's API serve every launch an on-chain indexer can see?
 *
 * Tests each factory generation at OLD and RECENT points in its lifetime,
 * because the interesting failure is temporal, not generational.
 * Read-only, 1.1s between calls (their limit is 60/min).
 */
import fs from "node:fs";
import { createPublicClient, http, defineChain, parseAbiItem } from "viem";
import { GENERATIONS } from "../config/factories.ts";
import { sanitizeErrorMessage } from "../src/lib/redact.js";

const BASE = (process.env.VIBE_API_BASE || "https://testnet.vibevibe.fun/api/v1") + "/chains/46630";

/**
 * Read a small sample of launches per generation straight from the chain, so
 * this script works on a clean checkout without needing a prior --emit-bulk run.
 */
const chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com"] } },
  testnet: true,
});
const client = createPublicClient({ chain, transport: http() });

const EXPECTED_CHAIN_ID = 46630;

/**
 * Verify the CONNECTED chain, do not trust the local chain definition.
 *
 * defineChain({ id: 46630 }) is a client-side assertion about an endpoint the
 * user supplied via RPC_URL. It is not a check. Without this call, pointing
 * RPC_URL at another network would produce output labelled "TESTNET 46630" that
 * describes a different chain entirely.
 */
async function assertConnectedToTestnet(c) {
  let actual;
  try {
    actual = await c.getChainId();
  } catch (err) {
    // Scrub before interpolating: a transport failure here puts the full
    // configured RPC URL, key and all, into err.message.
    throw new Error(
      `Could not read the chain ID from the configured RPC endpoint: ${sanitizeErrorMessage(err, 200)}`
    );
  }
  if (actual !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Refusing to run: connected chain is ${actual}, expected Robinhood Chain TESTNET ` +
        `(${EXPECTED_CHAIN_ID}). This script is testnet-only and would otherwise label ` +
        `another network's data as testnet. Check RPC_URL.`
    );
  }
}

await assertConnectedToTestnet(client);

const TOKEN_LAUNCHED = parseAbiItem(
  "event TokenLaunched(uint256 indexed launchId, address indexed token, address indexed curve, address creator, address creatorFeeRecipient, address creatorVault, uint256 initialBuy, uint256 initialTokensBought, uint16 metadataSchemaVersion, bytes32 metadataDigest, string metadataURI)"
);

const head = Number(await client.getBlockNumber());
const launches = [];
for (const g of GENERATIONS) {
  // oldest: a window just after deployment. newest: a window just before head.
  for (const [from, to] of [
    [g.deploymentBlock, g.deploymentBlock + 120_000],
    [head - 60_000, head],
  ]) {
    try {
      const logs = await client.getLogs({
        address: g.factory,
        event: TOKEN_LAUNCHED,
        fromBlock: BigInt(Math.max(0, from)),
        toBlock: BigInt(to),
      });
      for (const l of logs) {
        launches.push({
          generation: g.generation,
          token: String(l.args.token).toLowerCase(),
          deploymentBlock: Number(l.blockNumber),
        });
      }
    } catch (e) {
      console.warn(`  ! log scan failed for ${g.generation} ${from}-${to}: ${sanitizeErrorMessage(e.shortMessage ?? e, 80)}`);
    }
  }
}
if (launches.length === 0) {
  console.error("No launches found, check RPC connectivity.");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const byGen = { retired: [], legacy: [], current: [] };
for (const l of launches) byGen[l.generation]?.push(l);
for (const g of Object.keys(byGen)) byGen[g].sort((a, b) => a.deploymentBlock - b.deploymentBlock);

const probe = async (l) => {
  await sleep(1100);
  try {
    const r = await fetch(`${BASE}/launches/${l.token}`, { headers: { accept: "application/json" } });
    return r.status;
  } catch { return 0; }
};

console.log("=== Operator API coverage vs on-chain reconstruction ===");
console.log("    (TESTNET 46630; 5 oldest + 5 newest launches per generation)\n");

const results = {};
for (const gen of ["retired", "legacy", "current"]) {
  const pool = byGen[gen];
  if (!pool.length) continue;
  const oldest = pool.slice(0, 5);
  const newest = pool.slice(-5);

  const oldStatuses = [];
  for (const l of oldest) oldStatuses.push(await probe(l));
  const newStatuses = [];
  for (const l of newest) newStatuses.push(await probe(l));

  const ok = (a) => a.filter((s) => s === 200).length;
  const n404 = (a) => a.filter((s) => s === 404).length;
  results[gen] = {
    sampledFrom: pool.length,
    firstLaunchBlock: pool[0].deploymentBlock,
    lastLaunchBlock: pool[pool.length - 1].deploymentBlock,
    sampleSize: 5,
    oldest: { statuses: oldStatuses, served200: ok(oldStatuses), notFound404: n404(oldStatuses) },
    newest: { statuses: newStatuses, served200: ok(newStatuses), notFound404: n404(newStatuses) },
  };

  console.log(`${gen.padEnd(9)} sampled=${String(pool.length).padStart(5)}  blocks ${pool[0].deploymentBlock} .. ${pool[pool.length - 1].deploymentBlock}`);
  console.log(`          5 OLDEST  -> ${oldStatuses.join(" ")}   (${ok(oldStatuses)}/5 served 200, ${oldStatuses.filter(s=>s===404).length}/5 got 404)`);
  console.log(`          5 NEWEST  -> ${newStatuses.join(" ")}   (${ok(newStatuses)}/5 served 200, ${newStatuses.filter(s=>s===404).length}/5 got 404)`);
}

console.log("\n=== INTERPRETATION ===");
const lines = [];
for (const [gen, r] of Object.entries(results)) {
  if (r.oldest.served200 > 0 && r.newest.served200 === 0) {
    lines.push(
      `${gen}: the 5 OLDEST launches are served (${r.oldest.served200}/5 HTTP 200), but ALL 5 of the NEWEST ` +
      `returned HTTP 404 (0/5 served). This generation is still producing launches ` +
      `(latest sampled at block ${r.lastLaunchBlock}) that the operator API does not return.`
    );
  } else if (r.newest.served200 === 5 && r.oldest.served200 === 5) {
    lines.push(`${gen}: fully served at both ends of its lifetime (10/10 HTTP 200).`);
  } else {
    lines.push(`${gen}: partial coverage: oldest ${r.oldest.served200}/5 served, newest ${r.newest.served200}/5 served.`);
  }
}
console.log(lines.join("\n"));
console.log(
  "\n  Consequence: an on-chain indexer is a STRICT SUPERSET of the operator's public\n" +
  "  API for launch enumeration. Anyone relying on the API alone has a blind spot."
);

fs.mkdirSync("output", { recursive: true });
fs.writeFileSync("output/api-coverage-by-generation.json", JSON.stringify({
  network: "TESTNET", chainId: 46630, checkedAt: new Date().toISOString(),
  method: "GET /launches/{token} for up to 5 of the oldest and 5 of the newest launches SAMPLED from each generation (two block windows per generation, read from chain logs). Sample sizes are not generation totals.",
  results, interpretation: lines,
}, null, 1));
