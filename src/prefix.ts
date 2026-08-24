/**
 * Cacheable-prefix helpers for prompt-cache hints.
 *
 * Providers that cache a stable system/user prefix want the longest run of
 * characters that has not changed since the previous draft. {@link
 * cacheablePrefixEnd} is that exclusive index into `current`, snapped back
 * if the raw LCP lands mid-word so hosts can split messages on a boundary.
 *
 * Always returns the true (snapped) index — including tiny prefixes. Hosts
 * that only want a useful cache blob can ignore values under ~32 chars.
 * An empty `previous` (first keystroke / first feed) returns 0: there is
 * nothing cached yet.
 */

function isWordChar(char: string | undefined): boolean {
  if (char === undefined || char.length === 0) return false;
  const c = char.charCodeAt(0);
  if (c >= 65 && c <= 90) return true;
  if (c >= 97 && c <= 122) return true;
  if (c >= 48 && c <= 57) return true;
  return c === 39 || c === 8217;
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/**
 * If `end` sits inside a word of `text`, walk back to the last whitespace
 * or newline so the prefix is a clean split point. Already-at-boundary
 * indexes (punctuation, space, EOF) are left alone.
 */
export function snapPrefixEnd(text: string, end: number): number {
  if (end <= 0) return 0;
  if (end >= text.length) return text.length;
  const prev = text[end - 1];
  const next = text[end];
  if (!(isWordChar(prev) && isWordChar(next))) return end;
  let i = end;
  while (i > 0 && !isSpace(text[i - 1])) i -= 1;
  return i;
}

/** Longest shared leading substring of `a` and `b`. */
export function longestCommonPrefix(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return a.slice(0, i);
}

/**
 * Exclusive index into `current` of the longest common prefix with
 * `previous`, snapped to a word boundary. Empty `previous` → 0.
 */
export function cacheablePrefixEnd(previous: string, current: string): number {
  if (!previous || !current) return 0;
  const raw = longestCommonPrefix(previous, current).length;
  return snapPrefixEnd(current, raw);
}
