/**
 * Markdown / HTML chrome densifier for live findBloat.
 *
 * These passes only run *outside* protected ranges (fences, inline code,
 * unclosed JSON, …). Each hit is one highlighter span whose replacement is
 * the denser form (often the inner text, or empty for decorative rules /
 * comments).
 *
 * Conservative by design:
 * - Emphasis markers must wrap a word/phrase on a single line.
 * - Single `*` / `_` require flanking (no `2*3*4`, no `snake_case`, no `* list`).
 * - HTML is a handful of wrapping tags, not a DOM parser.
 * - Unmatched markers / tags are left alone.
 */

import {
  rangesOverlap,
  skipClaimedIndex,
  type IndexRange,
} from "./fences";

/** A rewrite located in the original string; engine wraps this as a BloatFinding. */
export interface ChromeHit {
  start: number;
  end: number;
  replacement: string;
}

const WRAP_TAGS = ["strong", "em", "p", "b", "i"] as const;

function isLineStart(text: string, index: number): boolean {
  return index === 0 || text.charAt(index - 1) === "\n";
}

function isWordChar(char: string | undefined): boolean {
  if (char === undefined || char.length === 0) return false;
  const c = char.charCodeAt(0);
  if (c >= 65 && c <= 90) return true;
  if (c >= 97 && c <= 122) return true;
  if (c >= 48 && c <= 57) return true;
  return false;
}

function lineLimit(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  return nl === -1 ? text.length : nl;
}

/**
 * Decorative horizontal rule on its own line: `---`, `***`, `___`
 * (3+ of the same character, optional surrounding whitespace).
 * The span includes the trailing newline when present so compress does not
 * leave a blank ghost line behind.
 */
function matchHorizontalRule(text: string, index: number): ChromeHit | null {
  if (!isLineStart(text, index)) return null;

  let j = index;
  while (j < text.length && (text[j] === " " || text[j] === "\t")) j += 1;

  const ch = text[j];
  if (ch !== "-" && ch !== "*" && ch !== "_") return null;

  let k = j;
  while (text[k] === ch) k += 1;
  if (k - j < 3) return null;

  while (k < text.length && (text[k] === " " || text[k] === "\t")) k += 1;
  if (k < text.length && text[k] !== "\n") return null;

  const end = k < text.length ? k + 1 : k;
  if (end <= index) return null;
  return { start: index, end, replacement: "" };
}

function matchHtmlComment(text: string, index: number): ChromeHit | null {
  if (!text.startsWith("<!--", index)) return null;
  const close = text.indexOf("-->", index + 4);
  if (close === -1) return null; // incomplete comments are protected, not stripped
  return { start: index, end: close + 3, replacement: "" };
}

/**
 * Paired wrapping tags only: `<b>x</b>` → `x`. Attributes on the opener are
 * allowed; nested tags, self-closing tags, and unmatched closers are skipped.
 */
function matchWrapTag(text: string, index: number): ChromeHit | null {
  if (text[index] !== "<") return null;

  for (const tag of WRAP_TAGS) {
    const openPrefix = `<${tag}`;
    const slice = text.slice(index, index + openPrefix.length);
    if (slice.toLowerCase() !== openPrefix) continue;

    const afterName = index + openPrefix.length;
    const boundary = text[afterName];
    if (boundary !== ">" && boundary !== " " && boundary !== "\t" && boundary !== "/") {
      continue;
    }

    const gt = text.indexOf(">", afterName);
    if (gt === -1) return null;
    if (gt > afterName && text[gt - 1] === "/") return null;

    const innerStart = gt + 1;
    const closeNeedle = `</${tag}>`;
    const rest = text.slice(innerStart);
    const closeAt = rest.toLowerCase().indexOf(closeNeedle);
    if (closeAt === -1) return null;

    const inner = rest.slice(0, closeAt);
    if (inner.includes("<")) continue;

    const end = innerStart + closeAt + closeNeedle.length;
    return { start: index, end, replacement: inner };
  }

  return null;
}

