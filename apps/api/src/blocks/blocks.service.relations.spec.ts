import { describe, expect, it, vi } from 'vitest';
import { BlocksService } from './blocks.service.js';
import {
  isHiddenFromProfileAndLookup,
  isHiddenFromSummaries,
} from './block-visibility.js';

/**
 * Phase 12 PR 2 (ADR-026, "Discoverability") - the batch block lookup and the
 * single visibility policy that profiles, lookup and summaries share.
 */

function build(rows: { blockerId: string; blockedId: string }[] = []) {
  const prisma = {
    userBlock: { findMany: vi.fn(() => Promise.resolve(rows)) },
  };
  const service = new BlocksService(prisma as never, {} as never);
  return { service, prisma };
}

describe('BlocksService.relationsBetween', () => {
  it('answers for every id in ONE query, NONE where there is no block', async () => {
    const { service, prisma } = build();

    const relations = await service.relationsBetween('v', ['a', 'b', 'c']);

    expect(prisma.userBlock.findMany).toHaveBeenCalledTimes(1);
    expect([...relations.keys()]).toEqual(['a', 'b', 'c']);
    for (const relation of relations.values()) {
      expect(relation).toEqual({
        blockedByViewer: false,
        blockedViewer: false,
      });
    }
  });

  it('queries both directions between the viewer and exactly those ids', async () => {
    const { service, prisma } = build();

    await service.relationsBetween('v', ['a', 'b']);

    expect(prisma.userBlock.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerId: 'v', blockedId: { in: ['a', 'b'] } },
          { blockerId: { in: ['a', 'b'] }, blockedId: 'v' },
        ],
      },
      select: { blockerId: true, blockedId: true },
    });
  });

  it('keeps direction: the viewer blocked a; b blocked the viewer; c blocked each other', async () => {
    const { service } = build([
      { blockerId: 'v', blockedId: 'a' },
      { blockerId: 'b', blockedId: 'v' },
      { blockerId: 'v', blockedId: 'c' },
      { blockerId: 'c', blockedId: 'v' },
    ]);

    const relations = await service.relationsBetween('v', ['a', 'b', 'c', 'd']);

    expect(relations.get('a')).toEqual({
      blockedByViewer: true,
      blockedViewer: false,
    });
    expect(relations.get('b')).toEqual({
      blockedByViewer: false,
      blockedViewer: true,
    });
    expect(relations.get('c')).toEqual({
      blockedByViewer: true,
      blockedViewer: true,
    });
    expect(relations.get('d')).toEqual({
      blockedByViewer: false,
      blockedViewer: false,
    });
  });

  it('ignores a row for a player that was not asked about', async () => {
    const { service } = build([{ blockerId: 'v', blockedId: 'zzz' }]);

    const relations = await service.relationsBetween('v', ['a']);

    expect([...relations.keys()]).toEqual(['a']);
  });

  it('does not touch the database for an empty list', async () => {
    const { service, prisma } = build();

    expect((await service.relationsBetween('v', [])).size).toBe(0);
    expect(prisma.userBlock.findMany).not.toHaveBeenCalled();
  });
});

describe('block visibility policy', () => {
  const none = { blockedByViewer: false, blockedViewer: false };
  const iBlocked = { blockedByViewer: true, blockedViewer: false };
  const blockedMe = { blockedByViewer: false, blockedViewer: true };
  const both = { blockedByViewer: true, blockedViewer: true };

  it('profile and lookup hide a player only from someone they have blocked', () => {
    expect(isHiddenFromProfileAndLookup(none)).toBe(false);
    // The blocker can still resolve and open the player they blocked.
    expect(isHiddenFromProfileAndLookup(iBlocked)).toBe(false);
    expect(isHiddenFromProfileAndLookup(blockedMe)).toBe(true);
    expect(isHiddenFromProfileAndLookup(both)).toBe(true);
  });

  it('summaries hide a player in both directions', () => {
    expect(isHiddenFromSummaries(none)).toBe(false);
    expect(isHiddenFromSummaries(iBlocked)).toBe(true);
    expect(isHiddenFromSummaries(blockedMe)).toBe(true);
    expect(isHiddenFromSummaries(both)).toBe(true);
  });
});
