/**
 * Heuristic prompt-compression engine.
 *
 * LLM tokens are expensive. Everyday English (especially "polite" chat with
 * assistants) burns them on filler, hedges, and multi-word phrases that collapse
 * to a single shorter synonym. This module is deliberately **dictionary +
 * longest-match**, not an LLM: it is deterministic, fast enough for keystroke
 * debounce, and safe to run in the browser.
 *
 * Matching rules:
 * - Case-insensitive; curly/smart apostrophes fold to ASCII `'`.
 * - Whole-phrase only (custom word boundaries so `don't` stays one token).
 * - Longest match first, left-to-right, non-overlapping — so
 *   "I was wondering if you could please" wins over "could you please".
 * - `start` / `end` on findings are indexes into the **original** string
 *   (`text.slice(start, end) === originalText`) for highlighter UIs.
 * - Protected ranges (fences, inline code, URLs, unclosed JSON, …) are skipped.
 *
 * Pass order in {@link findBloat}:
 * 1. Protected ranges (fences, inline code, URLs, unclosed JSON, …)
 * 2. Unicode findings (NBSP, BOM, ZWSP, smart quotes, ellipsis)
 * 3. Complete JSON blobs → compact, or CSV-table if a uniform object
 *    array is strictly shorter
 * 4. Complete markdown tables → TSV
 * 5. Markdown/HTML chrome
 * 6. Consecutive exact line / paragraph dedup
 * 7. Parenthetical asides (`strictMode` / `stripAsides`) — before the
 *    dictionary so `(by the way)` is one empty span, not leftover `()`
 * 8. Dictionary: filler, collapses, tautologies, abbreviations, contractions
 * 9. Tokenizer / heuristic gate: drop findings with no token savings
 * 10. Hygiene (secrets / PII / injection) — highlight only. If a hygiene
 *     span overlaps a compression finding, the **compression finding is
 *     dropped** so we never fold a secret into the dough. Default on;
 *     `hygiene: false` skips.
 * 11. {@link compress} applies auto-fixable spans via {@link applyFindings}
 *     (skips secret/pii/injection) then {@link normalizeWhitespace}
 *
 * Longest-first, left-to-right, non-overlapping. Indexes on the original.
 */

import { findAsides } from "./asides";
import { findMarkdownChrome } from "./chrome";
import { findDuplicateLines } from "./dedupe";
import {
  findProtectedRanges,
  mergeRanges,
  rangesOverlap,
  skipClaimedIndex,
  type IndexRange,
} from "./fences";
import { findHygiene, type HygieneOptions } from "./hygiene";

export type { HygieneOptions } from "./hygiene";
import { findMarkdownTables } from "./tables";
import { findUnicodeHits } from "./unicode";
import {
  encodeJsonTable,
  encodeJsonValue,
  extractJsonAt,
  isJsonStart,
  type MinifyJsonOptions,
} from "./utils";

/** Average characters per subword token (OpenAI-style ballpark). */
export const CHARS_PER_TOKEN = 4;

/**
 * Options for {@link compress} and {@link findBloat}.
 *
 * Defaults densify live drafts without surprising meaning changes: compact
 * JSON minify and markdown-chrome stripping are on; hedge/article stripping
 * stays opt-in.
 */
export interface CompressOptions {
  /**
   * When `true`, also strip hedge words ("basically", "sort of") and extra
   * conversational scaffolding ("it is important to note that").
   *
   * @default false
   */
  strictMode?: boolean;
  /**
   * When `true`, drop English articles (`a` / `an` / `the`). Useful for
   * telegram-style density; can hurt grammaticality.
   *
   * @default false
   */
  removeArticles?: boolean;
  /**
   * Minify complete JSON objects/arrays embedded in prose. `false` skips the
   * pass. `true` (and the default) uses `{ mode: "compact" }`. Flatten is
   * opt-in because it is lossy.
   *
   * @default true
   */
  minifyJson?: boolean | MinifyJsonOptions;
  /**
   * Strip markdown/HTML chrome: emphasis markers, decorative horizontal
   * rules, HTML comments, and simple wrapping tags (`<b>`, `<p>`, …).
   * Never fires inside fenced / inline code.
   *
   * @default true
   */
  stripMarkdown?: boolean;
  /**
   * Drop consecutive identical lines / paragraphs (trimmed). The finding
   * covers the 2nd+ copy. Skips fenced regions.
   *
   * @default true
   */
  dedupeLines?: boolean;
  /**
   * Strip parenthetical / em-dash discourse asides (`(by the way)`,
   * `— as mentioned earlier —`). Implied by `strictMode`. Explicit
   * `false` wins even under `strictMode`.
   *
   * @default false
   */
  stripAsides?: boolean;
  /**
   * Token counter used to drop findings that do not save tokens.
   * When omitted, {@link estimateTokens} (`ceil(chars / 4)`) is used,
   * with a character-length fallback so short contractions like
   * `do not` → `don't` (equal under chars/4) still apply.
   */
  tokenizer?: (text: string) => number;
  /**
   * Conventional abbreviations (`for example` → `e.g.`). Word-bounded,
   * longest-first. Never invents codes like `database` → `db`.
   *
   * @default true
   */
  abbreviations?: boolean;
  /**
   * Highlight secrets, PII, and jailbreak phrases on the same span
   * contract as compression findings. These kinds are **not** auto-applied
   * by {@link compress} / {@link applyFindings}. `false` skips the pass.
   * `true` (the default) enables all three categories; pass an object to
   * toggle individually (each defaults true when hygiene is on).
   *
   * Overlap: a hygiene span that intersects a compression finding drops
   * the compression finding (never fold a secret into the dough).
   *
   * @default true
   */
  hygiene?: boolean | HygieneOptions;
}

