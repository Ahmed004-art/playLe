import { describe, expect, it, vi } from 'vitest';
import { BlocksService } from './blocks.service.js';

/**
 * Phase 12 PR 3 (ADR-026, "Block semantics") - blocking an existing friend and
 * blocking with a pending friend request, in either direction. The database is
 * a fake; the real races and constraints are in test/friends.e2e-spec.ts (CI).
 */

function build() {
  const tx = {
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    userBlock: {
      upsert: vi.fn(
        (args: { create: { blockerId: string; blockedId: string } }) =>
          Promise.resolve({ ...args.create, createdAt: new Date() }),
      ),
      deleteMany: vi.fn(() => Promise.resolve({ count: 1 })),
    },
    challenge: {
      findMany: vi.fn(() => Promise.resolve([])),
      updateMany: vi.fn(() => Promise.resolve({ count: 0 })),
    },
    friendship: { deleteMany: vi.fn(() => Promise.resolve({ count: 1 })) },
    friendRequest: { updateMany: vi.fn(() => Promise.resolve({ count: 1 })) },
  };
  const prisma = {
    user: {
      findUnique: vi.fn(() =>
        Promise.resolve({ id: 'a', username: 'ay', displayName: null }),
      ),
    },
    userBlock: { findMany: vi.fn(() => Promise.resolve([])) },
    $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const emitter = { emitToUser: vi.fn() };
  const service = new BlocksService(prisma as never, emitter as never);
  return { service, prisma, tx, emitter };
}

const order = (fn: { mock: { invocationCallOrder: number[] } }, i = 0) =>
  fn.mock.invocationCallOrder[i];

describe('BlocksService.block - friendship and friend-request cleanup', () => {
  it('removes an existing friendship, addressed by the CANONICAL pair whichever side blocks', async () => {
    const asLow = build();
    const asHigh = build();

    await asLow.service.block('a', 'b');
    await asHigh.service.block('b', 'a');

    for (const { tx } of [asLow, asHigh]) {
      expect(tx.friendship.deleteMany).toHaveBeenCalledTimes(1);
      expect(tx.friendship.deleteMany).toHaveBeenCalledWith({
        where: { userLowId: 'a', userHighId: 'b' },
      });
    }
  });

  it('cancels a pending friend request between the pair in EITHER direction, by the shared pair key, and frees the key', async () => {
    const asLow = build();
    const asHigh = build();

    await asLow.service.block('a', 'b');
    await asHigh.service.block('b', 'a');

    for (const { tx } of [asLow, asHigh]) {
      expect(tx.friendRequest.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.friendRequest.updateMany).toHaveBeenCalledWith({
        // One key for A->B and B->A, so one statement covers both directions;
        // only a PENDING request matches, so resolved ones are never rewritten.
        where: { pendingPairKey: 'a:b', status: 'PENDING' },
        data: {
          status: 'CANCELLED',
          pendingPairKey: null,
          respondedAt: expect.any(Date),
        },
      });
    }
  });

  it('does the cleanup inside the same transaction as the block, after the pair lock, before it commits', async () => {
    const { service, prisma, tx } = build();

    await service.block('a', 'b');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(order(tx.$executeRaw)).toBeLessThan(order(tx.userBlock.upsert));
    expect(order(tx.userBlock.upsert)).toBeLessThan(
      order(tx.friendship.deleteMany),
    );
    expect(order(tx.$executeRaw)).toBeLessThan(
      order(tx.friendRequest.updateMany),
    );
  });

  it('is atomic: if the cleanup fails the block is not left behind (the transaction rejects)', async () => {
    const { service, prisma, tx } = build();
    tx.friendship.deleteMany.mockRejectedValueOnce(new Error('db went away'));

    await expect(service.block('a', 'b')).rejects.toThrow('db went away');

    // The service issued everything through one transaction, so the real
    // database rolls the upsert back with it; nothing ran outside it.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.userBlock.findMany).not.toHaveBeenCalled();
  });

  it('notifies nobody about the friendship or request cleanup (a block must not announce itself)', async () => {
    const { service, emitter } = build();

    await service.block('a', 'b');

    expect(emitter.emitToUser).not.toHaveBeenCalled();
  });

  it('still cleans up when the block already existed (idempotent re-block)', async () => {
    const { service, tx } = build();

    await service.block('a', 'b');
    await service.block('a', 'b');

    expect(tx.friendship.deleteMany).toHaveBeenCalledTimes(2);
  });
});

describe('BlocksService.unblock - restores nothing', () => {
  it('never touches friendships or friend requests', async () => {
    const { service, tx } = build();

    await service.unblock('a', 'b');

    expect(tx.friendship.deleteMany).not.toHaveBeenCalled();
    expect(tx.friendRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.userBlock.deleteMany).toHaveBeenCalledWith({
      where: { blockerId: 'a', blockedId: 'b' },
    });
  });
});
