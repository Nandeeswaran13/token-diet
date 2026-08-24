/**
 * Extractive, non-LLM summarizer.
 *
 * Standalone utility — **not** wired into {@link PromptWatcher}. It picks
 * existing sentences (no rewrite, no hallucination) so polarity and quotes
 * survive. Default path is linear: Luhn significant-word clusters + sentence
 * TF-IDF (cosine vs document centroid) + lead/tail position + optional
 * query overlap, then MMR to avoid near-duplicate picks. `method: "textrank"`
 * swaps the relevance score for PageRank on a TF-IDF cosine graph (capped).
 *
 * Fenced / inline code and complete JSON blobs are skipped so a pasted
 * payload is not treated as one giant "sentence".
 */

import { estimateTokens } from "./engine";
import {
  findCodeProtectedRanges,
  mergeRanges,
  skipClaimedIndex,
  type IndexRange,
} from "./fences";
import { STOPWORDS } from "./stopwords";
import { extractJsonAt, isJsonStart } from "./utils";

/** Graph ranking is O(n²); above this, {@link summarize} stays on `fast`. */
const TEXTRANK_SENTENCE_CAP = 200;
const PAGERANK_ITERS = 25;
const PAGERANK_DAMPING = 0.85;
const DEFAULT_RATIO = 0.3;
const DEFAULT_MMR_LAMBDA = 0.7;
/** Luhn: max non-significant tokens between two significant ones in a cluster. */
const LUHN_GAP = 4;

/**
 * Titles and common abbreviations that end in `.` but are not sentence
 * boundaries. Compared lowercase against the token immediately before `.`.
 */
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "etc",
  "inc",
  "ltd",
  "corp",
  "co",
  "al",
  "fig",
  "eq",
  "no",
  "vol",
  "pp",
  "pg",
  "approx",
  "est",
  "dept",
  "univ",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
  "e.g",
  "i.e",
  "u.s",
  "u.k",
  "ph.d",
]);

export interface SummarizeOptions {
  /**
   * Stop adding sentences once the joined summary reaches this many tokens
   * (`tokenizer` or {@link estimateTokens}). Honored together with
   * {@link maxSentences} — whichever binds first.
   */
  maxTokens?: number;
  /** Hard cap on how many sentences to keep. */
  maxSentences?: number;
  /**
   * Fraction of candidate sentences to keep when no `maxTokens` /
   * `maxSentences` is set.
   *
   * @default 0.3
   */
  ratio?: number;
  /**
   * Optional focus string (usually the user's instruction sitting above a
   * pasted blob). Biases scoring toward lexical overlap with this query.
   */
  query?: string;
  /**
   * `fast` — Luhn + TF-IDF + position (+ query). `textrank` — PageRank on
   * the sentence similarity graph; silently falls back to `fast` above
   * {@link TEXTRANK_SENTENCE_CAP} sentences.
   *
   * @default "fast"
   */
  method?: "fast" | "textrank";
  /** Token counter for {@link maxTokens}. */
  tokenizer?: (text: string) => number;
  /**
   * MMR trade-off: `1` = pure relevance, `0` = pure novelty vs already
   * picked sentences.
   *
   * @default 0.7
   */
  lambda?: number;
}

/** One candidate sentence, located in the original input. */
export interface SummarySentence {
  start: number;
  end: number;
  text: string;
  /** Combined relevance in `[0, 1]` after min-max normalize. */
  score: number;
  selected: boolean;
}

export interface SummarizeResult {
  /** Selected sentences joined in original order, separated by a space. */
  summary: string;
  /** Every prose candidate (not code/JSON), with `selected` flags. */
  sentences: SummarySentence[];
}

/** Internal sentence span used by {@link splitSentences}. */
export interface Candidate {
  start: number;
  end: number;
  text: string;
  tokens: string[];
}

function isWordChar(char: string | undefined): boolean {
  if (!char) return false;
  const c = char.charCodeAt(0);
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    (c >= 48 && c <= 57)
  );
}

