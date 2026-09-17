/**
 * Targeted verification of the buyback/burn model against tokens KNOWN to have
 * burns, plus contrast cases. Standalone: does not depend on a full index run.
 *
 * Read-only. TESTNET 46630.
 */
import { createPublicClient, http, parseAbi, defineChain } from "viem";
import { sanitizeErrorMessage } from "../src/lib/redact.js";
import fs from "node:fs";

const chain = defineChain({
  id: 46630, name: "rh-testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});
const c = createPublicClient({ chain, transport: http() });

const EXPECTED_CHAIN_ID = 46630;

/**
 * Verify the CONNECTED chain, do not trust the local chain definition.
 *
 * defineChain({ id: 46630 }) is a client-side assertion about an endpoint the
 * user supplied via RPC_URL. It is not a check. Without this call, pointing
 * RPC_URL at another network would produce output labelled "TESTNET 46630" that
 * describes a different chain entirely.
 */
async function assertConnectedToTestnet(client) {
  let actual;
  try {
    actual = await client.getChainId();
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

const DEAD = "0x000000000000000000000000000000000000dEaD";
const abi = parseAbi([
  "function name() view returns (string)", "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function transfersUnlocked() view returns (bool)", "function curve() view returns (address)",
]);
const curveAbi = parseAbi([
  "function creatorVault() view returns (address)", "function graduated() view returns (bool)",
  "function complete() view returns (bool)",
]);

// Tokens observed with non-zero buyback activity on testnet 46630.
// Replace these with your own if they graduate or the testnet resets.
const KNOWN_BURNERS = [
  "0x2f8ef4a7bc37cbd49d747e18e330ad757dc66411",
  "0x0dca868d08971ebdde344b7797f67ff230bf0ba3",
  "0x960c3692552e66dbb1c0621b2c85a47c474a0e29",
  "0x8855b1ebeea43bc6eed21336c0d49aed6016d4fb", // observed holding tokens in its vault, unburned
];

const f = (v) => (Number(v) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 });
let violations = 0, withBurn = 0, withHeld = 0;

await assertConnectedToTestnet(c);

console.log("=== BUYBACK / BURN MODEL VERIFICATION (TESTNET 46630) ===\n");
console.log("Model under test:");
console.log("  supplyCommitted = balanceOf(0x...dEaD) + balanceOf(creatorVault)");
console.log("  invariant: transfersUnlocked==false  =>  balanceOf(0x...dEaD) == 0");
console.log("             (a transfer to the burn address would revert TransfersLocked)\n");

const rows = [];
for (const t of KNOWN_BURNERS) {
  try {
    const curve = await c.readContract({ address: t, abi, functionName: "curve" });
    const [name, sym, sup, dead, unlocked, vault] = await Promise.all([
      c.readContract({ address: t, abi, functionName: "name" }),
      c.readContract({ address: t, abi, functionName: "symbol" }),
      c.readContract({ address: t, abi, functionName: "totalSupply" }),
      c.readContract({ address: t, abi, functionName: "balanceOf", args: [DEAD] }),
      c.readContract({ address: t, abi, functionName: "transfersUnlocked" }),
      c.readContract({ address: curve, abi: curveAbi, functionName: "creatorVault" }),
    ]);
    const held = await c.readContract({ address: t, abi, functionName: "balanceOf", args: [vault] });
    const graduated = await c.readContract({ address: curve, abi: curveAbi, functionName: "graduated" });
    const committed = dead + held;
    const violated = unlocked === false && dead > 0n;
    if (violated) violations++;
    if (dead > 0n) withBurn++;
    if (held > 0n) withHeld++;
    rows.push({ t, name, sym, unlocked, graduated, sup, dead, held, committed, violated });
  } catch (e) {
    console.log(`  ! ${t}: ${sanitizeErrorMessage(e.shortMessage ?? e, 80)}`);
  }
}

for (const r of rows) {
  console.log(`${r.name} (${r.sym})`);
  console.log(`  token             ${r.t}`);
  console.log(`  graduated         ${r.graduated}   transfersUnlocked ${r.unlocked}`);
  console.log(`  burned @ 0xdEaD   ${f(r.dead)}  (${(Number(r.dead) * 100 / Number(r.sup)).toFixed(3)}% of supply)`);
  console.log(`  held in vault     ${f(r.held)}`);
  console.log(`  COMMITTED TOTAL   ${f(r.committed)}  (${(Number(r.committed) * 100 / Number(r.sup)).toFixed(3)}% of supply)`);
  console.log(`  naive-only-burn would report ${f(r.dead)} -> ` +
    (r.held > 0n ? `UNDER-REPORTS by ${f(r.held)}` : `matches (nothing held)`));
  console.log(`  invariant         ${r.violated ? "VIOLATED" : "holds"}\n`);
}

console.log("=== RESULT ===");
console.log(`  tokens examined:        ${rows.length}`);
console.log(`  with burns at 0xdEaD:   ${withBurn}`);
console.log(`  with vault holdings:    ${withHeld}`);
console.log(`  invariant violations:   ${violations}`);
console.log(violations === 0 && withBurn > 0
  ? "\n  PASS: burns are real, and no locked token holds a burn balance."
  : violations > 0
    ? "\n  FAIL: a locked token has a non-zero burn balance; the model is wrong."
    : "\n  INCONCLUSIVE: no burns in this sample; model untested.");

fs.mkdirSync("output", { recursive: true });
fs.writeFileSync("output/burn-model-verification.json", JSON.stringify({
  network: "TESTNET", chainId: 46630, verifiedAt: new Date().toISOString(),
  model: "supplyCommitted = balanceOf(0x...dEaD) + balanceOf(creatorVault)",
  invariant: "transfersUnlocked==false => balanceOf(0x...dEaD)==0",
  tokensExamined: rows.length, withBurn, withHeld, violations,
  verdict: violations === 0 && withBurn > 0 ? "PASS" : violations > 0 ? "FAIL" : "INCONCLUSIVE",
  rows: rows.map(r => ({
    token: r.t, name: r.name, symbol: r.sym, graduated: r.graduated,
    transfersUnlocked: r.unlocked, totalSupply: r.sup.toString(),
    burnedAtDead: r.dead.toString(), heldInVault: r.held.toString(),
    committed: r.committed.toString(), invariantViolated: r.violated,
  })),
}, null, 1));
