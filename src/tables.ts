/**
 * GitHub-flavored markdown tables → TSV for live {@link findMarkdownTables}
 * and the standalone minify utilities.
 *
 * A table is complete only when it has a header row, a separator row of
 * 3+ dashes per column (`|---|---|` / alignment colons allowed), and every
 * row has the same cell count. Header-without-separator or ragged rows
 * (still typing) are left alone.
 *
 * Output is tab-separated values: header, then data rows. The separator
 * row is dropped. One finding covers the whole table.
 */

import {
  rangesOverlap,
  skipClaimedIndex,
  type IndexRange,
} from "./fences";

/** Inclusive-start, exclusive-end rewrite. */
export interface TableHit {
  start: number;
  end: number;
  replacement: string;
}

function isLineStart(text: string, index: number): boolean {
  return index === 0 || text.charAt(index - 1) === "\n";
}

/** Line that contains `index`, from the preceding newline to before the next. */
function lineBounds(
  text: string,
  index: number,
): { start: number; end: number } {
  let start = index;
  while (start > 0 && text[start - 1] !== "\n") start -= 1;
  let end = index;
  while (end < text.length && text[end] !== "\n") end += 1;
  return { start, end };
}

/**
 * Split a GFM table row into trimmed cells. Leading/trailing pipes are the
 * usual wrapping pipes, not empty cells; `||` in the middle *is* an empty cell.
 * Returns `null` when the line is not a pipe-row.
 */
export function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;

  let inner = trimmed;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);

  return inner.split("|").map((cell) => cell.trim());
}

const SEPARATOR_CELL = /^:?-{3,}:?$/;

function isSeparatorRow(cells: readonly string[]): boolean {
  if (cells.length === 0) return false;
  return cells.every((cell) => SEPARATOR_CELL.test(cell));
}

function nextLineStart(text: string, lineEnd: number): number {
  if (lineEnd >= text.length) return text.length;
  if (text[lineEnd] === "\n") return lineEnd + 1;
  return lineEnd;
}

/**
 * If `index` sits on a complete GFM table (first `|` of the header, or the
 * indent before it when called from a line start), return one TSV rewrite.
 * The span ends at the last character of the last table row (exclusive of
 * the trailing newline that separates the table from following prose).
 */
export function matchMarkdownTableAt(
  text: string,
  index: number,
): TableHit | null {
  if (index >= text.length) return null;

  const { start: lineStart, end: headerLineEnd } = lineBounds(text, index);

  // Only match at the beginning of the header line so we do not emit a
  // finding mid-row while the user is still typing the first `|`.
  if (index !== lineStart && index !== firstNonWs(text, lineStart)) {
    return null;
  }
  if (!isLineStart(text, lineStart)) return null;

  const headerLine = text.slice(lineStart, headerLineEnd);
  const header = splitTableRow(headerLine);
  if (!header || header.length === 0) return null;

  const sepLineStart = nextLineStart(text, headerLineEnd);
  if (sepLineStart >= text.length) return null;

  const { end: sepLineEnd } = lineBounds(text, sepLineStart);
  const sepLine = text.slice(sepLineStart, sepLineEnd);
  const sep = splitTableRow(sepLine);
  if (!sep || sep.length !== header.length || !isSeparatorRow(sep)) {
    return null;
  }

  const dataRows: string[][] = [];
  let cursor = nextLineStart(text, sepLineEnd);
  let lastContentEnd = sepLineEnd;

  while (cursor < text.length) {
    const { start: rowStart, end: rowEnd } = lineBounds(text, cursor);
    if (rowStart !== cursor) break;

    const rowLine = text.slice(rowStart, rowEnd);
    if (!rowLine.trim().startsWith("|")) break;

    const cells = splitTableRow(rowLine);
    if (!cells || cells.length !== header.length) {
      // Ragged / still-typing row — refuse the whole table.
      return null;
    }

    dataRows.push(cells);
    lastContentEnd = rowEnd;
    cursor = nextLineStart(text, rowEnd);
  }

  const tsvLines = [
    header.join("\t"),
    ...dataRows.map((row) => row.join("\t")),
  ];
  const replacement = tsvLines.join("\n");
  if (replacement.length >= lastContentEnd - lineStart) return null;

  return { start: lineStart, end: lastContentEnd, replacement };
}

function firstNonWs(text: string, lineStart: number): number {
  let i = lineStart;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  return i;
}

/**
 * Left-to-right complete markdown tables outside `skip` ranges.
 */
export function findMarkdownTables(
  text: string,
  skip: readonly IndexRange[] = [],
): TableHit[] {
  if (!text) return [];

  const hits: TableHit[] = [];
  const claimed: IndexRange[] = [...skip];
  let i = 0;

  while (i < text.length) {
    const jumped = skipClaimedIndex(i, claimed);
    if (jumped !== i) {
      i = jumped;
      continue;
    }

    if (isLineStart(text, i)) {
      const hit = matchMarkdownTableAt(text, i);
      if (
        hit &&
        hit.end > hit.start &&
        !rangesOverlap(hit.start, hit.end, claimed)
      ) {
        hits.push(hit);
        claimed.push({ start: hit.start, end: hit.end });
        i = hit.end;
        continue;
      }
    }

    const nl = text.indexOf("\n", i);
    i = nl === -1 ? text.length : nl + 1;
  }

  return hits;
}
