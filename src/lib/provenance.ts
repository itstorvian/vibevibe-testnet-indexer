/**
 * PROVENANCE WRAPPER
 *
 * Every non-trivial field in the output carries where it came from and how much
 * we trust it. The point of the whole exercise is distinguishing "I reconstructed
 * this from the chain" from "the operator told me this", so the distinction is
 * encoded in the data rather than the prose.
 */

export type Source =
  /** Decoded from a contract event log. Strongest: immutable, verifiable by anyone. */
  | "onchain_event"
  /** eth_call against a deployed contract. Strong, but HEAD-ONLY on this RPC. */
  | "contract_read"
  /** The operator's REST API. Convenience/comparison ONLY. Never authoritative. */
  | "vibe_api"
  /** Computed from other fields in this record. */
  | "derived"
  /** Constant from the verified address book / economics config. */
  | "config"
  /** Deliberately absent. `value` is null and `note` says why. */
  | "unavailable";

export type Confidence = "high" | "medium" | "low" | "none";

export interface Provenance<T> {
  value: T | null;
  source: Source;
  confidence: Confidence;
  /** Required when value is null or confidence is below "high". */
  note?: string;
}

export function fromEvent<T>(value: T, note?: string): Provenance<T> {
  return { value, source: "onchain_event", confidence: "high", ...(note ? { note } : {}) };
}

export function fromRead<T>(value: T, note?: string): Provenance<T> {
  return { value, source: "contract_read", confidence: "high", ...(note ? { note } : {}) };
}

export function derived<T>(value: T, confidence: Confidence = "high", note?: string): Provenance<T> {
  return { value, source: "derived", confidence, ...(note ? { note } : {}) };
}

export function fromConfig<T>(value: T, note?: string): Provenance<T> {
  return { value, source: "config", confidence: "high", ...(note ? { note } : {}) };
}

/**
 * The honest null. Requires a reason: "we never invent missing data" is only
 * meaningful if the absence is explained.
 */
export function unavailable<T = never>(note: string): Provenance<T> {
  return { value: null, source: "unavailable", confidence: "none", note };
}

/**
 * Partial reconstruction: the value is real but incomplete, e.g. a volume total
 * computed over a bounded block window rather than full history.
 */
export function partial<T>(value: T, note: string): Provenance<T> {
  return { value, source: "derived", confidence: "medium", note };
}

/** Flatten a provenance record to plain values, for CSV output. */
export function flatten(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v && typeof v === "object" && "source" in (v as object) && "value" in (v as object)) {
      out[key] = (v as Provenance<unknown>).value;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flatten(v as Record<string, unknown>, key));
    } else if (Array.isArray(v)) {
      out[key] = v.length;
    } else {
      out[key] = v;
    }
  }
  return out;
}
