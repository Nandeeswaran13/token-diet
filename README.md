# token-diet

**Cut tokens in the prompt box. No model. No server. No React.**

Most compressors run at send time, or they *are* an LLM. token-diet is a headless, zero-dependency TypeScript library that diets the draft **while the user types**: filler, verbose phrases, JSON blobs, markdown chrome — plus secret/PII/jailbreak flags so you don't ship a key with the prompt. Attach `PromptWatcher` to any `<textarea>` in any framework.

Local, deterministic, browser + Node. You paint the highlights; we give you spans, token counts, and one-click `applyFindings`.

Primary UX: `feed()` → debounce → `optimization_ready` with highlighter spans (`kind`, `added`/`removed` to avoid flicker). Standalone `minifyJson` / `summarize` for pastes. `summarize` is **not** on the live watcher.

## Install

```bash
bun add token-diet
```

```bash
npm install token-diet
```

## Quick start

```ts
import { compress, findBloat, minifyJson, summarize, PromptWatcher } from "token-diet";

compress("I was wondering if you could please review this in order to ship.");
// → "review this to ship."

const findings = findBloat("despite the fact that it rained");
// findings[0].originalText === "despite the fact that"
// input.slice(findings[0].start, findings[0].end) === findings[0].originalText

minifyJson('User {"name":"John", "age":30} ready');
// → 'User {"name":"John","age":30} ready'   (default: compact)

minifyJson('User {"name":"John", "age":30} ready', { mode: "flatten" });
// → 'User name:John|age:30 ready'

summarize(longPaste, { query: "auth bugs", maxTokens: 800 });
// extractive: existing sentences only, fenced code / JSON skipped
```

### Live input (any framework)

```ts
const watcher = new PromptWatcher({ debounceMs: 200, strictMode: true });

watcher.on("optimization_ready", ({ findings, added, removed, tokensNow, tokensAfter, cacheablePrefixEnd }) => {
  // paint highlights from findings[].start / .end (includes kind + hygiene)
  // or mount added / unmount removed ids to avoid flicker
});

input.addEventListener("input", () => watcher.feed(input.value));

// on unmount:
watcher.destroy();
```

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `strictMode` | `false` | Also strip hedges (`basically`, `sort of`, …) and extra scaffolding. Implies `stripAsides` |
| `removeArticles` | `false` | Drop `a` / `an` / `the` |
| `minifyJson` | `true` (`compact`) | Minify complete JSON in prose. Uniform object arrays use a CSV table when that is **shorter** than compact JSON. `false` skips. `{ mode: "flatten" }` is the lossy `k:v\|k:v` encoding |
| `stripMarkdown` | `true` | Strip emphasis, decorative `---`, HTML comments, wrapping tags; convert complete GFM tables → TSV |
| `dedupeLines` | `true` | Drop consecutive identical lines / paragraphs (exact, trimmed). Finding covers the 2nd+ copy |
| `stripAsides` | `false` | Strip `(by the way)` / `— as mentioned earlier —`. Implied by `strictMode`. Does not strip `(not ready)` / `(optional)` / dates |
| `abbreviations` | `true` | Conventional abbrevs: `for example` → `e.g.`, `that is to say` → `i.e.`, `and so on` → `etc.` |
| `tokenizer` | `estimateTokens` | `(text) => number`. Findings with no token savings are dropped |
| `hygiene` | `true` | Flag secrets / PII / jailbreaks as highlight-only findings. `false` skips. `{ secrets, pii, injection }` each default true when hygiene is on |
| `debounceMs` | `300` | `PromptWatcher` only |

Live `findBloat()` skips fenced/inline code, URLs, emails, and incomplete JSON (`{ "name": "Jo`) so as-you-type drafts are not rewritten mid-keystroke. Contractions (`do not` → `don't`) keep negation. Unicode folds (NBSP, smart quotes, BOM, ZWSP, `…` → `...`) emit highlighter spans on the original string.

Hygiene still **flags** emails in prose (even though compression already protects them). Hits inside fenced / inline code are not flagged. Token estimates use `ceil(chars / 4)` unless you pass `tokenizer`.

### Finding `kind`

Every `BloatFinding` has a required `kind`, plus optional `id` (`${kind}:${start}:${end}`), `severity` (compression `info`; PII `warn`; secrets/injection `critical`), and `message` (hygiene labels).

| Kind | Source |
| --- | --- |
| `filler` | Polite / scaffolding phrases stripped to empty |
| `collapse` | Verbose phrase → shorter synonym |
| `contraction` | `do not` → `don't` (negation-preserving) |
| `abbreviation` | `for example` → `e.g.` |
| `hedge` | `basically` / `sort of` (strictMode) |
| `article` | `a` / `an` / `the` (`removeArticles`) |
| `unicode` | NBSP, smart quotes, ZWSP, BOM, ellipsis |
| `json` | Complete JSON blob → compact (or flatten) |
| `table` | Uniform JSON array → CSV, or GFM table → TSV |
| `chrome` | Markdown/HTML emphasis, HR, comments, wrapping tags |
| `dedupe` | Consecutive identical line / paragraph |
| `aside` | Parenthetical discourse asides |
| `secret` | API keys, JWT, private-key blocks, Bearer tokens |
| `pii` | Email, US phone, SSN, Luhn-valid card |
| `injection` | Jailbreak / "ignore previous instructions" |

### Apply API

