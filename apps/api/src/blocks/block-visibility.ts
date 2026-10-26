import type { BlockRelation } from './blocks.service.js';

/**
 * Who may discover whom (Phase 12 PR 2 - ADR-026, "Discoverability"). The one
 * place that decides it, so profiles, username lookup and summaries cannot
 * drift apart.
 *
 * - **Profile and username lookup** hide a player only from someone they have
 *   blocked. The blocker can still resolve and open a player they blocked, so
 *   they can see who it is and unblock them.
 * - **Summaries** (the batch lookup used to label lists of players) hide a
 *   player in *both* directions, so a list never names someone who has a
 *   block against the viewer or whom the viewer has a block against.
 *
 * A viewer can always see themselves; callers handle that before asking.
 */
export function isHiddenFromProfileAndLookup(relation: BlockRelation): boolean {
  return relation.blockedViewer;
}

export function isHiddenFromSummaries(relation: BlockRelation): boolean {
  return relation.blockedViewer || relation.blockedByViewer;
}