/** Internal resolved form — minifyJson is already normalized. */
interface ResolvedCompressOptions {
  strictMode: boolean;
  removeArticles: boolean;
  minifyJson: false | { mode: "compact" | "flatten" };
  stripMarkdown: boolean;
  dedupeLines: boolean;
  stripAsides: boolean;
  tokenizer: ((text: string) => number) | undefined;
  abbreviations: boolean;
  hygiene: false | { secrets: boolean; pii: boolean; injection: boolean };
}

/**
 * Classifier for a {@link BloatFinding}. Compression kinds are auto-fixable;
 * hygiene kinds (`secret` / `pii` / `injection`) are highlight-only by default.
 */
export type FindingKind =
  | "filler"
  | "collapse"
  | "contraction"
  | "abbreviation"
  | "hedge"
  | "article"
  | "unicode"
  | "json"
  | "table"
  | "chrome"
  | "dedupe"
  | "aside"
  | "secret"
  | "pii"
  | "injection";

export type FindingSeverity = "info" | "warn" | "critical";

/** Hygiene kinds are skipped by {@link applyFindings} unless `include` lists them. */
export const HYGIENE_KINDS: readonly FindingKind[] = [
  "secret",
  "pii",
  "injection",
];

const HYGIENE_KIND_SET: ReadonlySet<FindingKind> = new Set(HYGIENE_KINDS);

/**
 * One compressible (or highlight-only hygiene) span in the **original** input.
 *
 * `end` is exclusive so `original.slice(start, end) === originalText`.
 */
export interface BloatFinding {
  /** Inclusive UTF-16 index into the original string. */
  start: number;
  /** Exclusive UTF-16 index into the original string. */
  end: number;
  /** Exact substring of the original (preserves caller casing). */
  originalText: string;
  /**
   * Text that should replace `originalText`. Empty string means "strip this
   * span". Casing is adjusted to match the original when the replacement is
   * not an acronym. Hygiene findings set this equal to `originalText`.
   */
  suggestedReplacement: string;
  /** `estimateTokens(original) - estimateTokens(replacement)`, floored at 0. */
  tokensSaved: number;
  /** Why this span was reported. Required on every finding. */
  kind: FindingKind;
  /** Stable enough for UI checkboxes; defaults to `${kind}:${start}:${end}`. */
  id?: string;
  /**
   * Compression defaults `info`; PII is `warn`; secrets and injection are
   * `critical`.
   */
  severity?: FindingSeverity;
  /** Short human label, especially for hygiene findings. */
  message?: string;
}

export interface ApplyFindingsOptions {
  /**
   * Allowlist of kinds to apply. When omitted, every kind except
   * `secret` / `pii` / `injection` is applied (those would delete
   * sensitive draft text without consent).
   */
  include?: readonly FindingKind[];
}

/** Internal rewrite rule. `from` is stored lowercase. */
interface Rule {
  from: string;
  to: string;
  kind: FindingKind;
  /** Only applied when `strictMode` is on. */
  strict?: boolean;
  /** Only applied when `removeArticles` is on. */
  articles?: boolean;
  /** Only applied when `abbreviations` is on (default). */
  abbrev?: boolean;
}

/**
 * Polite / bureaucratic filler — stripped entirely (replacement `""`).
 * Longer phrases are listed first in spirit; compile-time sort is by length.
 */
const POLITE_FILLER: readonly string[] = [
  "i hope this email finds you well",
  "i hope this message finds you well",
  "i hope this finds you well",
  "i hope you're doing well",
  "i hope you are doing well",
  "hope this email finds you well",
  "hope this finds you well",
  "i just wanted to reach out to you",
  "i just wanted to reach out",
  "i wanted to reach out",
  "i was wondering if you could please",
  "i was wondering if you could",
  "i was wondering if you would",
  "i was wondering whether you could",
  "i was wondering if",
  "i was wondering whether",
  "i would appreciate it if you could",
  "i would appreciate it if you would",
  "i would appreciate it if",
  "i would appreciate if",
  "i would be grateful if you could",
  "i would be grateful if",
  "would it be possible for you to",
  "would it be possible to",
  "is there any chance you could",
  "is there any possibility that",
  "i kindly request that you",
  "i would like to kindly",
  "i would like to please",
  "i would like to ask you to",
  "i would like to",
  "i'd like to ask you to",
  "i'd like to",
  "i am writing to you to",
  "i am writing to",
  "i'm writing to you to",
  "i'm writing to",
  "if it's not too much trouble",
  "if it is not too much trouble",
  "if you don't mind me asking",
  "if you do not mind me asking",
  "if you don't mind",
  "if you do not mind",
  "i hope you don't mind",
  "i hope you do not mind",
  "when you get a chance",
  "when you have a moment",
  "when you have a chance",
  "at your earliest convenience",
  "please feel free to",
  "please do not hesitate to",
  "please don't hesitate to",
  "do not hesitate to",
  "don't hesitate to",
  "would you be able to",
  "would you mind if i",
  "would you mind",
  "could you please",
  "can you please",
  "please could you",
  "please would you",
  "just wanted to let you know that",
  "just wanted to let you know",
  "wanted to let you know that",
  "just wanted to say",
  "just wanted to",
  "i just wanted to",
  "i just wanted",
  "thank you in advance for your",
  "thank you in advance for",
  "thank you in advance",
  "thanks in advance for your",
  "thanks in advance",
  "looking forward to hearing from you",
  "looking forward to your response",
  "i look forward to hearing from you",
  "it would be greatly appreciated if",
  "it would be greatly appreciated",
  "it would be appreciated if",
  "it would be appreciated",
  "sorry to bother you but",
  "sorry to bother you",
  "sorry for bothering you",
  "sorry for the inconvenience",
  "i apologize for the inconvenience",
  "pardon me for asking",
  "to whom it may concern",
  "for your information",
  "as per my last email",
  "as per our conversation",
  "if at all possible",
  "if you would be so kind as to",
  "if you would be so kind",
  "kindly please",
];

