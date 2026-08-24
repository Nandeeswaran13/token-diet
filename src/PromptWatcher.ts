/**
 * Headless, framework-agnostic watcher for live prompt compression.
 *
 * Attach `feed()` to an `<input>` / `<textarea>` `input` handler (or any
 * string source). After `debounceMs` of quiet, the watcher runs
 * {@link findBloat} and emits `optimization_ready` with highlight spans,
 * token counts, and a cacheable-prefix hint.
 *
 * No DOM APIs are used — this is a typed event emitter + timer.
 */

import {
  compress,
  findBloat,
  estimateTokens,
  type BloatFinding,
  type CompressOptions,
} from "./engine";
import { cacheablePrefixEnd as cacheablePrefixEndOf } from "./prefix";
import { diffFindings } from "./delta";

/** Constructor options: debounce plus pass-through {@link CompressOptions}. */
export interface PromptWatcherOptions extends CompressOptions {
  /**
   * Quiet period in milliseconds after the last {@link PromptWatcher.feed}
   * before analysis runs.
   *
   * @default 300
   */
  debounceMs?: number;
}

/**
 * Payload of the `optimization_ready` event.
 *
 * `tokensSaved` is the delta between the original feed and a full
 * {@link compress} pass (includes whitespace squeeze), not merely the sum of
 * per-span estimates. Token counts use `options.tokenizer` when provided,
 * otherwise {@link estimateTokens}.
 *
 * `cacheablePrefixEnd` is the exclusive index of the longest common prefix
 * with the previous analyzed feed (0 on the first feed), snapped to a word
 * boundary. Tiny prefixes are still returned — hosts decide whether to use
 * them.
 *
 * `added` / `removed` / `unchanged` are a finding-id diff vs the previous
 * analyzed feed so highlighters can mount/unmount marks without flicker.
 * First feed: `added === findings`, `removed === []`.
 */
export interface OptimizationReadyPayload {
  /** Original text that was analyzed (the last `feed()` value). */
  text: string;
  /** Spans into `text`, highlighter-ready (compression + hygiene). */
  findings: BloatFinding[];
  /**
   * Findings whose `id` was not in the previous analyzed feed.
   * On the first feed this is the same list as {@link OptimizationReadyPayload.findings}.
   */
  added: BloatFinding[];
  /** `id`s from the previous feed that are gone. Empty on the first feed. */
  removed: string[];
  /** `id`s present in both this feed and the previous one. */
  unchanged: string[];
  /** `tokensNow - tokensAfter`, floored at 0. */
  tokensSaved: number;
  /** Convenience: already-compressed form of `text`. */
  compressed: string;
  /** Token count of the current draft. */
  tokensNow: number;
  /** Token count of {@link OptimizationReadyPayload.compressed}. */
  tokensAfter: number;
  /**
   * Exclusive index into `text` of the longest prefix unchanged since the
   * previous analyzed feed. 0 on the first feed. Snapped back if the raw
   * LCP lands mid-word. Always the true index (hosts may ignore values < 32).
   */
  cacheablePrefixEnd: number;
}

/** Typed event map for {@link PromptWatcher.on} / {@link PromptWatcher.off}. */
export interface PromptWatcherEvents {
  optimization_ready: OptimizationReadyPayload;
}

type Listener<K extends keyof PromptWatcherEvents> = (
  payload: PromptWatcherEvents[K],
) => void;

const DEFAULT_DEBOUNCE_MS = 300;

/**
 * Debounced analyzer you can bind to any text field.
 *
 * @example
 * ```ts
 * const watcher = new PromptWatcher({ debounceMs: 200, strictMode: true });
 * watcher.on("optimization_ready", ({ findings, added, removed, tokensSaved }) => {
 *   paintHighlights(findings);
 *   badge.textContent = `${tokensSaved} tokens`;
 * });
 * textarea.addEventListener("input", () => watcher.feed(textarea.value));
 * // later:
 * watcher.destroy();
 * ```
 */
export class PromptWatcher {
  readonly #debounceMs: number;
  readonly #compressOptions: CompressOptions;
  readonly #listeners = new Map<
    keyof PromptWatcherEvents,
    Set<Listener<keyof PromptWatcherEvents>>
  >();

  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending = "";
  #destroyed = false;
  #lastText = "";
  #hasAnalyzed = false;
  #lastFindings: BloatFinding[] = [];

  constructor(options: PromptWatcherOptions = {}) {
    const { debounceMs, ...compressOptions } = options;
    this.#debounceMs = debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#compressOptions = compressOptions;
  }

  /**
   * Push the latest prompt text. Restarts the debounce timer; only the most
   * recent value is analyzed.
   */
  feed(text: string): void {
    if (this.#destroyed) return;
    this.#pending = text;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#analyze(this.#pending);
    }, this.#debounceMs);
  }

  /**
   * Subscribe to a watcher event. Returns `this` for chaining.
   * Listeners added after {@link destroy} are ignored.
   */
  on<K extends keyof PromptWatcherEvents>(
    event: K,
    listener: Listener<K>,
  ): this {
    if (this.#destroyed) return this;
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as Listener<keyof PromptWatcherEvents>);
    return this;
  }

  /**
   * Remove a previously registered listener. No-op if it was never added.
   */
  off<K extends keyof PromptWatcherEvents>(
    event: K,
    listener: Listener<K>,
  ): this {
    const set = this.#listeners.get(event);
    if (!set) return this;
    set.delete(listener as Listener<keyof PromptWatcherEvents>);
    if (set.size === 0) this.#listeners.delete(event);
    return this;
  }

  /**
   * Cancel any pending debounce timer and drop all listeners. Subsequent
   * `feed()` / `on()` calls are no-ops. Safe to call more than once.
   */
  destroy(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#listeners.clear();
    this.#destroyed = true;
    this.#lastFindings = [];
    this.#hasAnalyzed = false;
    this.#lastText = "";
  }

  #analyze(text: string): void {
    if (this.#destroyed) return;
    const findings = findBloat(text, this.#compressOptions);
    const compressed = compress(text, this.#compressOptions);
    const count = this.#compressOptions.tokenizer ?? estimateTokens;
    const tokensNow = count(text);
    const tokensAfter = count(compressed);
    const tokensSaved = Math.max(0, tokensNow - tokensAfter);

    const cacheablePrefixEnd = this.#hasAnalyzed
      ? cacheablePrefixEndOf(this.#lastText, text)
      : 0;
    const delta = diffFindings(this.#lastFindings, findings);
    this.#lastText = text;
    this.#hasAnalyzed = true;
    this.#lastFindings = findings;

    this.#emit("optimization_ready", {
      text,
      findings,
      added: delta.added,
      removed: delta.removed,
      unchanged: delta.unchanged,
      tokensSaved,
      compressed,
      tokensNow,
      tokensAfter,
      cacheablePrefixEnd,
    });
  }

  #emit<K extends keyof PromptWatcherEvents>(
    event: K,
    payload: PromptWatcherEvents[K],
  ): void {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return;
    // Snapshot so a listener calling off()/destroy() cannot skip siblings.
    for (const listener of [...set]) {
      listener(payload);
    }
  }
}
