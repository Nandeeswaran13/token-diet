/**
 * Protected index ranges for live as-you-type compression.
 *
 * Lexical rules (filler, contractions, markdown chrome) and payload minifiers
 * must not fire inside these spans. Two kinds of protection:
 *
 * - **Complete** regions the user meant to keep verbatim: closed fenced code,
 *   closed inline code, URLs, emails, and (cheaply) ISO dates / dotted versions.
 * - **Incomplete** regions the user is still typing: an unclosed fence or
 *   backtick, an unclosed HTML comment, or unbalanced `{` / `[` JSON. These
 *   extend to the end of the draft so we never "helpfully" rewrite mid-keystroke.
 *
 * Ranges are `[start, end)` in the original string and may be merged when they
 * overlap or abut.
 */

import { isJsonStart, isUnclosedJsonAt } from "./utils";

/** Inclusive-start, exclusive-end span into the original draft. */
export interface IndexRange {
  start: number;
  end: number;
}

/**
 * Merge overlapping / abutting ranges and sort left-to-right.
 * Abutting (`a.end === b.start`) is merged so skip-logic can jump once.
 */
export function mergeRanges(ranges: readonly IndexRange[]): IndexRange[] {
  if (ranges.length === 0) return [];
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: IndexRange[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end) {
      if (range.end > last.end) last.end = range.end;
    } else {
      out.push(range);
    }
  }
  return out;
}

/** True when `[start, end)` overlaps any range (half-open, so touching ends do not overlap). */
export function rangesOverlap(
  start: number,
  end: number,
  ranges: readonly IndexRange[],
): boolean {
  for (const range of ranges) {
    if (start < range.end && end > range.start) return true;
  }
  return false;
}

/**
 * If `index` sits inside a range, return that range's exclusive end so callers
 * can jump past it. Otherwise return `index` unchanged.
 */
export function skipClaimedIndex(
  index: number,
  ranges: readonly IndexRange[],
): number {
  for (const range of ranges) {
    if (index >= range.start && index < range.end) return range.end;
  }
  return index;
}

function isLineStart(text: string, index: number): boolean {
  return index === 0 || text.charAt(index - 1) === "\n";
}

/**
 * CommonMark-ish fence opener: 0–3 spaces of indent from the line start,
 * then a run of 3+ backticks or tildes. `index` must point at the first
 * fence character (not the indent).
 */
function fenceOpenerAt(
  text: string,
  index: number,
): { char: "`" | "~"; length: number } | null {
  const ch = text[index];
  if (ch !== "`" && ch !== "~") return null;

  let indent = 0;
  let k = index;
  while (k > 0) {
    const prev = text[k - 1];
    if (prev !== " " && prev !== "\t") break;
    indent += 1;
    k -= 1;
    if (indent > 3) return null;
  }
  if (!isLineStart(text, k)) return null;

  let length = 0;
  while (text[index + length] === ch) length += 1;
  if (length < 3) return null;
  return { char: ch, length };
}

/**
 * Closing fence: same character, at least as long as the opener, optional
 * trailing whitespace, then newline or EOF. Must sit at a line start (0–3
 * spaces of indent).
 */
function findClosingFence(
  text: string,
  from: number,
  char: "`" | "~",
  minLength: number,
): number {
  let i = from;
  while (i < text.length) {
    if (!isLineStart(text, i)) {
      const nl = text.indexOf("\n", i);
      if (nl === -1) return -1;
      i = nl + 1;
      continue;
    }

    let j = i;
    let indent = 0;
    while (j < text.length && (text[j] === " " || text[j] === "\t") && indent < 4) {
      j += 1;
      indent += 1;
    }
    if (indent > 3) {
      const nl = text.indexOf("\n", i);
      if (nl === -1) return -1;
      i = nl + 1;
      continue;
    }

    let run = 0;
    while (text[j + run] === char) run += 1;
    if (run >= minLength) {
      let k = j + run;
      while (k < text.length && (text[k] === " " || text[k] === "\t")) k += 1;
      if (k >= text.length || text[k] === "\n") {
        return k >= text.length ? text.length : k + 1;
      }
    }

    const nl = text.indexOf("\n", i);
    if (nl === -1) return -1;
    i = nl + 1;
  }
  return -1;
}

/**
 * Inline code: a run of 1+ backticks closed by a run of the same length
 * (CommonMark). A 3+ run that is a fence opener is handled elsewhere.
 * Unclosed → protect through EOF.
 */
