/**
 * Standalone minify utilities.
 *
 * Each function never throws: unmatched / malformed input is returned
 * unchanged. They can also feed live `findBloat` findings (markdown tables,
 * JSON tables) but most are utility-only (code comment stripping inside an
 * *unclosed* fence is deliberately not done live — fences already protect
 * those regions).
 *
 * - {@link minifyYaml} — comment-strip + blank-line collapse + `key: value`
 *   → `key:value` on a **restricted subset** (see that function's docs).
 *   There is no YAML parser; we do not invent one.
 * - {@link minifyXmlHtml} — comments out, tags out, keep text.
 * - {@link minifyMarkdown} — chrome + tables → TSV + blank collapse, with
 *   fenced code left verbatim.
 * - {@link minifyCode} — `//` `#` `/* * /` comments outside strings.
 * - {@link minifyCsvTsv} — trim cells, drop empty rows/columns.
 */

import { findMarkdownChrome, type ChromeHit } from "./chrome";
import {
  findProtectedRanges,
  mergeRanges,
  type IndexRange,
} from "./fences";
import { findMarkdownTables } from "./tables";

function applyHits(
  text: string,
  hits: ReadonlyArray<{ start: number; end: number; replacement: string }>,
): string {
  if (hits.length === 0) return text;
  const ordered = [...hits].sort((a, b) => b.start - a.start);
  let result = text;
  for (const hit of ordered) {
    result =
      result.slice(0, hit.start) + hit.replacement + result.slice(hit.end);
  }
  return result;
}