/**
 * Extra scaffolding stripped only in `strictMode`. These often still carry a
 * little interpersonal signal, so they stay opt-in.
 */
const STRICT_FILLER: readonly string[] = [
  "let me know if you have any questions",
  "let me know if you need anything else",
  "let me know if you need anything",
  "let me know if that makes sense",
  "please let me know if you have any questions",
  "it is important to note that",
  "it is important to note",
  "it is worth noting that",
  "it is worth mentioning that",
  "it should be noted that",
  "it should be pointed out that",
  "it is interesting to note that",
  "it goes without saying that",
  "it goes without saying",
  "needless to say that",
  "needless to say",
  "it is clear that",
  "it is obvious that",
  "it is evident that",
  "there is no doubt that",
  "there is no question that",
  "please be advised that",
  "please note that",
  "for what it's worth",
  "for what it is worth",
  "to be perfectly honest",
  "to be honest with you",
  "to be honest",
  "to tell you the truth",
  "to tell the truth",
  "if i may say so",
  "if i may",
  "if you will",
  "as a matter of fact",
  "all things considered",
  "at the end of the day",
  "the bottom line is that",
  "the bottom line is",
  "with all due respect",
  "if that makes sense",
  "does that make sense",
  "just a heads up that",
  "just a heads up",
  "heads up that",
  "as you may or may not know",
  "as you may know",
  "as you know",
  "as i mentioned above",
  "as i mentioned earlier",
  "as i mentioned",
  "as mentioned above",
  "as mentioned earlier",
  "as mentioned",
  "like i said",
  "as i said",
  "you know what i mean",
  "if you know what i mean",
  "i mean",
  "you know",
  "by the way",
  "feel free to",
  "in this particular case",
  "in this particular instance",
  "in the process of",
  "for all intents and purposes",
  "it is my opinion that",
  "i am of the opinion that",
  "in my personal opinion",
  "in my humble opinion",
  "in my opinion",
  "from my perspective",
  "the possibility exists that",
  "there is a possibility that",
];

/**
 * Hedge / waffle words. Aggressive: they are common in real content, so they
 * only strip under `strictMode`. Multi-word hedges listed before singles so
 * longest-match prefers "kind of" over nothing (both strip to empty anyway).
 */
const HEDGES: readonly string[] = [
  "more or less",
  "sort of",
  "kind of",
  "kinda",
  "sorta",
  "a bit",
  "a little bit",
  "i think that",
  "i think",
  "i believe that",
  "i believe",
  "i feel like",
  "it seems like",
  "it seems that",
  "it seems",
  "it appears that",
  "it appears",
  "basically",
  "actually",
  "literally",
  "honestly",
  "seriously",
  "really",
  "very",
  "quite",
  "rather",
  "somewhat",
  "perhaps",
  "maybe",
  "probably",
  "possibly",
  "arguably",
  "presumably",
  "supposedly",
  "apparently",
  "essentially",
  "relatively",
  "fairly",
  "just",
];

/**
 * Multi-token phrases → shorter synonyms. Applied in both modes.
 * Keep `from` longer than `to` or the rule is a no-op for tokens.
 */
