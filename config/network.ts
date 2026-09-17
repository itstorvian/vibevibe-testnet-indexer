import "dotenv/config";

/**
 * NETWORK CONFIGURATION: Robinhood Chain TESTNET only.
 *
 * TESTNET. Everything this indexer reads is test-value. The Vibe/Vibe deployment
 * has no mainnet presence: the operator's API returns UNSUPPORTED_CHAIN for
 * chain 4663, and their Terms state that chain ID 4663 is disabled. Mainnet
 * metadata is recorded here for completeness and is deliberately NOT wired up.
 */

export const TESTNET_CHAIN_ID = 46630;

/** Recorded for reference only. No Vibe/Vibe deployment exists here. */
export const MAINNET_CHAIN_ID = 4663;

export const DEFAULT_RPC_URL = "https://rpc.testnet.chain.robinhood.com";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const config = {
  chainId: TESTNET_CHAIN_ID,
  network: "robinhood-chain-testnet" as const,
  label: "TESTNET",

  /**
   * RPC endpoint. Set RPC_URL in your environment (see .env.example).
   *
   * The public endpoint works with no key but is rate-limited and, critically,
   * is NOT an archive node; see `observedStateRetentionBlocks`. A keyed
   * provider is strongly recommended for anything beyond experimentation.
   *
   * Never commit a keyed URL. `.env` is gitignored; `.env.example` is not.
   */
  rpcUrl: process.env.RPC_URL || DEFAULT_RPC_URL,

  explorerBase: "https://explorer.testnet.chain.robinhood.com",

  /**
   * Operator's public API. OPTIONAL CROSS-CHECK ONLY, never a source of truth,
   * and off unless --compare-api is passed.
   *
   * Their Terms prohibit scraping to build a competing dataset and prohibit
   * probing or overloading the service, so the comparison path makes a handful
   * of read-only GETs with a delay between them and nothing more.
   */
  apiBase: process.env.VIBE_API_BASE || "https://testnet.vibevibe.fun/api/v1",

  /**
   * eth_getLogs chunk size, in blocks.
   *
   * TWO undocumented limits exist on the public RPC and both were found by
   * hitting them:
   *   - a TIME limit    ("log query timed out"): a 1,000,000-block span fails
   *   - a RESULT limit  ("logs matched by query exceeds limit of 10000")
   *
   * The result limit is the binding one for dense event ranges. Never assume a
   * fixed block range is safe; the scanner halves adaptively on either error.
   */
  logChunkBlocks: envInt("LOG_CHUNK_BLOCKS", 20_000),
  minLogChunkBlocks: 2_000,

  /** Politeness. The public endpoint is shared infrastructure. */
  requestDelayMs: envInt("REQUEST_DELAY_MS", 150),
  maxRetries: envInt("MAX_RETRIES", 5),
  /** Base for exponential backoff, in ms. Doubles per attempt, plus jitter. */
  retryBaseMs: envInt("RETRY_BASE_MS", 600),

  /**
   * MEASURED, NOT ASSUMED. The public RPC is not an archive node:
   *   eth_call at head-4,096   -> OK
   *   eth_call at head-16,384  -> "metadata is not found"
   *   eth_call at head-65,536  -> "missing trie node"
   *
   * So every contract read is effectively HEAD-ONLY, and historical state
   * cannot be reconstructed. Anything historical must come from events.
   * See docs/known-limitations.md.
   */
  observedStateRetentionBlocks: 4_096,
};

export function assertTestnet(chainId: number): void {
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(
      `Refusing to run: connected chain ${chainId} is not Robinhood Chain TESTNET ` +
        `(${TESTNET_CHAIN_ID}). This indexer is testnet-only; the Vibe/Vibe deployment ` +
        `has no mainnet presence.`
    );
  }
}