Standalone, like `minifyJson` — not an LLM. Verify `text.slice(start, end) === originalText` when `originalText` is set; mismatch **skips** that finding (no throw, no corrupt rewrite). Applied right-to-left so indexes stay valid.

```ts
applyFinding(text, finding); // one span (including a user-accepted secret)
applyFindings(text, findings); // auto-fixable kinds only
applyFindings(text, findings, { include: ["secret"] }); // opt-in allowlist
```

`secret` / `pii` / `injection` are **not** applied by default (`compress()` uses `applyFindings`). An empty replacement would delete keys from the draft without consent.

### Hygiene

Default **on** for `findBloat` / `PromptWatcher`. Highlight only — `suggestedReplacement === originalText`. Conservative regexes (OpenAI `sk-` / `sk-proj-`, GitHub `ghp_` / `gho_` / `github_pat_`, AWS `AKIA…`, Slack `xox[baprs]-`, Google `AIza…`, JWT `eyJ…`, PEM keys, Bearer; emails; US phone; SSN `###-##-####`; 13–19 digit cards **with Luhn**; jailbreak phrases). Never throws.

**Overlap rule:** hygiene runs after compression findings. If a hygiene span overlaps a compression finding, the **compression finding is dropped** (never diet a secret). `compress()` therefore will not minify JSON or strip filler that covers a flagged key.

### `findBloat` pipeline

1. Protected ranges (fences, incomplete JSON, …)
2. Unicode findings
3. Complete JSON → compact **or** CSV table (uniform object array, whichever is shorter)
4. Complete markdown tables → TSV
5. Markdown/HTML chrome
6. Consecutive exact line/paragraph dedup
7. Parenthetical asides (`strictMode` / `stripAsides`)
8. Dictionary (filler, collapses, tautologies, abbreviations, contractions)
9. Tokenizer / heuristic gate
10. Hygiene (secrets / PII / injection); overlapping compression findings dropped

### Watcher payload extras

`optimization_ready` still covers compression **and** hygiene (no second event).

| Field | Meaning |
| --- | --- |
| `tokensNow` | Tokenizer (or `estimateTokens`) on the current draft |
| `tokensAfter` | Same counter on `compressed` |
| `cacheablePrefixEnd` | Exclusive index into `text` of the longest common prefix with the **previous analyzed** feed. **0 on the first feed.** If the raw LCP lands mid-word, walked back to the last whitespace/newline. Always the true (snapped) index — hosts may ignore values under ~32 chars |
| `added` | Findings whose `id` was not in the previous feed. First feed: same as `findings` |
| `removed` | Previous `id`s that disappeared. First feed: `[]` |
| `unchanged` | `id`s present in both feeds. Identity is `${kind}:${start}:${end}` — typing in the middle is remove+add, not a move |

Hosts that re-paint from scratch can ignore the delta and use `findings`. Incremental highlighters should mount `added` and unmount `removed`.

`longestCommonPrefix(a, b)` and `cacheablePrefixEnd(previous, current)` are also exported for hosts that do not use the watcher. `diffFindings(previous, next)` is the same diff the watcher uses.

## Utilities

Never throw; unmatched text is unchanged.

| Function | Behavior |
| --- | --- |
| `normalizeUnicode(text)` | ZWSP/BOM → empty, NBSP → space, smart quotes → `'/"`, `…` → `...` |
| `minifyJson(text, { mode })` | Compact (default) or flatten JSON blobs in prose |
| `minifyJsonTable(value \| text)` | Uniform object arrays → CSV `key1,key2\nv1,v2`. Nested/non-uniform → compact JSON |
| `minifyYaml(text)` | Strip `#` comments (honoring quotes), trim, collapse blanks, `key: value` → `key:value` on a **restricted subset** (identifier keys, scalar values; no tags/anchors/`\|` blocks — not a YAML parser) |
| `minifyXmlHtml(text)` | Strip comments, drop tags, keep text, collapse whitespace |
| `minifyMarkdown(text)` | Chrome + GFM tables → TSV; fenced code left verbatim |
| `minifyCode(text)` | Strip `//` `#` `/* */` outside strings/templates; collapse blank lines. Utility-only (live fences already protect unclosed code) |
| `minifyCsvTsv(text)` | Trim cells, drop empty rows and all-empty columns |
| `summarize(text, options?)` | Extractive (non-LLM) sentence pick. Default: Luhn + TF-IDF + position + optional `query`, then MMR. `method: "textrank"` is opt-in. **Not** used by `PromptWatcher`. Token budget via `maxTokens` / `maxSentences` / `ratio` (default 0.3). Skips fenced code and complete JSON. Returns `{ summary, sentences: [{ start, end, text, score, selected }] }` |
| `applyFinding` / `applyFindings` | Rewrite using finding spans (RTL, skip mismatch; hygiene skipped unless `include`) |
| `findHygiene(text, options?)` | Secrets / PII / injection spans only |
| `longestCommonPrefix` / `cacheablePrefixEnd` | Prefix helpers for prompt-cache hints |
| `diffFindings` / `findingId` | Finding-id diff for incremental highlighters |

## Scripts

```bash
bun test
bun run build
```

## Publish

```bash
bun test
npm pack --dry-run    # confirm dist/index.js and dist/index.d.ts are listed
npm login
npm publish
```

`prepublishOnly` runs tests and the build. The package name `token-diet` is unscoped and public.

## License

MIT