const COLLAPSES: ReadonlyArray<readonly [string, string]> = [
  ["in spite of the fact that", "although"],
  ["despite the fact that", "although"],
  ["regardless of the fact that", "although"],
  ["notwithstanding the fact that", "although"],
  ["owing to the fact that", "because"],
  ["due to the fact that", "because"],
  ["on account of the fact that", "because"],
  ["in light of the fact that", "because"],
  ["in view of the fact that", "because"],
  ["given the fact that", "because"],
  ["for the reason that", "because"],
  ["as a consequence of", "because"],
  ["as a result of", "because"],
  ["the fact that", "that"],
  ["for the purpose of", "to"],
  ["in order that", "so"],
  ["in order for", "for"],
  ["in order to", "to"],
  ["so as to", "to"],
  ["with the aim of", "to"],
  ["in the event that", "if"],
  ["in the event of", "if"],
  ["in case of", "if"],
  ["the question as to whether", "whether"],
  ["whether or not", "whether"],
  ["as to whether", "whether"],
  ["at this moment in time", "now"],
  ["at this point in time", "now"],
  ["at the present moment", "now"],
  ["at the present time", "now"],
  ["at this time", "now"],
  ["at present", "now"],
  ["in this day and age", "today"],
  ["in the not too distant future", "soon"],
  ["in the near future", "soon"],
  ["as soon as possible", "ASAP"],
  ["until such time as", "until"],
  ["during the course of", "during"],
  ["in the course of", "during"],
  ["in close proximity to", "near"],
  ["in the vicinity of", "near"],
  ["prior to", "before"],
  ["subsequent to", "after"],
  ["in conjunction with", "with"],
  ["in combination with", "with"],
  ["with the exception of", "except"],
  ["in addition to", "besides"],
  ["as well as", "and"],
  ["in terms of", "regarding"],
  ["with regard to", "regarding"],
  ["with regards to", "regarding"],
  ["with respect to", "regarding"],
  ["in respect of", "regarding"],
  ["in relation to", "about"],
  ["pertaining to", "about"],
  ["with reference to", "regarding"],
  ["in connection with", "about"],
  ["in accordance with", "per"],
  ["by means of", "by"],
  ["by virtue of", "by"],
  ["on the part of", "by"],
  ["in the absence of", "without"],
  ["in the presence of", "with"],
  ["a large number of", "many"],
  ["a great number of", "many"],
  ["a large amount of", "much"],
  ["a great deal of", "much"],
  ["a wide range of", "many"],
  ["the vast majority of", "most"],
  ["a majority of", "most"],
  ["the majority of", "most"],
  ["a number of", "several"],
  ["a variety of", "various"],
  ["has the ability to", "can"],
  ["have the ability to", "can"],
  ["has the capacity to", "can"],
  ["is able to", "can"],
  ["are able to", "can"],
  ["is capable of", "can"],
  ["make a decision", "decide"],
  ["come to a conclusion", "conclude"],
  ["reach a conclusion", "conclude"],
  ["take into consideration", "consider"],
  ["take into account", "consider"],
  ["give consideration to", "consider"],
  ["perform an analysis of", "analyze"],
  ["make use of", "use"],
  ["is going to", "will"],
  ["are going to", "will"],
  ["on a regular basis", "regularly"],
  ["on a daily basis", "daily"],
  ["on a weekly basis", "weekly"],
  ["in a timely manner", "promptly"],
  ["it is necessary to", "must"],
  ["it is possible to", "can"],
  ["there is a need to", "must"],
  ["in the majority of cases", "usually"],
  ["in most cases", "usually"],
  ["in some cases", "sometimes"],
  ["in all cases", "always"],
  ["at all times", "always"],
  ["on the other hand", "however"],
  ["at the same time", "simultaneously"],
  ["in the same way", "similarly"],
  ["in a similar fashion", "similarly"],
  ["in a similar manner", "similarly"],
  ["for the most part", "mostly"],
  ["to a large extent", "largely"],
  ["to some extent", "partly"],
  ["all of a sudden", "suddenly"],
  ["once in a while", "occasionally"],
  ["from time to time", "occasionally"],
  ["every now and then", "occasionally"],
  ["in the long run", "eventually"],
  ["sooner or later", "eventually"],
  ["each and every", "every"],
  ["first and foremost", "first"],
  ["last but not least", "finally"],
  ["over and over again", "repeatedly"],
  ["again and again", "repeatedly"],
  ["time and time again", "repeatedly"],
  ["the end result", "the result"],
  ["end result", "result"],
  ["final outcome", "outcome"],
  ["future plans", "plans"],
  ["past history", "history"],
  ["unexpected surprise", "surprise"],
  ["absolutely essential", "essential"],
  ["completely eliminate", "eliminate"],
  ["advance planning", "planning"],
  ["new innovation", "innovation"],
  ["true fact", "fact"],
  ["basic fundamentals", "fundamentals"],
  ["close proximity", "proximity"],
  ["join together", "join"],
  ["revert back", "revert"],
  ["return back", "return"],
  ["still remain", "remain"],
  ["completely finish", "finish"],
  ["exactly the same", "the same"],
  ["various different", "various"],
  ["each individual", "each"],
  ["the reason why", "the reason"],
  ["period of time", "period"],
  ["point in time", "time"],
  ["small in size", "small"],
  ["large in size", "large"],
  ["few in number", "few"],
  ["general consensus", "consensus"],
  ["added bonus", "bonus"],
  ["crisis situation", "crisis"],
  ["had an effect on", "affected"],
  ["had an impact on", "affected"],
  ["in the middle of", "during"],
  ["under the circumstances", "given this"],
  ["atm machine", "ATM"],
  ["pin number", "PIN"],
  ["isbn number", "ISBN"],
  ["vin number", "VIN"],
  ["hiv virus", "HIV"],
  ["lcd display", "LCD"],
  ["ram memory", "RAM"],
  ["gps system", "GPS"],
  ["upc code", "UPC"],
  ["completely unique", "unique"],
  ["totally unique", "unique"],
  ["absolutely unique", "unique"],
  ["absolutely necessary", "necessary"],
  ["free gift", "gift"],
  ["actual fact", "fact"],
  ["honest truth", "truth"],
  ["assemble together", "assemble"],
  ["merge together", "merge"],
  ["combine together", "combine"],
  ["repeat again", "repeat"],
  ["recur again", "recur"],
  ["refer back", "refer"],
  ["reply back", "reply"],
  ["plan ahead", "plan"],
  ["postpone until later", "postpone"],
  ["descend down", "descend"],
  ["rise up", "rise"],
  ["sum total", "total"],
  ["invited guests", "guests"],
  ["regular routine", "routine"],
  ["new beginning", "beginning"],
  ["first began", "began"],
  ["advance warning", "warning"],
  ["current status", "status"],
  ["frozen ice", "ice"],
  ["round circle", "circle"],
  ["exact replica", "replica"],
  ["exact same", "same"],
  ["same exact", "same"],
  ["inner core", "core"],
  ["old adage", "adage"],
  ["passing fad", "fad"],
  ["serious crisis", "crisis"],
  ["still continues", "continues"],
  ["sudden surprise", "surprise"],
  ["unexpected emergency", "emergency"],
  ["annual anniversary", "anniversary"],
  ["foreign import", "import"],
  ["consensus of opinion", "consensus"],
  ["completely unanimous", "unanimous"],
  ["completely full", "full"],
  ["brief moment", "moment"],
  ["component parts", "parts"],
  ["visible to the eye", "visible"],
  ["warn in advance", "warn"],
  ["evolve over time", "evolve"],
  ["surrounded on all sides", "surrounded"],
  ["ultimate goal", "goal"],
];

