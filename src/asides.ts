/**
 * Conservative parenthetical / em-dash aside stripping.
 *
 * Only fires when `strictMode` or `stripAsides` is on. The interior must
 * match a small discourse-aside dictionary (or a very short filler word).
 * We never delete dates, quantities, or asides that carry negation /
 * constraint (`not`, `n't`, `never`, `only`, `must`, `all`, `none`,
 * `optional`).
 */

import {
  rangesOverlap,
  skipClaimedIndex,
  type IndexRange,
} from "./fences";

export interface AsideHit {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Interiors we will strip, already lowercase. Longer phrases first so
 * "as mentioned earlier" wins over "as mentioned".
 */
const ASIDE_PHRASES: readonly string[] = [
  "as mentioned earlier",
  "as mentioned above",
  "as i mentioned earlier",
  "as i mentioned above",
  "as i mentioned",
  "as mentioned",
  "as noted earlier",
  "as noted above",
  "as noted",
  "as discussed earlier",
  "as discussed above",
  "needless to say",
  "to be honest",
  "to be fair",
  "as you know",
  "as i said",
  "like i said",
  "by the way",
  "see above",
  "see below",
  "emphasis mine",
  "emphasis added",
  "so to speak",
  "as it were",
  "if you will",
  "of course",
  "you know",
  "btw",
];

const SHORT_FILLER: ReadonlySet<string> = new Set([
  "anyway",
  "anyways",
  "however",
  "though",
  "incidentally",
  "meanwhile",
  "obviously",
  "clearly",
]);

const FORBIDDEN =
  /\bnot\b|n't|\bnever\b|\bonly\b|\bmust\b|\ball\b|\bnone\b|\boptional\b/i;

function foldInterior(raw: string): string {
  return raw
    .replace(/\u2019/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when `interior` is a known aside and carries no constraint words
 * or digits (years, chapter numbers, `(1815–1852)`).
 */
export function isStrippableAside(interior: string): boolean {
  const folded = foldInterior(interior);
  if (!folded) return false;
  if (/\d/.test(folded)) return false;
  if (FORBIDDEN.test(folded)) return false;

  for (const phrase of ASIDE_PHRASES) {
    if (folded === phrase) return true;
  }
  if (SHORT_FILLER.has(folded)) return true;
  return false;
}

function isEmDash(char: string | undefined): boolean {
  if (!char) return false;
  const c = char.charCodeAt(0);
  return c === 0x2014 || c === 0x2013; // em / en dash
}

const MAX_ASIDE = 80;

function matchParenAside(text: string, index: number): AsideHit | null {
  if (text[index] !== "(") return null;

  let depth = 1;
  for (let j = index + 1; j < text.length && j - index <= MAX_ASIDE; j++) {
    const ch = text[j];
    if (ch === "(") {
      // Nested parens are almost never discourse asides.
      return null;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        const interior = text.slice(index + 1, j);
        if (!isStrippableAside(interior)) return null;
        return { start: index, end: j + 1, replacement: "" };
      }
    }
    if (ch === "\n") return null; // asides stay on one line
  }
  return null;
}

function matchDashAside(text: string, index: number): AsideHit | null {
  if (!isEmDash(text[index])) return null;

  for (let j = index + 1; j < text.length && j - index <= MAX_ASIDE; j++) {
    if (text[j] === "\n") return null;
    if (isEmDash(text[j]) && j > index + 1) {
      const interior = text.slice(index + 1, j);
      if (!isStrippableAside(interior)) return null;
      return { start: index, end: j + 1, replacement: "" };
    }
  }
  return null;
}

/**
 * Parenthetical and em-dash asides outside `skip`. Replacement is always
 * empty — the aside is deleted, surrounding whitespace is squeezed later
 * by `compress()`.
 */
export function findAsides(
  text: string,
  skip: readonly IndexRange[] = [],
): AsideHit[] {
  if (!text) return [];

  const hits: AsideHit[] = [];
  const claimed: IndexRange[] = [...skip];
  let i = 0;

  while (i < text.length) {
    const jumped = skipClaimedIndex(i, claimed);
    if (jumped !== i) {
      i = jumped;
      continue;
    }

    const paren = matchParenAside(text, i);
    const dash = matchDashAside(text, i);
    const hit = paren ?? dash;
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

    i += 1;
  }

  return hits;
}
