import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../..");
export const DATA_DIR = path.join(ROOT, "data");
export const RAW_DIR = path.join(DATA_DIR, "raw");
export const CACHE_DIR = path.join(DATA_DIR, "cache");
export const OUTPUT_DIR = path.join(ROOT, "output");
export const DOCS_DIR = path.join(ROOT, "docs");

for (const d of [DATA_DIR, RAW_DIR, CACHE_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

/** JSON.stringify that survives bigint. Raw chain data is full of them. */
/**
 * BULK OUTPUT SWITCH.
 *
 * A full run covers ~77,000 launches. Writing every record to a monolithic JSON
 * file produces ~400 MB, which is hostile as a default for a public tool (and
 * exceeds Node's max string length unless streamed). Bulk artifacts are
 * therefore OPT-IN via --emit-bulk; small summary artifacts always emit.
 */
let BULK_ENABLED = false;
export function setBulkOutputEnabled(v: boolean): void { BULK_ENABLED = v; }
export function bulkOutputEnabled(): boolean { return BULK_ENABLED; }

/** Write only when bulk output is enabled. Returns whether it wrote. */
export function writeBulk(file: string, write: () => void): boolean {
  if (!BULK_ENABLED) return false;
  write();
  return true;
}

/**
 * Raw, unjoined chain dumps under `data/raw/`. Useful for debugging and for
 * re-deriving without re-scanning, but large (a full launch dump is ~60 MB), so
 * they follow the same opt-in switch as the bulk outputs.
 */
export function writeRaw(file: string, value: unknown, indent = 0): boolean {
  if (!BULK_ENABLED) return false;
  // A full-history curve scan dumps millions of rows here, and JSON.stringify
  // over the whole array throws "Invalid string length" past ~537 MB: mid-run,
  // after hours of scanning. Arrays are therefore streamed; every other raw
  // artifact is small enough for the ordinary path.
  if (Array.isArray(value)) writeJsonArray(file, value);
  else writeJson(file, value, indent);
  return true;
}

export function stringify(value: unknown, indent = 0): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    indent
  );
}

export function writeJson(file: string, value: unknown, indent = 1): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringify(value, indent));
}

/**
 * Consistent number formatting regardless of the host machine's locale.
 * Without this, a Turkish-locale machine renders 77088 as "77.088", which reads
 * as seventy-seven in an English report.
 */
export function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * STREAMING JSON ARRAY WRITER.
 *
 * 77k project records with full provenance blow past Node's maximum string
 * length, so JSON.stringify on the whole document throws
 * "RangeError: Invalid string length". We stream the array element by element
 * instead, which also keeps peak memory flat.
 */
export function writeJsonStreamed(
  file: string,
  header: Record<string, unknown>,
  arrayKey: string,
  items: readonly unknown[]
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "w");
  try {
    const headerJson = stringify(header, 1);
    // Splice the streamed array in just before the closing brace.
    fs.writeSync(fd, headerJson.slice(0, headerJson.lastIndexOf("}")).replace(/\s*$/, ""));
    fs.writeSync(fd, `,\n "${arrayKey}": [\n`);
    const CHUNK = 500;
    let buf = "";
    for (let i = 0; i < items.length; i++) {
      buf += (i > 0 ? ",\n" : "") + stringify(items[i], 0);
      if (i % CHUNK === CHUNK - 1) {
        fs.writeSync(fd, buf);
        buf = "";
      }
    }
    if (buf) fs.writeSync(fd, buf);
    fs.writeSync(fd, "\n ]\n}\n");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A bare JSON array, streamed. Same reason as `writeJsonStreamed`: the raw
 * dumps outgrew Node's maximum string length once trades were scanned over
 * full history rather than a window.
 */
export function writeJsonArray(file: string, items: readonly unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "w");
  try {
    fs.writeSync(fd, "[");
    let buf = "";
    for (let i = 0; i < items.length; i++) {
      buf += (i > 0 ? "," : "") + stringify(items[i], 0);
      if (i % 500 === 499) {
        fs.writeSync(fd, buf);
        buf = "";
      }
    }
    if (buf) fs.writeSync(fd, buf);
    fs.writeSync(fd, "]");
  } finally {
    fs.closeSync(fd);
  }
}

/** Newline-delimited JSON: the format a real downstream consumer would want. */
export function writeNdjson(file: string, items: readonly unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "w");
  try {
    let buf = "";
    for (let i = 0; i < items.length; i++) {
      buf += stringify(items[i], 0) + "\n";
      if (i % 500 === 499) {
        fs.writeSync(fd, buf);
        buf = "";
      }
    }
    if (buf) fs.writeSync(fd, buf);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * CHUNK CACHE: the reason repeated runs don't re-hammer the RPC.
 *
 * Each [from,to] log-scan chunk is cached under a key that includes the scan
 * name and the exact block bounds, so a resumed or repeated run replays from
 * disk. Chunks are immutable once written: finalised history on this chain does
 * not change, and we never cache a chunk that touches the unfinalised head.
 */
export function chunkPath(scan: string, from: number, to: number): string {
  return path.join(CACHE_DIR, scan, `${from}-${to}.json`);
}

export function readChunk<T>(scan: string, from: number, to: number): T[] | null {
  return readJson<T[]>(chunkPath(scan, from, to));
}

export function writeChunk<T>(scan: string, from: number, to: number, rows: T[]): void {
  writeJson(chunkPath(scan, from, to), rows, 0);
}

export interface Checkpoint {
  scan: string;
  fromBlock: number;
  lastCompletedBlock: number;
  updatedAt: string;
  rowCount: number;
}

export function checkpointPath(scan: string): string {
  return path.join(CACHE_DIR, `${scan}.checkpoint.json`);
}

export function readCheckpoint(scan: string): Checkpoint | null {
  return readJson<Checkpoint>(checkpointPath(scan));
}

export function writeCheckpoint(cp: Checkpoint): void {
  writeJson(checkpointPath(cp.scan), { ...cp, updatedAt: new Date().toISOString() }, 1);
}