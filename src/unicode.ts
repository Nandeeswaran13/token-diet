/**
 * Unicode folding for live drafts and the standalone {@link normalizeUnicode}
 * utility.
 *
 * LLM tokenizers treat NBSP, BOM, zero-width space, and smart quotes as
 * distinct from their ASCII counterparts — usually wasting a token for no
 * semantic gain. This pass rewrites those code points in place.
 *
 * Live findings are located in the **original** string (so highlighters can
 * paint them) and skip protected ranges plus complete JSON / markdown tables
 * so later payload minifiers still see an unclaimed blob.
 */

import {
  mergeRanges,
  rangesOverlap,
  skipClaimedIndex,
  type IndexRange,
} from "./fences";
import { extractJsonAt, isJsonStart } from "./utils";
import { matchMarkdownTableAt } from "./tables";

/** Inclusive-start, exclusive-end rewrite used by the engine. */
export interface UnicodeHit {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Map one BMP character to its ASCII/space fold.
 * Returns `null` when the character should be left alone.
 *
 * Ellipsis (`…`) becomes `...` unconditionally — three ASCII dots are the
 * conventional fold and `estimateTokens` does not increase (1 → 1 under
 * chars/4). A custom tokenizer that disagrees can still drop the finding.
 */
export function mapUnicodeChar(char: string): string | null {
  if (!char) return null;
  const c = char.charCodeAt(0);
  switch (c) {
    case 0xfeff: // BOM
    case 0x200b: // ZERO WIDTH SPACE
    case 0x200c: // ZERO WIDTH NON-JOINER
    case 0x200d: // ZERO WIDTH JOINER
    case 0x2060: // WORD JOINER
      return "";
    case 0x00a0: // NBSP
    case 0x202f: // NARROW NO-BREAK SPACE
    case 0x2007: // FIGURE SPACE
      return " ";
    case 0x2018: // LEFT SINGLE QUOTATION MARK
    case 0x2019: // RIGHT SINGLE QUOTATION MARK
    case 0x201a: // SINGLE LOW-9 QUOTATION MARK
    case 0x201b: // SINGLE HIGH-REVERSED-9 QUOTATION MARK
      return "'";
    case 0x201c: // LEFT DOUBLE QUOTATION MARK
    case 0x201d: // RIGHT DOUBLE QUOTATION MARK
    case 0x201e: // DOUBLE LOW-9 QUOTATION MARK
    case 0x201f: // DOUBLE HIGH-REVERSED-9 QUOTATION MARK
      return '"';
    case 0x2026: // HORIZONTAL ELLIPSIS
      return "...";
    default:
      return null;
  }
}

/**
 * Fold ZWSP / BOM / NBSP / smart quotes / ellipsis across the whole string.
 * Never throws; unexpected errors return `text` unchanged. Does **not** honor
 * fences — this is a standalone sanitizer. Live highlighting uses
 * {@link findUnicodeHits} instead.
 */
export function normalizeUnicode(text: string): string {
  if (!text) return text;
  try {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === undefined) break;
      const mapped = mapUnicodeChar(ch);
      out += mapped === null ? ch : mapped;
    }
    return out;
  } catch {
    return text;
  }
}

function isLineStart(text: string, index: number): boolean {
  return index === 0 || text.charAt(index - 1) === "\n";
}

/**
 * Jump past a complete JSON blob or markdown table starting at `index`
 * without claiming it — those passes own the span later.
 */
function skipStructuredPayload(text: string, index: number): number | null {
  const ch = text[index];
  if ((ch === "{" || ch === "[") && isJsonStart(text, index)) {
    const extracted = extractJsonAt(text, index);
    if (extracted) return extracted.end;
  }
  if (ch === "|" && isLineStart(text, index)) {
    const table = matchMarkdownTableAt(text, index);
    if (table) return table.end;
  }
  return null;
}

/**
 * Adjacent unicode folds merge into one highlighter span. Skip `skip` ranges
 * (fences, incomplete JSON, …) and complete JSON / table payloads.
 */
export function findUnicodeHits(
  text: string,
  skip: readonly IndexRange[] = [],
): UnicodeHit[] {
  if (!text) return [];

  const hits: UnicodeHit[] = [];
  const claimed = mergeRanges(skip);
  let i = 0;

  while (i < text.length) {
    const jumped = skipClaimedIndex(i, claimed);
    if (jumped !== i) {
      i = jumped;
      continue;
    }

    const payloadEnd = skipStructuredPayload(text, i);
    if (payloadEnd !== null) {
      i = payloadEnd;
      continue;
    }

    const ch = text[i];
    if (ch === undefined) break;
    const mapped = mapUnicodeChar(ch);
    if (mapped === null) {
      i += 1;
      continue;
    }

    let end = i + 1;
    let replacement = mapped;
    while (end < text.length) {
      if (rangesOverlap(end, end + 1, claimed)) break;
      if (skipStructuredPayload(text, end) !== null) break;
      const next = text[end];
      if (next === undefined) break;
      const nextMap = mapUnicodeChar(next);
      if (nextMap === null) break;
      replacement += nextMap;
      end += 1;
    }

    hits.push({ start: i, end, replacement });
    i = end;
  }

  return hits;
}
