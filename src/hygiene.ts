/**
 * Secrets / PII / prompt-injection highlighter.
 *
 * Same span contract as {@link findBloat}: `start`/`end` index the original
 * string. Findings are **highlight-only** — `suggestedReplacement` equals
 * `originalText`, and {@link applyFindings} skips these kinds by default so
 * a live compressor cannot delete keys or PII from the user's draft.
 *
 * Hits inside fenced / inline code are skipped ({@link findCodeProtectedRanges}).
 * Emails that sit only inside a URL are skipped; emails in prose are flagged
 * even though the compressor already protects them from rewriting.
 *
 * Conservative regexes, never throws.
 */

import {
  findCodeProtectedRanges,
  mergeRanges,
  rangesOverlap,
  type IndexRange,
} from "./fences";
import type { BloatFinding } from "./engine";

export type HygieneKind = "secret" | "pii" | "injection";

export interface HygieneOptions {
  /** API keys, JWTs, private-key blocks, Bearer tokens. @default true */
  secrets?: boolean;
  /** Emails, US phones, SSN, Luhn-valid cards. @default true */
  pii?: boolean;
  /** Jailbreak / "ignore previous instructions" phrases. @default true */
  injection?: boolean;
}

const ZWSP_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/;

function toHygieneFinding(
  text: string,
  start: number,
  end: number,
  kind: HygieneKind,
  severity: "warn" | "critical",
  message: string,
): BloatFinding {
  const originalText = text.slice(start, end);
  return {
    start,
    end,
    originalText,
    suggestedReplacement: originalText,
    tokensSaved: 0,
    kind,
    id: `${kind}:${start}:${end}`,
    severity,
    message,
  };
}

function pushRegex(
  text: string,
  pattern: RegExp,
  skip: readonly IndexRange[],
  claimed: IndexRange[],
  findings: BloatFinding[],
  kind: HygieneKind,
  severity: "warn" | "critical",
  message: string,
): void {
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const matched = match[0];
    if (!matched) {
      re.lastIndex += 1;
      continue;
    }
    const start = match.index;
    const end = start + matched.length;
    if (rangesOverlap(start, end, skip) || rangesOverlap(start, end, claimed)) {
      continue;
    }
    findings.push(toHygieneFinding(text, start, end, kind, severity, message));
    claimed.push({ start, end });
  }
}

/** Collect http(s) / www URL spans so emails inside them are not flagged. */
function findUrlRanges(text: string): IndexRange[] {
  const ranges: IndexRange[] = [];
  const patterns = [
    /https?:\/\/[^\s<>"'`]+/gi,
    /www\.[^\s<>"'`]+/gi,
  ];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const raw = match[0];
      if (!raw) {
        re.lastIndex += 1;
        continue;
      }
      const kept = raw.replace(/[.,;:!?)\]>'"]+$/u, "");
      if (!kept) continue;
      ranges.push({ start: match.index, end: match.index + kept.length });
    }
  }
  return mergeRanges(ranges);
}

function luhnOk(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * 13–19 digit runs with optional spaces/dashes. Luhn-checked so random
 * 16-digit numbers are not flagged.
 */
function collectCards(
  text: string,
  skip: readonly IndexRange[],
  claimed: IndexRange[],
  findings: BloatFinding[],
): void {
  const re = /\b(?:\d[ \t-]*?){13,19}\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    if (!raw) {
      re.lastIndex += 1;
      continue;
    }
    const digits = raw.replace(/[ \t-]/g, "");
    if (!luhnOk(digits)) continue;
    const start = match.index;
    const end = start + raw.length;
    if (rangesOverlap(start, end, skip) || rangesOverlap(start, end, claimed)) {
      continue;
    }
    findings.push(
      toHygieneFinding(
        text,
        start,
        end,
        "pii",
        "warn",
        "Possible credit card number",
      ),
    );
    claimed.push({ start, end });
  }
}

interface Folded {
  folded: string;
  toOrig: number[];
}

function foldZwsp(text: string): Folded {
  let folded = "";
  const toOrig: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) break;
    if (ZWSP_RE.test(ch)) continue;
    toOrig.push(i);
    folded += ch;
  }
  return { folded, toOrig };
}

function foldedSpan(
  toOrig: number[],
  foldStart: number,
  foldEnd: number,
): { start: number; end: number } | null {
  const start = toOrig[foldStart];
  const last = toOrig[foldEnd - 1];
  if (start === undefined || last === undefined) return null;
  return { start, end: last + 1 };
}

