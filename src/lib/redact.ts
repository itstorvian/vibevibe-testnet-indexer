/**
 * RPC endpoint sanitization.
 *
 * A keyed RPC URL is a credential. Providers put the secret in different
 * places, so there is no single field to strip:
 *
 *   https://provider.example/v2/SECRET      path segment
 *   https://x.quiknode.pro/SECRET/          path segment, different shape
 *   https://rpc.example.com/?apikey=SECRET  query value
 *   https://user:PASSWORD@rpc.example.com/  userinfo
 *
 * Rather than enumerate providers and hope the list stays complete, this
 * discards EVERYTHING that could carry a secret and keeps only the parts that
 * cannot: scheme, host and port. Path and query are collapsed to a marker that
 * records whether they were present, without revealing their contents.
 *
 * The consequence is deliberate: a non-secret path such as `/v2` is discarded
 * too. Losing a provider hint is an acceptable price for a rule that cannot be
 * defeated by a provider shape nobody anticipated.
 *
 * USE THE SANITIZED VALUE AT THE SOURCE. `RunMeta` stores `rpcEndpoint`, which
 * is already sanitized, instead of storing a raw URL and relying on every
 * emitter to remember to redact it. That ordering is what makes the guarantee
 * hold for artifacts that have not been written yet.
 */

/** Marker written in place of any path or query that was present. */
export const REDACTED = "<redacted>";

/** Returned when no endpoint was configured at all. */
export const NO_ENDPOINT = "<unset>";

/** Returned when the input cannot be parsed as a URL. */
export const UNPARSEABLE = "<unparseable-endpoint>";

/**
 * Reduce an RPC URL to a non-credential-bearing description of its endpoint.
 *
 * Guarantees, for any input:
 *   - no userinfo (username or password) survives
 *   - no path segment survives
 *   - no query string survives
 *   - no fragment survives
 *
 * What survives is the scheme, host, and non-default port only.
 */
export function sanitizeRpcUrl(raw: string | undefined | null): string {
  if (raw === undefined || raw === null) return NO_ENDPOINT;
  const trimmed = String(raw).trim();
  if (trimmed === "") return NO_ENDPOINT;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Do not echo the input back. A malformed string may still be a secret.
    return UNPARSEABLE;
  }

  // `URL` only exposes credentials via these two fields; clearing both removes
  // the userinfo component entirely from `url.host` onwards.
  const hasCredentials = url.username !== "" || url.password !== "";

  const hasPath = url.pathname !== "" && url.pathname !== "/";
  const hasQuery = url.search !== "";

  let out = `${url.protocol}//${url.host}`;
  if (hasPath) out += `/${REDACTED}`;
  if (hasQuery) out += `?${REDACTED}`;
  if (hasCredentials) out += ` (credentials removed)`;

  return out;
}

/**
 * Detection helper for tests and for the pre-emit assertion in the emitters.
 *
 * Returns true if a string still looks capable of carrying a credential, that
 * is: it contains userinfo, a query string, or a path beyond the root. A value
 * produced by `sanitizeRpcUrl` always returns false.
 */
export function looksCredentialBearing(value: string): boolean {
  if (value === NO_ENDPOINT || value === UNPARSEABLE) return false;
  // Strip the sanitizer's own markers before judging the remainder.
  const stripped = value
    .replace(` (credentials removed)`, "")
    .replace(`?${REDACTED}`, "")
    .replace(`/${REDACTED}`, "");
  let url: URL;
  try {
    url = new URL(stripped);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return true;
  if (url.search !== "") return true;
  if (url.pathname !== "" && url.pathname !== "/") return true;
  return false;
}

/**
 * ERROR TEXT SCRUBBING
 *
 * Transport errors are not tidy. viem embeds the request URL in `message`, and
 * that message gets persisted: `readError` in data/raw/token-state.json and
 * curve-state.json, `error` in protocol-state.json, `note` in the
 * always-emitted api-comparison.json. A keyed RPC URL reaching any of those is
 * the same leak class as M1, arriving by a different route.
 *
 * Slicing is not a defence. `String(err.message).slice(0, 120)` keeps the first
 * 120 characters, and viem puts "URL: <the url>" near the front, so truncation
 * preserves the secret rather than removing it. Scrub first, truncate second.
 */

/**
 * Every http(s) URL in a blob of text.
 *
 * The negated class stops at whitespace and at the punctuation that typically
 * closes a URL in prose or JSON, so a trailing quote, bracket or comma is not
 * swallowed into the match. A trailing period is swallowed, which is harmless:
 * it lands in the path, and the whole path is discarded anyway.
 */
const URL_IN_TEXT = /https?:\/\/[^\s"'`<>\]),]+/gi;

/**
 * Remove every credential-bearing URL from arbitrary text.
 *
 * Two passes, because neither alone is sufficient:
 *
 *   1. Generic URL replacement, so a provider or endpoint nobody anticipated,
 *      including one this process never configured, is still scrubbed.
 *   2. Literal replacement of known endpoint URLs, for an occurrence in a shape
 *      the generic pattern cannot match.
 *
 * `extraUrls` defaults to the configured RPC endpoint. Callers do not have to
 * remember to pass it, which is the point: the safe behaviour is the default.
 */
export function scrubCredentials(
  text: string,
  extraUrls: readonly string[] = [defaultEndpoint()]
): string {
  let out = String(text ?? "");

  // Pass 1: anything URL-shaped.
  //
  // URL_IN_TEXT stops at "<", so on already-scrubbed text it would otherwise
  // match the trailing slash of "https://host/<redacted>" and collapse it to
  // "https://host<redacted>". Detecting that case and leaving it alone makes
  // scrubbing idempotent, which matters because a message can pass through more
  // than once: an error carrying an already-scrubbed message, or a caller that
  // scrubs defensively before handing text on.
  out = out.replace(URL_IN_TEXT, (m, offset: number, whole: string) => {
    const rest = whole.slice(offset + m.length);
    if (rest.startsWith(REDACTED)) return m;
    return sanitizeRpcUrl(m);
  });

  // Pass 2: exact known endpoints, for occurrences the pattern cannot see.
  // Longest first, so a base URL does not partially replace a longer keyed URL
  // that contains it.
  const known = [...new Set(extraUrls.filter((u) => typeof u === "string" && u.length > 0))].sort(
    (a, b) => b.length - a.length
  );
  for (const url of known) {
    if (out.includes(url)) out = out.split(url).join(sanitizeRpcUrl(url));
  }

  return out;
}

/**
 * The configured RPC endpoint, read lazily and defensively.
 *
 * Read from the environment rather than importing the config module, so this
 * file stays dependency-free and safe to import from anywhere, including tests
 * that must not pull in dotenv side effects.
 */
function defaultEndpoint(): string {
  try {
    return process.env.RPC_URL ?? "";
  } catch {
    return "";
  }
}

/**
 * Turn a caught error into a message that is safe to persist.
 *
 * Scrubs BEFORE truncating. Returns a short, still-useful string: the failure
 * stays diagnosable, the credential does not survive.
 */
export function sanitizeErrorMessage(
  err: unknown,
  maxLength = 120,
  extraUrls?: readonly string[]
): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String((err as { message?: unknown })?.message ?? err ?? "");

  const scrubbed = extraUrls ? scrubCredentials(raw, extraUrls) : scrubCredentials(raw);
  return scrubbed.length > maxLength ? scrubbed.slice(0, maxLength) : scrubbed;
}
