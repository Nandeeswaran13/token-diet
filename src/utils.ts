/**
 * Inline JSON densifier.
 *
 * LLM prompts often embed structured blobs (`{"name":"John","age":30}`) that
 * spend tokens on braces, quotes, and repeated keys. {@link minifyJson} walks
 * a larger string, extracts balanced `{...}` / `[...]` slices that
 * `JSON.parse` accepts, and replaces each with a denser encoding **without**
 * touching the surrounding prose.
 *
 * Modes:
 * - `"compact"` (default): `JSON.stringify(value)` — safe, reversible, just
 *   strips insignificant whitespace.
 * - `"flatten"`: pipe-delimited cells (`name:John|age:30`) — denser, lossy.
 *
 * Invalid or unclosed JSON is left as-is. The function never throws.
 */

/** JSON value types we flatten as leaf cells. */
export type JsonPrimitive = string | number | boolean | null;

/** Options for {@link minifyJson}. */
export interface MinifyJsonOptions {
  /**
   * How to encode a parsed object/array.
   *
   * @default "compact"
   */
  mode?: "compact" | "flatten";
}

function isPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function renderPrimitive(value: JsonPrimitive): string {
  if (value === null) return "null";
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Flatten a parsed JSON value into dense `key:value` cells.
 *
 * - Nested objects become dotted paths: `{user:{name:"A"}}` → `user.name:A`
 * - Arrays of primitives join with commas: `[1,2]` → `1,2`
 * - Arrays of objects join with semicolons; fields inside an object use `|`
 *
 * Returns one or more cells; callers typically `.join("|")`.
 */
export function flattenJsonValue(value: unknown, prefix = ""): string[] {
  if (isPrimitive(value)) {
    const cell = renderPrimitive(value);
    return [prefix ? `${prefix}:${cell}` : cell];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [prefix ? `${prefix}:[]` : "[]"];
    }

    const allPrimitive = value.every(isPrimitive);
    if (allPrimitive) {
      const joined = value.map((item) => renderPrimitive(item)).join(",");
      return [prefix ? `${prefix}:${joined}` : joined];
    }

    const objects = value.map((item) => flattenJsonValue(item, "").join("|"));
    const joined = objects.join(";");
    return [prefix ? `${prefix}:${joined}` : joined];
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return [prefix ? `${prefix}:{}` : "{}"];
    }
    const cells: string[] = [];
    for (const key of keys) {
      const next = prefix ? `${prefix}.${key}` : key;
      cells.push(...flattenJsonValue(value[key], next));
    }
    return cells;
  }

  // Unknown (e.g. a parsed JSON that somehow isn't a plain value).
  const fallback = String(value);
  return [prefix ? `${prefix}:${fallback}` : fallback];
}

/**
 * Encode a parsed JSON value according to {@link MinifyJsonOptions.mode}.
 * `JSON.stringify` of parseable JSON never throws for plain values; the
 * try/catch is belt-and-suspenders so minifyJson stays non-throwing.
 */
export function encodeJsonValue(
  value: unknown,
  mode: "compact" | "flatten" = "compact",
): string {
  if (mode === "flatten") {
    return flattenJsonValue(value).join("|");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return flattenJsonValue(value).join("|");
  }
}

function csvCell(value: JsonPrimitive): string {
  const raw = value === null ? "null" : String(value);
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/**
 * True when `value` is a non-empty array of objects that all share the
 * same keys, with only primitive values. Key order is taken from the
 * first row; later rows may list keys in a different order.
 */
export function isUniformObjectArray(
  value: unknown,
): value is Array<Record<string, JsonPrimitive>> {
  if (!Array.isArray(value) || value.length === 0) return false;
  const first = value[0];
  if (!isPlainObject(first)) return false;
  const keys = Object.keys(first);
  if (keys.length === 0) return false;
  if (!keys.every((key) => isPrimitive(first[key]))) return false;

  for (let n = 0; n < value.length; n++) {
    const row = value[n];
    if (!isPlainObject(row)) return false;
    const rowKeys = Object.keys(row);
    if (rowKeys.length !== keys.length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) return false;
      if (!isPrimitive(row[key])) return false;
    }
  }
  return true;
}

/**
 * CSV table encoding of a uniform object array:
 *
 * ```
 * name,age
 * John,30
 * Ada,36
 * ```
 *
 * Header is the first object's keys; cells are RFC 4180-quoted when they
 * contain a comma, quote, or newline. Nested / non-uniform values return
 * `null` so callers can fall back to compact JSON.
 *
 * This is the "TOON-style" densifier used by the live JSON pass: repeated
 * keys are written once. Compact JSON wins when it is shorter (tiny arrays).
 */
export function encodeJsonTable(value: unknown): string | null {
  if (!isUniformObjectArray(value)) return null;
  const first = value[0];
  if (!first) return null;
  const keys = Object.keys(first);
  const header = keys.map((key) => csvCell(key)).join(",");
  const rows = value.map((row) =>
    keys.map((key) => csvCell(row[key] as JsonPrimitive)).join(","),
  );
  return [header, ...rows].join("\n");
}