function isDigit(char: string | undefined): boolean {
  if (!char) return false;
  const c = char.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/**
 * Token immediately before `index` (a punctuation mark). Drops a trailing
 * `.` so `e.g.` / `U.S.` still match the abbreviation list.
 */
function wordBefore(text: string, index: number): string {
  let end = index;
  while (end > 0 && text[end - 1] === ".") end -= 1;
  let start = end;
  while (start > 0 && isWordChar(text[start - 1])) start -= 1;
  return text.slice(start, end);
}

function isClosingQuote(char: string | undefined): boolean {
  return (
    char === '"' ||
    char === "'" ||
    char === ")" ||
    char === "]" ||
    char === "\u201d" ||
    char === "\u2019"
  );
}

/**
 * True when `index` is a `.` / `!` / `?` that ends a sentence.
 * Skips decimals, ellipses, single-letter initials, and {@link ABBREVIATIONS}.
 */
function isSentenceEnd(text: string, index: number): boolean {
  const c = text[index];
  if (c !== "." && c !== "!" && c !== "?") return false;
  if (c === "." && text[index + 1] === ".") return false;
  if (c === "." && isDigit(text[index - 1]) && isDigit(text[index + 1])) {
    return false;
  }

  if (c === ".") {
    const prev = wordBefore(text, index);
    const folded = prev.toLowerCase();
    if (ABBREVIATIONS.has(folded)) return false;
    if (prev.length === 1 && /[A-Za-z]/.test(prev)) return false;
  }

  let j = index + 1;
  while (j < text.length && isClosingQuote(text[j])) j += 1;
  if (j >= text.length) return true;
  while (j < text.length && isWhitespace(text[j])) j += 1;
  if (j >= text.length) return true;

  const next = text[j];
  if (next === undefined) return true;
  if (next === next.toUpperCase() && next !== next.toLowerCase()) return true;
  if (next === '"' || next === "'" || next === "(" || next === "\u201c") {
    return true;
  }
  return false;
}

function trimSpan(text: string, start: number, end: number): IndexRange | null {
  let s = start;
  let e = end;
  while (s < e && isWhitespace(text[s])) s += 1;
  while (e > s && isWhitespace(text[e - 1])) e -= 1;
  if (e <= s) return null;
  return { start: s, end: e };
}

/**
 * Complete JSON objects/arrays in prose. Skipped so a pasted payload is not
 * scored as a sentence. Unclosed `{` is left in prose (utility, not live).
 */
function findCompleteJsonRanges(text: string, code: readonly IndexRange[]): IndexRange[] {
  const ranges: IndexRange[] = [];
  let i = 0;
  while (i < text.length) {
    const jumped = skipClaimedIndex(i, code);
    if (jumped !== i) {
      i = jumped;
      continue;
    }
    const ch = text[i];
    if ((ch === "{" || ch === "[") && isJsonStart(text, i)) {
      const extracted = extractJsonAt(text, i);
      if (extracted) {
        ranges.push({ start: i, end: extracted.end });
        i = extracted.end;
        continue;
      }
    }
    i += 1;
  }
  return ranges;
}

/**
 * Split prose into sentences with original indexes. Code fences, inline
 * code, and complete JSON are jumped — they never become candidates.
 */
export function splitSentences(text: string): Candidate[] {
  const code = findCodeProtectedRanges(text);
  const skip = mergeRanges([...code, ...findCompleteJsonRanges(text, code)]);

  const out: Candidate[] = [];
  let sentStart = -1;

  const flush = (end: number): void => {
    if (sentStart < 0) return;
    const span = trimSpan(text, sentStart, end);
    sentStart = -1;
    if (!span) return;
    const slice = text.slice(span.start, span.end);
    if (!slice) return;
    out.push({
      start: span.start,
      end: span.end,
      text: slice,
      tokens: tokenize(slice),
    });
  };

  let i = 0;
  while (i < text.length) {
    const jumped = skipClaimedIndex(i, skip);
    if (jumped !== i) {
      flush(i);
      i = jumped;
      continue;
    }

    if (sentStart < 0 && !isWhitespace(text[i])) sentStart = i;

    if (isSentenceEnd(text, i)) {
      let end = i + 1;
      while (end < text.length && isClosingQuote(text[end])) end += 1;
      flush(end);
      i = end;
      continue;
    }

    if (text[i] === "\n" && text[i + 1] === "\n") {
      flush(i);
      i += 2;
      continue;
    }

    i += 1;
  }
  flush(text.length);
  return out;
}

/** Lowercased alphanumeric tokens; stopwords kept out of the bag. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const re = /[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    if (!raw) continue;
    const folded = raw.replace(/’/g, "'").toLowerCase();
    if (folded.length < 2) continue;
    if (STOPWORDS.has(folded)) continue;
    tokens.push(folded);
  }
  return tokens;
}

function termFreq(tokens: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function l2(vec: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const v of vec.values()) sum += v * v;
  return Math.sqrt(sum);
}

function cosine(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, av] of small) {
    const bv = large.get(k);
    if (bv !== undefined) dot += av * bv;
  }
  const na = l2(a);
  const nb = l2(b);
  if (na === 0 || nb === 0) return 0;
  return dot / (na * nb);
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function minMax(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  let min = values[0] ?? 0;
  let max = min;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (span <= 1e-12) return values.map(() => 0);
  return values.map((v) => (v - min) / span);
}

/** Document-wide counts used by Luhn (significant = non-stop, df >= 2 or top-k). */
function significantTerms(candidates: readonly Candidate[]): Set<string> {
  const df = new Map<string, number>();
  for (const c of candidates) {
    for (const t of new Set(c.tokens)) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const sig = new Set<string>();
  const n = candidates.length;
  for (const [term, count] of df) {
    // Mid-frequency: appears in at least two sentences, or in a short doc
    // at least twice in the bag, and not in almost every sentence.
    if (n <= 2) {
      if (count >= 1) sig.add(term);
      continue;
    }
    if (count >= 2 && count < n) sig.add(term);
  }
  if (sig.size === 0) {
    for (const [term] of df) sig.add(term);
  }
  return sig;
}

function luhnScore(tokens: readonly string[], significant: ReadonlySet<string>): number {
  if (tokens.length === 0) return 0;
  let best = 0;
  let i = 0;
  while (i < tokens.length) {
    while (i < tokens.length && !significant.has(tokens[i] ?? "")) i += 1;
    if (i >= tokens.length) break;
    let clusterStart = i;
    let lastSig = i;
    let j = i + 1;
    while (j < tokens.length) {
      if (significant.has(tokens[j] ?? "")) {
        if (j - lastSig - 1 > LUHN_GAP) break;
        lastSig = j;
      }
      j += 1;
    }
    const cluster = tokens.slice(clusterStart, lastSig + 1);
    let sigCount = 0;
    for (const t of cluster) if (significant.has(t)) sigCount += 1;
    if (cluster.length > 0) {
      const score = (sigCount * sigCount) / cluster.length;
      if (score > best) best = score;
    }
    i = lastSig + 1;
  }
  return best;
}

function positionScore(index: number, n: number): number {
  if (n <= 1) return 1;
  const lead = 1 - (index / (n - 1)) * 0.7;
  if (index === n - 1) return Math.max(lead, 0.6);
  return lead;
}

function buildIdf(candidates: readonly Candidate[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const c of candidates) {
    for (const t of new Set(c.tokens)) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const n = candidates.length;
  const idf = new Map<string, number>();
  for (const [term, d] of df) {
    idf.set(term, Math.log((1 + n) / (1 + d)) + 1);
  }
  return idf;
}

function tfidfVector(
  tokens: readonly string[],
  idf: ReadonlyMap<string, number>,
): Map<string, number> {
  const tf = termFreq(tokens);
  const vec = new Map<string, number>();
  const len = Math.max(tokens.length, 1);
  for (const [term, count] of tf) {
    const w = idf.get(term);
    if (w === undefined) continue;
    vec.set(term, (count / len) * w);
  }
  return vec;
}

function centroid(vectors: readonly Map<string, number>[]): Map<string, number> {
  const acc = new Map<string, number>();
  if (vectors.length === 0) return acc;
  for (const vec of vectors) {
    for (const [k, v] of vec) acc.set(k, (acc.get(k) ?? 0) + v);
  }
  const n = vectors.length;
  for (const [k, v] of acc) acc.set(k, v / n);
  return acc;
}

function pageRank(weights: number[][]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const row = weights[i];
    if (!row) continue;
    let s = 0;
    for (const w of row) s += w;
    out[i] = s;
  }

  let rank = new Array<number>(n).fill(1 / n);
  const teleport = (1 - PAGERANK_DAMPING) / n;

  for (let iter = 0; iter < PAGERANK_ITERS; iter++) {
    const next = new Array<number>(n).fill(teleport);
    for (let i = 0; i < n; i++) {
      const row = weights[i];
      const denom = out[i] ?? 0;
      const ri = rank[i] ?? 0;
      if (!row || denom <= 0) {
        const share = (PAGERANK_DAMPING * ri) / n;
        for (let j = 0; j < n; j++) next[j] = (next[j] ?? 0) + share;
        continue;
      }
      for (let j = 0; j < n; j++) {
        const w = row[j] ?? 0;
        if (w <= 0) continue;
        next[j] = (next[j] ?? 0) + PAGERANK_DAMPING * ri * (w / denom);
      }
    }
    rank = next;
  }
  return rank;
}

function targetCount(
  n: number,
  options: SummarizeOptions,
): number {
  if (n === 0) return 0;
  let cap = n;
  if (options.maxSentences !== undefined) {
    cap = Math.min(cap, Math.max(0, Math.floor(options.maxSentences)));
  }
  const useRatio =
    options.maxTokens === undefined && options.maxSentences === undefined;
  if (useRatio || options.ratio !== undefined) {
    const ratio = options.ratio ?? DEFAULT_RATIO;
    const fromRatio = Math.max(1, Math.round(n * Math.min(1, Math.max(0, ratio))));
    cap = Math.min(cap, fromRatio);
  }
  if (options.maxTokens !== undefined && options.maxSentences === undefined && options.ratio === undefined) {
    cap = n;
  }
  return Math.max(0, Math.min(n, cap));
}

function mmrSelect(
  scores: readonly number[],
  tokens: readonly (readonly string[])[],
  vectors: readonly Map<string, number>[],
  lambda: number,
  maxKeep: number,
  tokenBudget: number | undefined,
  sentenceTexts: readonly string[],
  tokenizer: (t: string) => number,
): boolean[] {
  const n = scores.length;
  const selected = new Array<boolean>(n).fill(false);
  const picked: number[] = [];
  let usedTokens = 0;

  const fits = (i: number): boolean => {
    if (tokenBudget === undefined) return true;
    const extra = tokenizer(sentenceTexts[i] ?? "");
    if (picked.length === 0) return extra <= tokenBudget || tokenBudget > 0;
    return usedTokens + extra <= tokenBudget;
  };

  while (picked.length < maxKeep) {
    let best = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < n; i++) {
      if (selected[i] || !fits(i)) continue;
      const rel = scores[i] ?? 0;
      let red = 0;
      for (const j of picked) {
        const simVec = cosine(vectors[i] ?? new Map(), vectors[j] ?? new Map());
        const simJac = jaccard(tokens[i] ?? [], tokens[j] ?? []);
        red = Math.max(red, Math.max(simVec, simJac));
      }
      const mmr = lambda * rel - (1 - lambda) * red;
      if (mmr > bestVal) {
        bestVal = mmr;
        best = i;
      }
    }
    if (best < 0) break;
    selected[best] = true;
    picked.push(best);
    usedTokens += tokenizer(sentenceTexts[best] ?? "");
  }

  // Nothing fit the budget: keep the highest-scoring sentence anyway so the
  // caller gets a non-empty extract when the source is a single long line.
  if (picked.length === 0 && n > 0 && tokenBudget !== undefined && tokenBudget > 0) {
    let best = 0;
    for (let i = 1; i < n; i++) {
      if ((scores[i] ?? 0) > (scores[best] ?? 0)) best = i;
    }
    selected[best] = true;
  }

  return selected;
}

function resolveLambda(lambda: number | undefined): number {
  if (lambda === undefined) return DEFAULT_MMR_LAMBDA;
  if (Number.isNaN(lambda)) return DEFAULT_MMR_LAMBDA;
  return Math.min(1, Math.max(0, lambda));
}

/**
 * Extract a token-budgeted summary by picking existing sentences.
 *
 * Never throws. Empty / whitespace input returns an empty summary.
 * Already-short text (one sentence, or under `maxTokens`) is returned as-is.
 */
export function summarize(text: string, options?: SummarizeOptions): SummarizeResult {
  const empty: SummarizeResult = { summary: "", sentences: [] };
  if (!text || !text.trim()) return empty;

  try {
    const candidates = splitSentences(text);
    if (candidates.length === 0) return empty;

    const tokenizer = options?.tokenizer ?? estimateTokens;
    const method = options?.method ?? "fast";
    const lambda = resolveLambda(options?.lambda);
    const n = candidates.length;

    if (options?.maxTokens !== undefined && options.maxTokens <= 0) {
      return {
        summary: "",
        sentences: candidates.map((c) => ({
          start: c.start,
          end: c.end,
          text: c.text,
          score: 0,
          selected: false,
        })),
      };
    }

    if (n === 1) {
      const only = candidates[0];
      if (!only) return empty;
      return {
        summary: only.text,
        sentences: [
          {
            start: only.start,
            end: only.end,
            text: only.text,
            score: 1,
            selected: true,
          },
        ],
      };
    }

    const idf = buildIdf(candidates);
    const vectors = candidates.map((c) => tfidfVector(c.tokens, idf));
    const center = centroid(vectors);
    const tfidfScores = vectors.map((v) => cosine(v, center));

    const significant = significantTerms(candidates);
    const luhnScores = candidates.map((c) => luhnScore(c.tokens, significant));
    const posScores = candidates.map((_, i) => positionScore(i, n));

    let queryScores = candidates.map(() => 0);
    const query = options?.query?.trim();
    if (query) {
      const qVec = tfidfVector(tokenize(query), idf);
      queryScores = vectors.map((v) => cosine(v, qVec));
    }

    const luhnN = minMax(luhnScores);
    const tfidfN = minMax(tfidfScores);
    const posN = minMax(posScores);
    const queryN = minMax(queryScores);
    const hasQuery = Boolean(query);

    let relevance = new Array<number>(n).fill(0);
    if (method === "textrank" && n <= TEXTRANK_SENTENCE_CAP) {
      const weights: number[][] = [];
      for (let i = 0; i < n; i++) {
        const row = new Array<number>(n).fill(0);
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const sim = cosine(vectors[i] ?? new Map(), vectors[j] ?? new Map());
          row[j] = sim > 0.05 ? sim : 0;
        }
        weights.push(row);
      }
      const rank = minMax(pageRank(weights));
      for (let i = 0; i < n; i++) {
        const r = rank[i] ?? 0;
        const q = hasQuery ? (queryN[i] ?? 0) : 0;
        const p = posN[i] ?? 0;
        relevance[i] = hasQuery ? 0.7 * r + 0.2 * q + 0.1 * p : 0.85 * r + 0.15 * p;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const l = luhnN[i] ?? 0;
        const t = tfidfN[i] ?? 0;
        const p = posN[i] ?? 0;
        const q = queryN[i] ?? 0;
        relevance[i] = hasQuery
          ? 0.25 * l + 0.25 * t + 0.1 * p + 0.4 * q
          : 0.4 * l + 0.4 * t + 0.2 * p;
      }
    }

    const keep = targetCount(n, options ?? {});
    const selected = mmrSelect(
      relevance,
      candidates.map((c) => c.tokens),
      vectors,
      lambda,
      keep,
      options?.maxTokens,
      candidates.map((c) => c.text),
      tokenizer,
    );

    const sentences: SummarySentence[] = candidates.map((c, i) => ({
      start: c.start,
      end: c.end,
      text: c.text,
      score: relevance[i] ?? 0,
      selected: selected[i] ?? false,
    }));

    const summary = sentences
      .filter((s) => s.selected)
      .map((s) => s.text)
      .join(" ");

    return { summary, sentences };
  } catch {
    return empty;
  }
}