function inlineCodeAt(
  text: string,
  index: number,
): IndexRange | null {
  if (text[index] !== "`") return null;
  if (fenceOpenerAt(text, index)) return null;

  let n = 0;
  while (text[index + n] === "`") n += 1;
  if (n === 0) return null;

  let i = index + n;
  while (i < text.length) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 0;
    while (text[i + run] === "`") run += 1;
    if (run === n) {
      return { start: index, end: i + run };
    }
    i += run;
  }

  // Still typing the closing tick — freeze the rest of the draft.
  return { start: index, end: text.length };
}

function incompleteHtmlCommentAt(text: string, index: number): IndexRange | null {
  if (!text.startsWith("<!--", index)) return null;
  const close = text.indexOf("-->", index + 4);
  if (close !== -1) return null;
  return { start: index, end: text.length };
}

/**
 * Strip a single trailing punctuation character that authors usually put
 * after a URL rather than inside it (`see https://x.com.`).
 */
function trimUrlTail(raw: string): string {
  return raw.replace(/[.,;:!?)\]>'"]+$/u, "");
}

function pushRegexRanges(
  text: string,
  pattern: RegExp,
  into: IndexRange[],
  trimTail?: (matched: string) => string,
): void {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const matched = match[0];
    if (!matched) {
      re.lastIndex += 1;
      continue;
    }
    const kept = trimTail ? trimTail(matched) : matched;
    if (!kept) continue;
    into.push({ start: match.index, end: match.index + kept.length });
    if (matched.length === 0) re.lastIndex += 1;
  }
}

/**
 * Fenced / inline code and an unclosed `<!--`. Extractive `summarize`
 * uses this so code is not split into fake sentences. Unlike
 * {@link findProtectedRanges} this does **not** punch holes for URLs or
 * emails (those belong inside a sentence).
 */
export function findCodeProtectedRanges(text: string): IndexRange[] {
  if (!text) return [];

  const ranges: IndexRange[] = [];
  let i = 0;

  while (i < text.length) {
    const fence = fenceOpenerAt(text, i);
    if (fence) {
      const lineEnd = text.indexOf("\n", i);
      const afterOpener = lineEnd === -1 ? text.length : lineEnd + 1;
      const closeEnd = findClosingFence(text, afterOpener, fence.char, fence.length);
      if (closeEnd === -1) {
        ranges.push({ start: i, end: text.length });
        break;
      }
      ranges.push({ start: i, end: closeEnd });
      i = closeEnd;
      continue;
    }

    const inline = inlineCodeAt(text, i);
    if (inline) {
      ranges.push(inline);
      i = inline.end;
      continue;
    }

    const comment = incompleteHtmlCommentAt(text, i);
    if (comment) {
      ranges.push(comment);
      break;
    }

    i += 1;
  }

  return mergeRanges(ranges);
}

/**
 * Identify every span that live compression must leave untouched.
 *
 * Scan order matters: fences and inline code consume backticks first so a
 * fence is never also treated as a pile of inline spans. Incomplete JSON is
 * considered only *outside* those regions so a `{` inside a closed fence
 * cannot leak protection past the closing ```.
 */
export function findProtectedRanges(text: string): IndexRange[] {
  if (!text) return [];

  const ranges: IndexRange[] = findCodeProtectedRanges(text);

  // Verbatim tokens that dictionary / chrome must not chew up. Harmless if
  // they also sit inside a fence (mergeRanges collapses the overlap).
  pushRegexRanges(text, /https?:\/\/[^\s<>"'`]+/gi, ranges, trimUrlTail);
  pushRegexRanges(text, /www\.[^\s<>"'`]+/gi, ranges, trimUrlTail);
  pushRegexRanges(
    text,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    ranges,
  );
  pushRegexRanges(
    text,
    /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/g,
    ranges,
  );
  pushRegexRanges(text, /\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/g, ranges);

  const seeded = mergeRanges(ranges);

  // Unclosed JSON in *prose* (user mid-keystroke). Closed-but-invalid blobs
  // such as `{foo: bar}` are *not* protected — they are just left unminified.
  const jsonRanges: IndexRange[] = [];
  let j = 0;
  while (j < text.length) {
    const jumped = skipClaimedIndex(j, seeded);
    if (jumped !== j) {
      j = jumped;
      continue;
    }
    const ch = text[j];
    if (
      (ch === "{" || ch === "[") &&
      isJsonStart(text, j) &&
      isUnclosedJsonAt(text, j)
    ) {
      jsonRanges.push({ start: j, end: text.length });
      break;
    }
    j += 1;
  }

  return mergeRanges([...seeded, ...jsonRanges]);
}