/**
 * Compact JSON, or the CSV table form when `value` is a uniform object
 * array **and** that form is strictly shorter.
 */
export function encodeJsonCompactOrTable(value: unknown): string {
  const compact = encodeJsonValue(value, "compact");
  const table = encodeJsonTable(value);
  if (table !== null && table.length < compact.length) return table;
  return compact;
}

/**
 * True when `index` is a plausible JSON start — not `array[0]` / `obj{`.
 * Word characters and `$` immediately before `{`/`[` almost always mean
 * indexing or interpolation, not a standalone JSON literal.
 */
export function isJsonStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text.charCodeAt(index - 1);
  // A-Z a-z 0-9 _ $
  if (prev >= 65 && prev <= 90) return false;
  if (prev >= 97 && prev <= 122) return false;
  if (prev >= 48 && prev <= 57) return false;
  if (prev === 95 || prev === 36) return false;
  return true;
}

/**
 * True when a `{` / `[` at `start` never balances before EOF (user still
 * typing). Closed-but-invalid JSON (`{foo: bar}`) returns `false` — callers
 * should leave that text alone without freezing the rest of the draft.
 *
 * String contents and escapes are respected so `"["` inside a key does not
 * confuse depth.
 */
export function isUnclosedJsonAt(text: string, start: number): boolean {
  const opener = text[start];
  if (opener !== "{" && opener !== "[") return false;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === undefined) break;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === "{" || c === "[") {
      depth += 1;
      continue;
    }

    if (c === "}" || c === "]") {
      depth -= 1;
      if (depth < 0) return false;
      if (depth === 0) return false;
    }
  }

  return depth > 0 || inString;
}

/**
 * Scan from `start` (a `{` or `[`) for a balanced JSON slice, respecting
 * strings and escapes. On success returns the parsed value and the exclusive
 * end index; on failure returns `null` (caller should treat `text[start]` as
 * ordinary text).
 */
export function extractJsonAt(
  text: string,
  start: number,
): { value: unknown; end: number } | null {
  const opener = text[start];
  if (opener !== "{" && opener !== "[") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === undefined) break;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === "{" || c === "[") {
      depth += 1;
      continue;
    }

    if (c === "}" || c === "]") {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0) {
        const raw = text.slice(start, i + 1);
        try {
          return { value: JSON.parse(raw) as unknown, end: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function resolveMode(options?: MinifyJsonOptions): "compact" | "flatten" {
  return options?.mode ?? "compact";
}

/**
 * Replace every valid JSON object/array embedded in `text` with a denser
 * encoding. Surrounding characters are copied through unchanged.
 *
 * Never throws: malformed `{` / `[` spans stay in the output as original text.
 * Indexing like `array[1]` is not treated as JSON ({@link isJsonStart}).
 *
 * @example
 * minifyJson('User {"name":"John", "age":30} ok')
 * // → 'User {"name":"John","age":30} ok'   (default compact)
 *
 * minifyJson('User {"name":"John", "age":30} ok', { mode: "flatten" })
 * // → 'User name:John|age:30 ok'
 */
export function minifyJson(text: string, options?: MinifyJsonOptions): string {
  if (!text) return text;

  try {
    const mode = resolveMode(options);
    let out = "";
    let i = 0;

    while (i < text.length) {
      const ch = text[i];
      if ((ch === "{" || ch === "[") && isJsonStart(text, i)) {
        const extracted = extractJsonAt(text, i);
        if (extracted) {
          out += encodeJsonValue(extracted.value, mode);
          i = extracted.end;
          continue;
        }
      }
      out += ch;
      i += 1;
    }

    return out;
  } catch {
    return text;
  }
}

/**
 * Encode a uniform array of objects as a CSV table. Accepts a parsed value
 * or a string that may contain JSON blobs (same walk as {@link minifyJson}).
 *
 * Nested / non-uniform JSON falls back to compact `JSON.stringify`.
 * Unparseable text is returned unchanged. Never throws.
 *
 * @example
 * minifyJsonTable([{ name: "John", age: 30 }, { name: "Ada", age: 36 }])
 * // → "name,age\nJohn,30\nAda,36"
 */
export function minifyJsonTable(input: unknown): string {
  try {
    if (typeof input !== "string") {
      const table = encodeJsonTable(input);
      if (table !== null) return table;
      try {
        return JSON.stringify(input);
      } catch {
        return "";
      }
    }

    if (!input) return input;

    let out = "";
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      if ((ch === "{" || ch === "[") && isJsonStart(input, i)) {
        const extracted = extractJsonAt(input, i);
        if (extracted) {
          out += encodeJsonCompactOrTable(extracted.value);
          i = extracted.end;
          continue;
        }
      }
      out += ch;
      i += 1;
    }
    return out;
  } catch {
    return typeof input === "string" ? input : "";
  }
}