/**
 * Find a closing marker on the same line. For single `*` / `_`, a doubled
 * marker (`**` / `__`) is not a valid closer — those belong to the two-char
 * pass that already ran.
 */
function findClosingMarker(
  text: string,
  from: number,
  marker: string,
): number {
  const limit = lineLimit(text, from);
  let i = from;
  while (i + marker.length <= limit) {
    if (text.startsWith(marker, i)) {
      if (marker === "*" && text.startsWith("**", i)) {
        i += 1;
        continue;
      }
      if (marker === "_" && text.startsWith("__", i)) {
        i += 1;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

function matchEmphasis(text: string, index: number, marker: string): ChromeHit | null {
  if (!text.startsWith(marker, index)) return null;

  // Longer marker should have already claimed `**` / `__`. If we're looking
  // for a single char, refuse to start on a doubled run (***hello***, lists
  // of `***`, math).
  if (marker.length === 1) {
    const doubled = marker + marker;
    if (text.startsWith(doubled, index)) return null;
  } else if (text.startsWith(marker + marker.charAt(0), index)) {
    // `***` / `___` — inner would start with the marker char; skip. HR already
    // handled own-line cases.
    return null;
  }

  const innerStart = index + marker.length;
  const close = findClosingMarker(text, innerStart, marker);
  if (close === -1 || close === innerStart) return null;

  const inner = text.slice(innerStart, close);
  if (!inner.trim()) return null;
  if (inner.includes(marker)) return null;

  if (marker.length === 1) {
    const mark = marker;
    // Markdown list item: `*` / `_` at line start followed by whitespace.
    if (
      isLineStart(text, index) &&
      (text[index + 1] === " " || text[index + 1] === "\t")
    ) {
      return null;
    }
    // Flanking: don't eat multiplication (`2*3*4`) or snake_case (`a_b_c`).
    if (isWordChar(index === 0 ? undefined : text[index - 1])) return null;
    if (isWordChar(text[close + marker.length])) return null;
    if (inner.startsWith(" ") || inner.endsWith(" ")) return null;
    if (inner.startsWith(mark) || inner.endsWith(mark)) return null;
  }

  return {
    start: index,
    end: close + marker.length,
    replacement: inner,
  };
}

/**
 * Left-to-right chrome scan. `skip` is protected ranges plus already-claimed
 * JSON spans — hits that overlap those ranges are ignored.
 */
export function findMarkdownChrome(
  text: string,
  skip: readonly IndexRange[] = [],
): ChromeHit[] {
  if (!text) return [];

  const hits: ChromeHit[] = [];
  const claimed: IndexRange[] = [...skip];
  let i = 0;

  while (i < text.length) {
    const jumped = skipClaimedIndex(i, claimed);
    if (jumped !== i) {
      i = jumped;
      continue;
    }

    const hr = matchHorizontalRule(text, i);
    const comment = matchHtmlComment(text, i);
    const tag = matchWrapTag(text, i);
    const strongStar = matchEmphasis(text, i, "**");
    const strongUnderscore = matchEmphasis(text, i, "__");
    const emStar = matchEmphasis(text, i, "*");
    const emUnderscore = matchEmphasis(text, i, "_");

    // Prefer the longest hit at this index so `***` HR wins over `*`, and
    // `<strong>` wins over a stray `<` that wouldn't match anyway.
    const candidates = [hr, comment, tag, strongStar, strongUnderscore, emStar, emUnderscore]
      .filter((hit): hit is ChromeHit => hit !== null)
      .filter((hit) => hit.end > hit.start)
      .filter((hit) => hit.replacement.length < hit.end - hit.start)
      .filter((hit) => !rangesOverlap(hit.start, hit.end, claimed));

    let best: ChromeHit | undefined;
    for (const hit of candidates) {
      if (!best || hit.end - hit.start > best.end - best.start) best = hit;
    }

    if (best) {
      hits.push(best);
      claimed.push({ start: best.start, end: best.end });
      i = best.end;
      continue;
    }

    i += 1;
  }

  return hits;
}