/**
 * Negation-preserving contractions. These shrink two tokens to one without
 * dropping `not` / `n't` — `do not` becomes `don't`, never empty.
 *
 * Always on (not gated by strictMode). Longer phrases such as
 * "please do not hesitate to" still win via longest-match.
 */
const CONTRACTIONS: ReadonlyArray<readonly [string, string]> = [
  ["must not", "mustn't"],
  ["might not", "mightn't"],
  ["need not", "needn't"],
  ["does not", "doesn't"],
  ["did not", "didn't"],
  ["was not", "wasn't"],
  ["were not", "weren't"],
  ["have not", "haven't"],
  ["has not", "hasn't"],
  ["had not", "hadn't"],
  ["will not", "won't"],
  ["would not", "wouldn't"],
  ["could not", "couldn't"],
  ["should not", "shouldn't"],
  ["do not", "don't"],
  ["is not", "isn't"],
  ["are not", "aren't"],
  ["can not", "can't"],
  ["cannot", "can't"],
  ["they would", "they'd"],
  ["they will", "they'll"],
  ["they have", "they've"],
  ["they are", "they're"],
  ["you would", "you'd"],
  ["you will", "you'll"],
  ["you have", "you've"],
  ["you are", "you're"],
  ["she would", "she'd"],
  ["she will", "she'll"],
  ["she has", "she's"],
  ["she is", "she's"],
  ["he would", "he'd"],
  ["he will", "he'll"],
  ["he has", "he's"],
  ["he is", "he's"],
  ["we would", "we'd"],
  ["we will", "we'll"],
  ["we have", "we've"],
  ["we are", "we're"],
  ["i would", "i'd"],
  ["i will", "i'll"],
  ["i have", "i've"],
  ["i am", "i'm"],
  ["that would", "that'd"],
  ["that will", "that'll"],
  ["that has", "that's"],
  ["that is", "that's"],
  ["there would", "there'd"],
  ["there will", "there'll"],
  ["there has", "there's"],
  ["there is", "there's"],
  ["what would", "what'd"],
  ["what will", "what'll"],
  ["what has", "what's"],
  ["what is", "what's"],
  ["who would", "who'd"],
  ["who will", "who'll"],
  ["who has", "who's"],
  ["who is", "who's"],
  ["where is", "where's"],
  ["when is", "when's"],
  ["how is", "how's"],
  ["here is", "here's"],
  ["it would", "it'd"],
  ["it will", "it'll"],
  ["it has", "it's"],
  ["it is", "it's"],
  ["let us", "let's"],
];

/**
 * Conventional English abbreviations. Always-on by default; disable with
 * `abbreviations: false`. Bare `that is` is **not** mapped — it is the
 * copula contraction `that's`. Discourse `that is to say` → `i.e.`.
 *
 * `approximately` → `~` and `iff` are skipped (tokenizer-hostile / jargon).
 * Invented codes (`database` → `db`) are never added.
 */
const ABBREVIATIONS: ReadonlyArray<readonly [string, string]> = [
  ["that is to say", "i.e."],
  ["for example", "e.g."],
  ["for instance", "e.g."],
  ["in other words", "i.e."],
  ["and so forth.", "etc."],
  ["and so forth", "etc."],
  ["and so on.", "etc."],
  ["and so on", "etc."],
  ["et cetera.", "etc."],
  ["et cetera", "etc."],
  ["versus", "vs"],
  ["vs.", "vs"],
];

const ARTICLES: readonly string[] = ["the", "an", "a"];

/** Compiled lookup: first-character → rules already sorted longest-first. */
interface CompiledRules {
  byFirst: Map<string, Rule[]>;
}

const compiledCache = new Map<string, CompiledRules>();

