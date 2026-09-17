import { createPublicClient, http, type PublicClient } from "viem";
import { defineChain } from "viem";
import { config, assertTestnet, TESTNET_CHAIN_ID } from "../../config/network.js";
import { SHARED } from "../../config/factories.js";
import { sanitizeErrorMessage } from "./redact.js";

export const robinhoodTestnet = defineChain({
  id: TESTNET_CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  blockExplorers: {
    default: { name: "Blockscout", url: config.explorerBase },
  },
  contracts: { multicall3: { address: SHARED.multicall3 } },
  testnet: true,
});

let _client: PublicClient | null = null;

export function client(): PublicClient {
  if (!_client) {
    _client = createPublicClient({
      chain: robinhoodTestnet,
      transport: http(config.rpcUrl, {
        // viem-level retry is disabled; we do our own accounting in withRetry so
        // the stats are honest and the backoff is visible in the logs.
        retryCount: 0,
        timeout: 60_000,
        batch: false,
      }),
    }) as PublicClient;
  }
  return _client;
}

export const stats = {
  rpcCalls: 0,
  retries: 0,
  failures: 0,
  chunkSplits: 0,
  startedAt: Date.now(),
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Message fragments that mean "your query was too big", not "the node is broken".
 *
 * Two DISTINCT limits exist on this RPC and both had to be discovered by
 * hitting them, and neither is documented anywhere:
 *
 *   1. a TIME limit:  "log query timed out" (a 1M-block span triggers it)
 *   2. a COUNT limit: "logs matched by query exceeds limit of 10000"
 *
 * (2) is the binding constraint for curve events. In a busy region the chain
 * produces ~360 curve logs per 3,000 blocks, so a topic-only trade scan hits the
 * 10k cap after roughly 25-30k blocks, well inside a span that (1) would allow.
 * An indexer tuned only against the block-range limit will fail in production.
 */
const RANGE_ERRORS = [
  "log query timed out",
  "exceeds limit of",
  "query returned more than",
  "response size exceeded",
  "too many results",
  "exceed maximum block range",
  "request entity too large",
  "limit exceeded",
];

export function isRangeError(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err).toLowerCase();
  return RANGE_ERRORS.some((f) => m.includes(f));
}

/**
 * "metadata is not found" / "missing trie node" mean the node has pruned the
 * state you asked for. Retrying cannot help: this RPC is not an archive node.
 */
export function isPrunedStateError(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err).toLowerCase();
  return m.includes("metadata is not found") || m.includes("missing trie node");
}

/**
 * Retry with exponential backoff + jitter, plus a fixed politeness delay before
 * every call. We are a guest on shared public infrastructure; the operator's
 * Terms explicitly prohibit probing or overloading the service.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts: { retries?: number; onRangeError?: () => void } = {}
): Promise<T> {
  const retries = opts.retries ?? config.maxRetries;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (config.requestDelayMs > 0) await sleep(config.requestDelayMs);
      stats.rpcCalls++;
      return await fn();
    } catch (err) {
      lastErr = err;

      // Not worth retrying: the data is gone, not flaky.
      if (isPrunedStateError(err)) throw err;

      // Caller knows how to shrink the request; hand it straight back without
      // burning retries, since backing off cannot make an over-large query smaller.
      if (isRangeError(err)) {
        opts.onRangeError?.();
        throw err;
      }

      if (attempt === retries) break;
      stats.retries++;
      const backoff =
        config.retryBaseMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      console.warn(
        `  ! ${label} failed (attempt ${attempt + 1}/${retries + 1}): ` +
          `${sanitizeErrorMessage(err, 110)}, retrying in ${backoff}ms`
      );
      await sleep(backoff);
    }
  }

  stats.failures++;
  throw lastErr;
}

export async function getHead(): Promise<number> {
  const c = client();
  const id = await withRetry(() => c.getChainId(), "getChainId");
  assertTestnet(id);
  const bn = await withRetry(() => c.getBlockNumber(), "getBlockNumber");
  return Number(bn);
}

export function statsSummary() {
  const secs = (Date.now() - stats.startedAt) / 1000;
  return {
    rpcCalls: stats.rpcCalls,
    retries: stats.retries,
    failures: stats.failures,
    chunkSplits: stats.chunkSplits,
    elapsedSeconds: Math.round(secs),
    callsPerSecond: secs > 0 ? Number((stats.rpcCalls / secs).toFixed(2)) : 0,
  };
}