function collectInjection(
  text: string,
  skip: readonly IndexRange[],
  claimed: IndexRange[],
  findings: BloatFinding[],
): void {
  const { folded, toOrig } = foldZwsp(text);
  const patterns: ReadonlyArray<{ re: RegExp; message: string }> = [
    {
      re: /ignore (?:all )?previous instructions/gi,
      message: "Possible prompt injection",
    },
    {
      re: /ignore (?:all )?(?:prior|above) (?:instructions|prompts)/gi,
      message: "Possible prompt injection",
    },
    {
      re: /you are now/gi,
      message: "Possible jailbreak phrase",
    },
    {
      re: /you are DAN/gi,
      message: "Possible jailbreak phrase",
    },
    {
      re: /\bDAN\b/g,
      message: "Possible jailbreak phrase",
    },
    {
      re: /reveal (?:your )?(?:system )?prompt/gi,
      message: "Possible prompt injection",
    },
    {
      re: /disregard (?:your )?(?:rules|guidelines|instructions)/gi,
      message: "Possible prompt injection",
    },
    {
      re: /\bjailbreak\b/gi,
      message: "Possible jailbreak phrase",
    },
  ];

  for (const { re, message } of patterns) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    const exec = new RegExp(re.source, flags);
    let match: RegExpExecArray | null;
    while ((match = exec.exec(folded)) !== null) {
      const matched = match[0];
      if (!matched) {
        exec.lastIndex += 1;
        continue;
      }
      const span = foldedSpan(toOrig, match.index, match.index + matched.length);
      if (!span) continue;
      if (
        rangesOverlap(span.start, span.end, skip) ||
        rangesOverlap(span.start, span.end, claimed)
      ) {
        continue;
      }
      findings.push(
        toHygieneFinding(
          text,
          span.start,
          span.end,
          "injection",
          "critical",
          message,
        ),
      );
      claimed.push(span);
    }
  }
}

function collectSecrets(
  text: string,
  skip: readonly IndexRange[],
  claimed: IndexRange[],
  findings: BloatFinding[],
): void {
  const specs: ReadonlyArray<{ re: RegExp; message: string }> = [
    {
      re: /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g,
      message: "Possible OpenAI API key",
    },
    {
      re: /\bsk-[A-Za-z0-9]{20,}\b/g,
      message: "Possible OpenAI API key",
    },
    {
      re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
      message: "Possible GitHub token",
    },
    {
      re: /\bghp_[A-Za-z0-9]{20,}\b/g,
      message: "Possible GitHub token",
    },
    {
      re: /\bgho_[A-Za-z0-9]{20,}\b/g,
      message: "Possible GitHub token",
    },
    {
      re: /\bAKIA[0-9A-Z]{16}\b/g,
      message: "Possible AWS access key",
    },
    {
      re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
      message: "Possible Slack token",
    },
    {
      re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
      message: "Possible Google API key",
    },
    {
      re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      message: "Possible JWT",
    },
    {
      re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g,
      message: "Possible private key block",
    },
    {
      re: /Authorization\s*:\s*Bearer\s+\S+/gi,
      message: "Possible bearer token",
    },
  ];
  for (const { re, message } of specs) {
    pushRegex(text, re, skip, claimed, findings, "secret", "critical", message);
  }
}

function collectPii(
  text: string,
  skip: readonly IndexRange[],
  claimed: IndexRange[],
  findings: BloatFinding[],
): void {
  const urlSkip = mergeRanges([...skip, ...findUrlRanges(text)]);
  pushRegex(
    text,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    urlSkip,
    claimed,
    findings,
    "pii",
    "warn",
    "Possible email address",
  );
  pushRegex(
    text,
    /\b(?:\+1[-.\s]?)?(?:\([0-9]{3}\)|[0-9]{3})[-.\s][0-9]{3}[-.\s][0-9]{4}\b/g,
    skip,
    claimed,
    findings,
    "pii",
    "warn",
    "Possible phone number",
  );
  pushRegex(
    text,
    /\b\d{3}-\d{2}-\d{4}\b/g,
    skip,
    claimed,
    findings,
    "pii",
    "warn",
    "Possible Social Security number",
  );
  collectCards(text, skip, claimed, findings);
}

/**
 * Scan `text` for secrets, PII, and jailbreak phrases. Indexes are into
 * `text` as given. Never throws.
 */
export function findHygiene(
  text: string,
  options?: HygieneOptions,
): BloatFinding[] {
  if (!text) return [];
  try {
    const secrets = options?.secrets ?? true;
    const pii = options?.pii ?? true;
    const injection = options?.injection ?? true;
    if (!secrets && !pii && !injection) return [];

    const skip = findCodeProtectedRanges(text);
    const claimed: IndexRange[] = [];
    const findings: BloatFinding[] = [];

    if (secrets) collectSecrets(text, skip, claimed, findings);
    if (pii) collectPii(text, skip, claimed, findings);
    if (injection) collectInjection(text, skip, claimed, findings);

    findings.sort((a, b) => a.start - b.start);
    return findings;
  } catch {
    return [];
  }
}