function allRules(): Rule[] {
  const rules: Rule[] = [];
  for (const from of POLITE_FILLER) rules.push({ from, to: "", kind: "filler" });
  for (const from of STRICT_FILLER) {
    rules.push({ from, to: "", kind: "filler", strict: true });
  }
  for (const from of HEDGES) {
    rules.push({ from, to: "", kind: "hedge", strict: true });
  }
  for (const [from, to] of COLLAPSES) rules.push({ from, to, kind: "collapse" });
  for (const [from, to] of ABBREVIATIONS) {
    rules.push({ from, to, kind: "abbreviation", abbrev: true });
  }
  for (const [from, to] of CONTRACTIONS) {
    rules.push({ from, to, kind: "contraction" });
  }
  for (const from of ARTICLES) {
    rules.push({ from, to: "", kind: "article", articles: true });
  }
  return rules;
}

const RULES: readonly Rule[] = allRules();

function resolveMinifyJson(
  value: boolean | MinifyJsonOptions | undefined,
): false | { mode: "compact" | "flatten" } {
  if (value === false) return false;
  if (value === true || value === undefined) return { mode: "compact" };
  return { mode: value.mode ?? "compact" };
}

function resolveHygiene(
  value: boolean | HygieneOptions | undefined,
): false | { secrets: boolean; pii: boolean; injection: boolean } {
  if (value === false) return false;
  const src = value === true || value === undefined ? {} : value;
  const resolved = {
    secrets: src.secrets ?? true,
    pii: src.pii ?? true,
    injection: src.injection ?? true,
  };
  if (!resolved.secrets && !resolved.pii && !resolved.injection) return false;
  return resolved;
}

function resolveOptions(options?: CompressOptions): ResolvedCompressOptions {
  return {
    strictMode: options?.strictMode ?? false,
    removeArticles: options?.removeArticles ?? false,
    minifyJson: resolveMinifyJson(options?.minifyJson),
    stripMarkdown: options?.stripMarkdown ?? true,
    dedupeLines: options?.dedupeLines ?? true,
    stripAsides: options?.stripAsides ?? options?.strictMode ?? false,
    tokenizer: options?.tokenizer,
    abbreviations: options?.abbreviations ?? true,
    hygiene: resolveHygiene(options?.hygiene),
  };
}

function getCompiled(options: ResolvedCompressOptions): CompiledRules {
  const key = `${options.strictMode}:${options.removeArticles}:${options.abbreviations}`;
  const cached = compiledCache.get(key);
  if (cached) return cached;

  const applicable = RULES.filter((rule) => {
    if (rule.strict && !options.strictMode) return false;
    if (rule.articles && !options.removeArticles) return false;
    if (rule.abbrev && !options.abbreviations) return false;
    return true;
  }).sort((a, b) => b.from.length - a.from.length);

  const byFirst = new Map<string, Rule[]>();
  for (const rule of applicable) {
    const first = rule.from.charAt(0);
    let bucket = byFirst.get(first);
    if (!bucket) {
      bucket = [];
      byFirst.set(first, bucket);
    }
    bucket.push(rule);
  }

  const compiled = { byFirst };
  compiledCache.set(key, compiled);
  return compiled;
}

/**
 * Word-character test used for phrase boundaries.
 * Apostrophes count so contractions (`don't`, `you're`) are a single word.
 */
function isWordChar(char: string | undefined): boolean {
  if (char === undefined || char.length === 0) return false;
  const c = char.charCodeAt(0);
  if (c >= 65 && c <= 90) return true; // A-Z
  if (c >= 97 && c <= 122) return true; // a-z
  if (c >= 48 && c <= 57) return true; // 0-9
  // ASCII apostrophe or Unicode right single quotation mark
  return c === 39 || c === 8217;
}

function foldChar(char: string): string {
  // U+2019 RIGHT SINGLE QUOTATION MARK → ASCII apostrophe
  if (char.charCodeAt(0) === 8217) return "'";
  return char.toLowerCase();
}

/**
 * Case-insensitive, apostrophe-folded equality of `text[index .. index+len)`.
 */
function phraseMatchesAt(text: string, index: number, phrase: string): boolean {
  const len = phrase.length;
  if (index + len > text.length) return false;
  if (isWordChar(index === 0 ? undefined : text[index - 1])) return false;
  if (isWordChar(text[index + len])) return false;

  for (let i = 0; i < len; i++) {
    const a = text[index + i];
    const b = phrase[i];
    if (a === undefined || b === undefined) return false;
    if (foldChar(a) !== b) return false;
  }
  return true;
}

/**
 * Title-case or shout the replacement so UI diffs look natural.
 * Acronyms (`ASAP`) are left alone.
 */
