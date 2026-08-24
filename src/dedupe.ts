/**
 * Exact consecutive line / paragraph deduplication.
 *
 * Pasted drafts often repeat a paragraph. When two or more **consecutive**
 * lines (trimmed, non-empty) or paragraphs are identical, keep the first
 * copy and emit a finding that covers each later copy **including** the
 * separator before it, so `compress()` does not leave a blank ghost line.
 *
 * Fuzzy / Jaccard near-dup is intentionally out of scope. Fences and other
 * claimed ranges are skipped.
 */

import {
  rangesOverlap,
  skipClaimedIndex,
  type IndexRange,
} from "./fences";

export interface DedupeHit {
  start: number;
  end: number;
  replacement: string;
}

interface Line {
  /** First character of the line (after the previous newline). */
  start: number;
  /** Exclusive end of line content (before `\n` / `\r`). */
  contentEnd: number;
  /** Exclusive end including the trailing newline sequence, or EOF. */
  eolEnd: number;
  trimmed: string;
}

function collectLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;

  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text[i] !== "\n") continue;

    let contentEnd = i;
    if (contentEnd > start && text[contentEnd - 1] === "\r") {
      contentEnd -= 1;
    }
    const raw = text.slice(start, contentEnd);
    const eolEnd = i < text.length ? i + 1 : i;
    lines.push({
      start,
      contentEnd,
      eolEnd,
      trimmed: raw.trim(),
    });
    start = i + 1;
  }

  return lines;
}

interface Paragraph {
  start: number;
  contentEnd: number;
  trimmed: string;
}

/**
 * Paragraphs are blocks separated by a blank line (`\n` + optional spaces/tabs
 * + `\n`). Leading/trailing whitespace on the block is trimmed for comparison.
 */
function collectParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const re = /\n[ \t]*\n/g;
  let last = 0;
  let match: RegExpExecArray | null;
  const seps: Array<{ start: number; end: number }> = [];

  while ((match = re.exec(text)) !== null) {
    seps.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) re.lastIndex += 1;
  }

  if (seps.length === 0) {
    const trimmed = text.trim();
    if (trimmed) {
      paragraphs.push({
        start: 0,
        contentEnd: text.length,
        trimmed,
      });
    }
    return paragraphs;
  }

  let cursor = 0;
  for (const sep of seps) {
    if (sep.start > cursor) {
      const raw = text.slice(cursor, sep.start);
      const trimmed = raw.trim();
      if (trimmed) {
        paragraphs.push({
          start: cursor,
          contentEnd: sep.start,
          trimmed,
        });
      }
    }
    cursor = sep.end;
  }
  if (cursor < text.length) {
    const raw = text.slice(cursor);
    const trimmed = raw.trim();
    if (trimmed) {
      paragraphs.push({
        start: cursor,
        contentEnd: text.length,
        trimmed,
      });
    }
  }

  return paragraphs;
}

function unclaimed(
  start: number,
  end: number,
  skip: readonly IndexRange[],
): boolean {
  return !rangesOverlap(start, end, skip);
}

/**
 * Consecutive identical non-empty lines, then consecutive identical
 * paragraphs. Findings replace the duplicate copy with `""`.
 */
export function findDuplicateLines(
  text: string,
  skip: readonly IndexRange[] = [],
): DedupeHit[] {
  if (!text) return [];

  const hits: DedupeHit[] = [];
  const claimed: IndexRange[] = [...skip];

  const lines = collectLines(text);
  let lastKeptTrim: string | null = null;

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (!line) continue;

    const jumped = skipClaimedIndex(line.start, claimed);
    if (jumped !== line.start && jumped >= line.contentEnd) {
      lastKeptTrim = null;
      continue;
    }
    if (!unclaimed(line.start, line.eolEnd, claimed)) {
      lastKeptTrim = null;
      continue;
    }

    if (line.trimmed && line.trimmed === lastKeptTrim && n > 0) {
      const prev = lines[n - 1];
      if (!prev) continue;
      // Cover the separator after the kept/previous line through this
      // line's content (not its trailing newline — that belongs to the
      // next line). Highlighter paints the 2nd+ copy.
      const start = prev.contentEnd;
      const end = line.contentEnd;
      if (end > start && unclaimed(start, end, claimed)) {
        hits.push({ start, end, replacement: "" });
        claimed.push({ start, end });
      }
      continue;
    }

    lastKeptTrim = line.trimmed ? line.trimmed : null;
  }

  const paragraphs = collectParagraphs(text);
  let lastParaTrim: string | null = null;
  let lastPara: Paragraph | null = null;

  for (const para of paragraphs) {
    if (!unclaimed(para.start, para.contentEnd, claimed)) {
      lastParaTrim = null;
      lastPara = null;
      continue;
    }

    if (
      lastPara &&
      lastParaTrim &&
      para.trimmed === lastParaTrim &&
      para.start > lastPara.contentEnd
    ) {
      const start = lastPara.contentEnd;
      const end = para.contentEnd;
      if (end > start && unclaimed(start, end, claimed)) {
        hits.push({ start, end, replacement: "" });
        claimed.push({ start, end });
      }
      continue;
    }

    lastParaTrim = para.trimmed;
    lastPara = para;
  }

  return hits;
}