function collapseBlankLines(text: string): string {
  // Do not fold tabs — minifyMarkdown may have just emitted TSV.
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Conservative YAML densifier. **Subset, not a parser:**
 *
 * 1. Strip `#` comments to EOL when `#` is outside single/double quotes.
 * 2. Trim trailing whitespace on every line.
 * 3. Collapse 3+ consecutive newlines to a single blank line.
 * 4. Compact `key: value` → `key:value` when the key is an identifier
 *    (`[A-Za-z_][\w-]*`) and the value is a non-empty scalar that does
 *    **not** start with `|`, `>`, `{`, or `[` (block / flow indicators).
 *
 * Tags (`!!str`), anchors, multiline `|` blocks, and nested implicit
 * typing are left alone. Invalid YAML stays invalid — we never "fix" it.
 */
export function minifyYaml(text: string): string {
  if (!text) return text;
  try {
    const withoutComments = stripHashCommentsQuoted(text);
    const lines = withoutComments.split("\n");
    const compacted: string[] = [];
    const scalar = /^(\s*)([A-Za-z_][\w-]*)\s*:\s+(\S.*)$/;

    for (const line of lines) {
      const trimmedRight = line.replace(/[ \t]+$/g, "");
      const match = scalar.exec(trimmedRight);
      if (match) {
        const indent = match[1] ?? "";
        const key = match[2] ?? "";
        const value = match[3] ?? "";
        const first = value.charAt(0);
        if (first !== "|" && first !== ">" && first !== "{" && first !== "[") {
          compacted.push(`${indent}${key}:${value}`);
          continue;
        }
      }
      compacted.push(trimmedRight);
    }

    return compacted.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return text;
  }
}

/** Strip `# …` comments while honoring `'…'` / `"…"` on the same line. */
function stripHashCommentsQuoted(text: string): string {
  let out = "";
  let i = 0;
  let quote: "'" | '"' | null = null;

  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined) break;

    if (quote) {
      out += ch;
      if (ch === "\\" && quote === '"' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Strip `<!-- comments -->`, drop tags, keep text, collapse whitespace.
 * Unclosed comments are left intact. Never throws.
 */
export function minifyXmlHtml(text: string): string {
  if (!text) return text;
  try {
    let out = "";
    let i = 0;
    while (i < text.length) {
      if (text.startsWith("<!--", i)) {
        const close = text.indexOf("-->", i + 4);
        if (close === -1) {
          out += text.slice(i);
          break;
        }
        i = close + 3;
        continue;
      }
      if (text[i] === "<") {
        const gt = text.indexOf(">", i + 1);
        if (gt === -1) {
          out += text.slice(i);
          break;
        }
        i = gt + 1;
        continue;
      }
      out += text[i];
      i += 1;
    }
    return out.replace(/\s+/g, " ").trim();
  } catch {
    return text;
  }
}

/**
 * Compose markdown chrome (emphasis, HR, HTML comments, wrapping tags)
 * with complete GFM tables → TSV. Fenced / inline code is left verbatim
 * via {@link findProtectedRanges}. Extra blank lines collapse.
 */
export function minifyMarkdown(text: string): string {
  if (!text) return text;
  try {
    const protectedRanges = findProtectedRanges(text);
    const claimed: IndexRange[] = [...protectedRanges];
    const hits: Array<ChromeHit | { start: number; end: number; replacement: string }> =
      [];

    for (const table of findMarkdownTables(text, claimed)) {
      hits.push(table);
      claimed.push({ start: table.start, end: table.end });
    }

    const skip = mergeRanges(claimed);
    for (const chrome of findMarkdownChrome(text, skip)) {
      hits.push(chrome);
    }

    return collapseBlankLines(applyHits(text, hits));
  } catch {
    return text;
  }
}

const PREPROCESSOR =
  /^#\s*(include|define|undef|ifdef|ifndef|endif|pragma|else|elif|if|error|warning|line)\b/;
const HEX_COLOR =
  /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;
const CSS_ID = /^#[A-Za-z][\w-]*\s*[{,.[#]/;

/**
 * `#` is treated as a line comment when it sits at a word boundary (start
 * of line or after whitespace) and is not a C preprocessor directive, a
 * CSS hex color, or a CSS id selector. Language-agnostic and conservative:
 * we would rather leave a Python `#todo` than eat `#main {`.
 */
function isHashCommentAt(text: string, index: number): boolean {
  const rest = text.slice(index);
  if (PREPROCESSOR.test(rest)) return false;
  if (HEX_COLOR.test(rest)) return false;
  if (CSS_ID.test(rest)) return false;
  if (index > 0) {
    const prev = text[index - 1];
    if (prev !== " " && prev !== "\t" && prev !== "\n") return false;
  }
  return true;
}

/**
 * Strip `//`, `#`, and `/* * /` comments that sit outside single quotes,
 * double quotes, and template literals. Collapse 3+ consecutive newlines
 * to a single blank line. Identifiers are never renamed.
 *
 * Regex literals and interpolations inside `${…}` are **not** fully parsed
 * — a `//` inside `/https:\/\//` can be a false positive. Conservative
 * enough for pasted code blobs; not a replacement for `esbuild`.
 */
export function minifyCode(text: string): string {
  if (!text) return text;
  try {
    let out = "";
    let i = 0;
    type State = "code" | "sq" | "dq" | "tmpl" | "line" | "block";
    let state: State = "code";

    while (i < text.length) {
      const ch = text[i];
      const next = text[i + 1];
      if (ch === undefined) break;

      if (state === "code") {
        if (ch === '"') {
          state = "dq";
          out += ch;
          i += 1;
          continue;
        }
        if (ch === "'") {
          state = "sq";
          out += ch;
          i += 1;
          continue;
        }
        if (ch === "`") {
          state = "tmpl";
          out += ch;
          i += 1;
          continue;
        }
        if (ch === "/" && next === "/") {
          state = "line";
          i += 2;
          continue;
        }
        if (ch === "/" && next === "*") {
          state = "block";
          i += 2;
          continue;
        }
        if (ch === "#" && isHashCommentAt(text, i)) {
          state = "line";
          i += 1;
          continue;
        }
        out += ch;
        i += 1;
        continue;
      }

      if (state === "dq" || state === "sq" || state === "tmpl") {
        const closer = state === "dq" ? '"' : state === "sq" ? "'" : "`";
        out += ch;
        if (ch === "\\" && i + 1 < text.length) {
          out += text[i + 1];
          i += 2;
          continue;
        }
        if (ch === closer) state = "code";
        i += 1;
        continue;
      }

      if (state === "line") {
        if (ch === "\n") {
          state = "code";
          out += ch;
        }
        i += 1;
        continue;
      }

      if (state === "block") {
        if (ch === "*" && next === "/") {
          state = "code";
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
    }

    return out.replace(/\n{3,}/g, "\n\n");
  } catch {
    return text;
  }
}

function detectDelimiter(text: string): "," | "\t" {
  const firstNl = text.search(/\r?\n/);
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  let commas = 0;
  let tabs = 0;
  let inQuotes = false;
  for (let i = 0; i < first.length; i++) {
    const ch = first[i];
    if (ch === '"') {
      if (inQuotes && first[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === ",") commas += 1;
    if (ch === "\t") tabs += 1;
  }
  return tabs > commas ? "\t" : ",";
}

function parseDelimited(text: string, delim: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined) break;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === delim) {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }

    if (ch === "\n") {
      if (cell.endsWith("\r")) cell = cell.slice(0, -1);
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
      i += 1;
      continue;
    }

    cell += ch;
    i += 1;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function serializeDelimited(rows: readonly string[][], delim: "," | "\t"): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          if (delim === "," && /[",\n\r]/.test(cell)) {
            return `"${cell.replace(/"/g, '""')}"`;
          }
          return cell;
        })
        .join(delim),
    )
    .join("\n");
}

/**
 * Trim every cell, drop rows that are entirely empty after trim, and drop
 * columns that are empty in every row. Delimiter is inferred from the
 * header line (tab wins if there are more tabs than commas). Never throws.
 */
export function minifyCsvTsv(text: string): string {
  if (!text) return text;
  try {
    const delim = detectDelimiter(text);
    const parsed = parseDelimited(text, delim);
    const trimmed = parsed.map((row) => row.map((cell) => cell.trim()));
    const nonemptyRows = trimmed.filter((row) =>
      row.some((cell) => cell.length > 0),
    );
    if (nonemptyRows.length === 0) return "";

    const width = nonemptyRows.reduce(
      (max, row) => (row.length > max ? row.length : max),
      0,
    );
    const keepCol: boolean[] = [];
    for (let c = 0; c < width; c++) {
      keepCol.push(nonemptyRows.some((row) => (row[c] ?? "").length > 0));
    }
    const slim = nonemptyRows
      .map((row) => row.filter((_, c) => keepCol[c] === true))
      .filter((row) => row.some((cell) => cell.length > 0));

    return serializeDelimited(slim, delim);
  } catch {
    return text;
  }
}
