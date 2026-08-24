/**
 * Diff highlighter spans between two `findBloat` results.
 *
 * Hosts should keep painting from the full `findings` list when they
 * re-render from scratch. `added` / `removed` exist so a live overlay can
 * mount/unmount marks without clearing the whole layer on every keystroke.
 *
 * Identity is {@link BloatFinding.id} (`${kind}:${start}:${end}`). Typing in
 * the middle of the draft shifts indexes, so a still-valid phrase becomes
 * remove+add — we do not try to git-match moved spans.
 */

import type { BloatFinding } from "./engine";

/** `id` if set, otherwise the same `${kind}:${start}:${end}` `findBloat` uses. */
export function findingId(finding: BloatFinding): string {
  return finding.id ?? `${finding.kind}:${finding.start}:${finding.end}`;
}

export interface FindingDelta {
  /** Findings whose id was not in the previous set. */
  added: BloatFinding[];
  /** Previous ids that are gone. */
  removed: string[];
  /** Ids present in both sets (same start/end/kind). */
  unchanged: string[];
}

/**
 * Compare two finding lists by id.
 *
 * First analysis: pass `previous = []` → `added` is all of `next`,
 * `removed` is empty.
 */
export function diffFindings(
  previous: readonly BloatFinding[],
  next: readonly BloatFinding[],
): FindingDelta {
  const prevIds = new Set<string>();
  for (const finding of previous) prevIds.add(findingId(finding));

  const nextIds = new Set<string>();
  const added: BloatFinding[] = [];
  const unchanged: string[] = [];

  for (const finding of next) {
    const id = findingId(finding);
    nextIds.add(id);
    if (prevIds.has(id)) unchanged.push(id);
    else added.push(finding);
  }

  const removed: string[] = [];
  for (const id of prevIds) {
    if (!nextIds.has(id)) removed.push(id);
  }

  return { added, removed, unchanged };
}