function applyCasing(original: string, replacement: string): string {
  if (!replacement) return "";
  if (replacement === replacement.toUpperCase() && /[A-Z]/.test(replacement)) {
    return replacement;
  }

  const hasLower = /[a-z]/.test(original);
  const hasUpper = /[A-Z]/.test(original);
  if (hasUpper && !hasLower) {
    return replacement.toUpperCase();
  }

  const first = original.charAt(0);
  if (first !== first.toLowerCase() && first === first.toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * Collapse horizontal ASCII spaces, trim space at line edges, cap blank
 * lines at one. Tabs are preserved so markdown-table → TSV findings survive
 * {@link compress}. Applied only by {@link compress}, never by
 * {@link findBloat}, so highlighters still see the author's original spacing.
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/ +/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Cheap token estimate: `ceil(chars / 4)`. Empty string is 0 tokens.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function toFinding(
  text: string,
  start: number,
  end: number,
  suggestedReplacement: string,
  kind: FindingKind,
  tokenizer?: (t: string) => number,
  extra?: { severity?: FindingSeverity; message?: string },
): BloatFinding {
  const originalText = text.slice(start, end);
  const count = tokenizer ?? estimateTokens;
  return {
    start,
    end,
    originalText,
    suggestedReplacement,
    tokensSaved: Math.max(0, count(originalText) - count(suggestedReplacement)),
    kind,
    id: `${kind}:${start}:${end}`,
    severity: extra?.severity ?? "info",
    ...(extra?.message ? { message: extra.message } : {}),
  };
}

function claim(ranges: IndexRange[], start: number, end: number): void {
  ranges.push({ start, end });
}

function pushHits(
  text: string,
  hits: ReadonlyArray<{ start: number; end: number; replacement: string }>,
  findings: BloatFinding[],
  claimed: IndexRange[],
  kind: FindingKind,
  tokenizer?: (t: string) => number,
): void {
  for (const hit of hits) {
    findings.push(
      toFinding(text, hit.start, hit.end, hit.replacement, kind, tokenizer),
    );
    claim(claimed, hit.start, hit.end);
  }
}

/**
 * Keep findings that actually save tokens.
 *
 * Custom `tokenizer`: require `count(original) > count(replacement)`.
 * Default heuristic: also keep when the replacement is strictly shorter in
 * characters (so `do not` → `don't` survives chars/4 rounding) or when
 * `allowEqual` is set (unicode ASCII folds of the same length).
 */
function findingSavesTokens(
  finding: BloatFinding,
  tokenizer: ((text: string) => number) | undefined,
  allowEqual: boolean,
): boolean {
  const count = tokenizer ?? estimateTokens;
  const orig = count(finding.originalText);
  const next = count(finding.suggestedReplacement);
  if (orig > next) return true;
  if (tokenizer) return false;
  if (finding.suggestedReplacement.length < finding.originalText.length) {
    return true;
  }
  return allowEqual && orig >= next;
}

/**
 * Complete JSON blobs in prose. One finding covers the whole blob when the
 * encoded form is shorter. Every complete blob is claimed either way so later
 * passes cannot rewrite keys/strings inside already-valid JSON.
 */
function collectJsonFindings(
  text: string,
  mode: "compact" | "flatten",
  claimed: IndexRange[],
  tokenizer?: (t: string) => number,
): BloatFinding[] {
  const findings: BloatFinding[] = [];
  let i = 0;

  while (i < text.length) {
    const jumped = skipClaimedIndex(i, claimed);
    if (jumped !== i) {
      i = jumped;
      continue;
    }

    const ch = text[i];
    if ((ch === "{" || ch === "[") && isJsonStart(text, i)) {
      const extracted = extractJsonAt(text, i);
      if (extracted && !rangesOverlap(i, extracted.end, claimed)) {
        const compact =
          mode === "flatten"
            ? encodeJsonValue(extracted.value, "flatten")
            : encodeJsonValue(extracted.value, "compact");
        const table =
          mode === "flatten" ? null : encodeJsonTable(extracted.value);
        const useTable =
          table !== null && table.length < compact.length;
        const replacement = useTable ? table : compact;
        const kind: FindingKind = useTable ? "table" : "json";
        const original = text.slice(i, extracted.end);
        claim(claimed, i, extracted.end);
        if (replacement.length < original.length) {
          findings.push(
            toFinding(text, i, extracted.end, replacement, kind, tokenizer),
          );
        }
        i = extracted.end;
        continue;
      }
    }

    i += 1;
  }

  return findings;
}

function collectDictionaryFindings(
  text: string,
  compiled: CompiledRules,
  skip: readonly IndexRange[],
  tokenizer?: (t: string) => number,
): BloatFinding[] {
  const findings: BloatFinding[] = [];
  let i = 0;

  while (i < text.length) {
    const jumped = skipClaimedIndex(i, skip);
    if (jumped !== i) {
      i = jumped;
      continue;
    }

    const first = foldChar(text.charAt(i));
    const bucket = compiled.byFirst.get(first);
    let matched: Rule | undefined;

    if (bucket) {
      for (const rule of bucket) {
        if (!phraseMatchesAt(text, i, rule.from)) continue;
        const end = i + rule.from.length;
        if (rangesOverlap(i, end, skip)) continue;
        matched = rule;
        break; // bucket is longest-first
      }
    }

    if (matched) {
      const end = i + matched.from.length;
      const originalText = text.slice(i, end);
      const suggestedReplacement = applyCasing(originalText, matched.to);
      findings.push(
        toFinding(
          text,
          i,
          end,
          suggestedReplacement,
          matched.kind,
          tokenizer,
        ),
      );
      i = end;
      continue;
    }

    i += 1;
  }

  return findings;
}

/**
 * Scan `text` left-to-right and report every non-overlapping compressible span.
 *
 * Indexes are into `text` as given (no whitespace rewrite). Use them to paint
 * highlights in a textarea or contenteditable. Never throws — unexpected
 * errors yield an empty list so a keystroke handler cannot crash the page.
 */
export function findBloat(
  text: string,
  options?: CompressOptions,
): BloatFinding[] {
  if (!text) return [];

  try {
    const resolved = resolveOptions(options);
    const tok = resolved.tokenizer;
    const protectedRanges = findProtectedRanges(text);
    const claimed: IndexRange[] = [...protectedRanges];
    const findings: BloatFinding[] = [];
    const unicodeIds = new Set<string>();

    const unicodeHits = findUnicodeHits(text, mergeRanges(claimed));
    for (const hit of unicodeHits) {
      const finding = toFinding(
        text,
        hit.start,
        hit.end,
        hit.replacement,
        "unicode",
        tok,
      );
      findings.push(finding);
      unicodeIds.add(`${finding.start}:${finding.end}`);
      claim(claimed, hit.start, hit.end);
    }

    if (resolved.minifyJson) {
      const jsonFindings = collectJsonFindings(
        text,
        resolved.minifyJson.mode,
        claimed,
        tok,
      );
      findings.push(...jsonFindings);
    }

    if (resolved.stripMarkdown) {
      const tableHits = findMarkdownTables(text, mergeRanges(claimed));
      pushHits(text, tableHits, findings, claimed, "table", tok);

      const chromeHits = findMarkdownChrome(text, mergeRanges(claimed));
      pushHits(text, chromeHits, findings, claimed, "chrome", tok);
    }

    if (resolved.dedupeLines) {
      const dupes = findDuplicateLines(text, mergeRanges(claimed));
      pushHits(text, dupes, findings, claimed, "dedupe", tok);
    }

    if (resolved.stripAsides) {
      const asides = findAsides(text, mergeRanges(claimed));
      pushHits(text, asides, findings, claimed, "aside", tok);
    }

    const dictFindings = collectDictionaryFindings(
      text,
      getCompiled(resolved),
      mergeRanges(claimed),
      tok,
    );
    findings.push(...dictFindings);

    const kept = findings.filter((finding) =>
      findingSavesTokens(
        finding,
        tok,
        unicodeIds.has(`${finding.start}:${finding.end}`),
      ),
    );

    let merged = kept;
    if (resolved.hygiene) {
      const hygieneHits = findHygiene(text, resolved.hygiene);
      if (hygieneHits.length > 0) {
        merged = kept.filter(
          (finding) =>
            !hygieneHits.some((hit) =>
              rangesOverlap(finding.start, finding.end, [
                { start: hit.start, end: hit.end },
              ]),
            ),
        );
        merged = [...merged, ...hygieneHits];
      }
    }

    merged.sort((a, b) => a.start - b.start);
    return merged;
  } catch {
    return [];
  }
}

/**
 * Apply one finding to `text`. Verifies `originalText` when provided; on
 * mismatch returns `text` unchanged (never throws, never corrupts).
 *
 * Hosts that show a checkbox per finding should call this (or
 * {@link applyFindings} with `include`) for the spans the user accepted —
 * including hygiene, which is consent.
 */
export function applyFinding(
  text: string,
  finding: Pick<
    BloatFinding,
    "start" | "end" | "suggestedReplacement" | "originalText"
  >,
): string {
  try {
    const { start, end, suggestedReplacement, originalText } = finding;
    if (
      start < 0 ||
      end > text.length ||
      start > end ||
      (typeof originalText === "string" &&
        text.slice(start, end) !== originalText)
    ) {
      return text;
    }
    return text.slice(0, start) + suggestedReplacement + text.slice(end);
  } catch {
    return text;
  }
}

function shouldApplyFinding(
  finding: BloatFinding,
  include: readonly FindingKind[] | undefined,
): boolean {
  if (include) return include.includes(finding.kind);
  return !HYGIENE_KIND_SET.has(finding.kind);
}

/**
 * Apply auto-fixable findings **right-to-left** (high `start` first) so
 * indexes stay valid. Skips a finding when `originalText` does not match
 * `text.slice(start, end)`. Hygiene kinds (`secret` / `pii` / `injection`)
 * are skipped unless `options.include` lists them — an empty replacement
 * would otherwise delete secrets from the draft without consent.
 *
 * Never throws.
 */
export function applyFindings(
  text: string,
  findings: readonly BloatFinding[],
  options?: ApplyFindingsOptions,
): string {
  try {
    const include = options?.include;
    const applicable = findings.filter((finding) =>
      shouldApplyFinding(finding, include),
    );
    const sorted = applicable
      .slice()
      .sort((a, b) => b.start - a.start || b.end - a.end);

    let result = text;
    for (const finding of sorted) {
      if (
        finding.start < 0 ||
        finding.end > text.length ||
        finding.start > finding.end
      ) {
        continue;
      }
      if (
        typeof finding.originalText === "string" &&
        text.slice(finding.start, finding.end) !== finding.originalText
      ) {
        continue;
      }
      result =
        result.slice(0, finding.start) +
        finding.suggestedReplacement +
        result.slice(finding.end);
    }
    return result;
  } catch {
    return text;
  }
}

/**
 * Rewrite `text` using the same rules as {@link findBloat}, then squeeze
 * leftover whitespace. Hygiene findings are reported by `findBloat` but
 * **not** applied here. Safe to call on every keystroke (pair with
 * {@link PromptWatcher} if you need debounce). Never throws.
 */
export function compress(text: string, options?: CompressOptions): string {
  try {
    const findings = findBloat(text, options);
    const result = applyFindings(text, findings);
    return normalizeWhitespace(result);
  } catch {
    try {
      return normalizeWhitespace(text);
    } catch {
      return text;
    }
  }
}
