/**
 * token-bakery — cook LLM prompts in the box, no model.
 *
 * Framework-agnostic (no React/Vue). Tree-shakeable ESM for browsers and
 * bundlers. Zero runtime dependencies.
 *
 * Values are rebound (`export const x = xImpl`) rather than `export { x }`
 * so Bun.build cannot DCE the import graph. Live re-exports of side-effect-free
 * modules currently emit an empty barrel.
 *
 * @packageDocumentation
 */

import {
  compress as compressImpl,
  findBloat as findBloatImpl,
  estimateTokens as estimateTokensImpl,
  CHARS_PER_TOKEN as charsPerTokenImpl,
  applyFinding as applyFindingImpl,
  applyFindings as applyFindingsImpl,
  HYGIENE_KINDS as hygieneKindsImpl,
} from "./engine";
import { PromptWatcher as PromptWatcherImpl } from "./PromptWatcher";
import {
  minifyJson as minifyJsonImpl,
  minifyJsonTable as minifyJsonTableImpl,
  flattenJsonValue as flattenJsonValueImpl,
  extractJsonAt as extractJsonAtImpl,
  isJsonStart as isJsonStartImpl,
  isUnclosedJsonAt as isUnclosedJsonAtImpl,
  encodeJsonValue as encodeJsonValueImpl,
  encodeJsonTable as encodeJsonTableImpl,
} from "./utils";
import { findProtectedRanges as findProtectedRangesImpl } from "./fences";
import { normalizeUnicode as normalizeUnicodeImpl } from "./unicode";
import {
  minifyYaml as minifyYamlImpl,
  minifyXmlHtml as minifyXmlHtmlImpl,
  minifyMarkdown as minifyMarkdownImpl,
  minifyCode as minifyCodeImpl,
  minifyCsvTsv as minifyCsvTsvImpl,
} from "./minify";
import { summarize as summarizeImpl } from "./summarize";
import { findHygiene as findHygieneImpl } from "./hygiene";
import {
  longestCommonPrefix as longestCommonPrefixImpl,
  cacheablePrefixEnd as cacheablePrefixEndImpl,
} from "./prefix";
import {
  diffFindings as diffFindingsImpl,
  findingId as findingIdImpl,
} from "./delta";

export type {
  CompressOptions,
  BloatFinding,
  FindingKind,
  FindingSeverity,
  ApplyFindingsOptions,
} from "./engine";
export type {
  PromptWatcherOptions,
  PromptWatcherEvents,
  OptimizationReadyPayload,
} from "./PromptWatcher";
export type { JsonPrimitive, MinifyJsonOptions } from "./utils";
export type { IndexRange } from "./fences";
export type {
  SummarizeOptions,
  SummarizeResult,
  SummarySentence,
} from "./summarize";
export type { HygieneOptions, HygieneKind } from "./hygiene";
export type { FindingDelta } from "./delta";

export const compress = compressImpl;
export const findBloat = findBloatImpl;
export const estimateTokens = estimateTokensImpl;
export const CHARS_PER_TOKEN = charsPerTokenImpl;
export const applyFinding = applyFindingImpl;
export const applyFindings = applyFindingsImpl;
export const HYGIENE_KINDS = hygieneKindsImpl;
/** Class value + instance type (same name), so `new PromptWatcher()` and `w: PromptWatcher` both work. */
export const PromptWatcher = PromptWatcherImpl;
export type PromptWatcher = InstanceType<typeof PromptWatcherImpl>;
export const minifyJson = minifyJsonImpl;
export const minifyJsonTable = minifyJsonTableImpl;
export const flattenJsonValue = flattenJsonValueImpl;
export const extractJsonAt = extractJsonAtImpl;
export const isJsonStart = isJsonStartImpl;
export const isUnclosedJsonAt = isUnclosedJsonAtImpl;
export const encodeJsonValue = encodeJsonValueImpl;
export const encodeJsonTable = encodeJsonTableImpl;
export const findProtectedRanges = findProtectedRangesImpl;
export const normalizeUnicode = normalizeUnicodeImpl;
export const minifyYaml = minifyYamlImpl;
export const minifyXmlHtml = minifyXmlHtmlImpl;
export const minifyMarkdown = minifyMarkdownImpl;
export const minifyCode = minifyCodeImpl;
export const minifyCsvTsv = minifyCsvTsvImpl;
export const summarize = summarizeImpl;
export const findHygiene = findHygieneImpl;
export const longestCommonPrefix = longestCommonPrefixImpl;
export const cacheablePrefixEnd = cacheablePrefixEndImpl;
export const diffFindings = diffFindingsImpl;
export const findingId = findingIdImpl;
