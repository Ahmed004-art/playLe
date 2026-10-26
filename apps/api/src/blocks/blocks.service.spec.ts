import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BlocksService } from './blocks.service.js';

/**
 * Phase 12 PR 1 (ADR-026) - block/unblock/list and the directionality of
 * `relationBetween`. The database is replaced by a fake; the real Postgres
 * behaviour (constraints, the pair lock actually serialising) is in
 * test/blocks.e2e-spec.ts, which only runs in CI.
 */

type Row = { id: string; challengerId: string; opponentId: string };

function build(options: { pending?: Row[]; targetExists?: boolean } = {}) {
  const { pending = [], targetExists = true } = options;
  const tx = {
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    userBlock: {
      upsert: vi.fn(
        (args: { create: { blockerId: string; blockedId: string } }) =>
          Promise.resolve({
            ...args.create,
            createdAt: new Date('2026-10-26'),
          }),
      ),
      deleteMany: vi.fn(() => Promise.resolve({ count: 1 })),
    },
    challenge: {
      findMany: vi.fn(() => Promise.resolve(pending)),
      updateMany: vi.fn(() => Promise.resolve({ count: pending.length })),
    },
    friendship: { deleteMany: vi.fn(() => Promise.resolve({ count: 1 })) },
    friendRequest: { updateMany: vi.fn(() => Promise.resolve({ count: 1 })) },
  };
  const prisma = {
    user: {
      findUnique: vi.fn(() =>
        Promise.resolve(
          targetExists
            ? { id: 'b', username: 'bee', displayName: 'Bee' }
            : null,
        ),
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

describe('BlocksService.block', () => {
  it('refuses to block yourself, without touching the database', async () => {
    const { service, prisma } = build();

    await expect(service.block('a', 'a')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('404s for a player that does not exist', async () => {
    const { service, prisma } = build({ targetExists: false });

    await expect(service.block('a', 'b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('takes the pair lock before writing, and upserts so repeating a block is idempotent', async () => {
    const { service, tx } = build();

    const result = await service.block('a', 'b');

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(order(tx.$executeRaw)).toBeLessThan(order(tx.userBlock.upsert));
    expect(tx.userBlock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { blockerId_blockedId: { blockerId: 'a', blockedId: 'b' } },
        create: { blockerId: 'a', blockedId: 'b' },
        update: {},
      }),
    );
    expect(result.blocked).toEqual({
      id: 'b',
      username: 'bee',
      displayName: 'Bee',
    });
  });

  it('locks the same key whichever player is the blocker', async () => {
    const first = build();
    const second = build();

    await first.service.block('a', 'b');
    await second.service.block('b', 'a');

    // [template strings, namespace, pairKey] - identical for both directions.
    const [, ...firstKey] = first.tx.$executeRaw.mock.calls[0] as unknown[];
    const [, ...secondKey] = second.tx.$executeRaw.mock.calls[0] as unknown[];
    expect(firstKey).toEqual(secondKey);
    expect(firstKey).toEqual([1201, 'a:b']);
  });

  it('cancels pending challenges in both directions, and only after the transaction commits', async () => {
    const { service, prisma, tx, emitter } = build({
      pending: [
        { id: 'c1', challengerId: 'a', opponentId: 'b' },
        { id: 'c2', challengerId: 'b', opponentId: 'a' },
      ],
    });

    await service.block('a', 'b');

    const lookup = tx.challenge.findMany.mock.calls[0] as unknown as [
      { where: { status: string; OR: unknown[] } },
    ];
    expect(lookup[0].where.status).toBe('PENDING');
    expect(lookup[0].where.OR).toEqual([
      { challengerId: 'a', opponentId: 'b' },
      { challengerId: 'b', opponentId: 'a' },
    ]);
    expect(tx.challenge.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2'] }, status: 'PENDING' },
      data: { status: 'CANCELLED', respondedAt: expect.any(Date) },
    });

    // Both players hear about both challenges...
    expect(emitter.emitToUser).toHaveBeenCalledTimes(4);
    for (const challengeId of ['c1', 'c2']) {
      for (const userId of ['a', 'b']) {
        expect(emitter.emitToUser).toHaveBeenCalledWith(
          userId,
          'challenge:resolved',
          { challengeId, status: 'CANCELLED' },
        );
      }
    }
    // ...and only once the transaction callback has returned.
    expect(order(emitter.emitToUser)).toBeGreaterThan(
      order(tx.challenge.updateMany),
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('writes and emits nothing about challenges when none are pending', async () => {
    const { service, tx, emitter } = build({ pending: [] });

    await service.block('a', 'b');

    expect(tx.challenge.updateMany).not.toHaveBeenCalled();
    expect(emitter.emitToUser).not.toHaveBeenCalled();
  });

  it('only ever looks at challenges between the two players (never a third)', async () => {
    const { service, tx } = build();

    await service.block('a', 'b');

    const where = (
      tx.challenge.findMany.mock.calls[0] as unknown as [
        { where: { OR: { challengerId: string; opponentId: string }[] } },
      ]
    )[0].where;
    for (const clause of where.OR) {
      expect(new Set([clause.challengerId, clause.opponentId])).toEqual(
        new Set(['a', 'b']),
      );
    }
  });
});

describe('BlocksService.unblock', () => {
  it('removes only the caller’s own direction, under the pair lock', async () => {
    const { service, tx } = build();

    await service.unblock('a', 'b');

    expect(order(tx.$executeRaw)).toBeLessThan(order(tx.userBlock.deleteMany));
    expect(tx.userBlock.deleteMany).toHaveBeenCalledWith({
      where: { blockerId: 'a', blockedId: 'b' },
    });
  });

  it('does not restore or touch challenges', async () => {
    const { service, tx } = build({
      pending: [{ id: 'c1', challengerId: 'a', opponentId: 'b' }],
    });

    await service.unblock('a', 'b');

    expect(tx.challenge.findMany).not.toHaveBeenCalled();
    expect(tx.challenge.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to unblock yourself', async () => {
    const { service, prisma } = build();

    await expect(service.unblock('a', 'a')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('BlocksService.relationBetween (directionality)', () => {
  function withRows(rows: { blockerId: string }[]) {
    const { service, prisma } = build();
    prisma.userBlock.findMany.mockResolvedValue(rows as never);
    return { service, prisma };
  }

  it('reports no block', async () => {
    const { service } = withRows([]);
    expect(await service.relationBetween('a', 'b')).toEqual({
      blockedByViewer: false,
      blockedViewer: false,
    });
  });

  it('a blocked b: the viewer a sees blockedByViewer, the viewer b sees blockedViewer', async () => {
    const { service } = withRows([{ blockerId: 'a' }]);

    expect(await service.relationBetween('a', 'b')).toEqual({
      blockedByViewer: true,
      blockedViewer: false,
    });
    expect(await service.relationBetween('b', 'a')).toEqual({
      blockedByViewer: false,
      blockedViewer: true,
    });
  });

  it('reports both directions when each has blocked the other', async () => {
    const { service } = withRows([{ blockerId: 'a' }, { blockerId: 'b' }]);

    expect(await service.relationBetween('a', 'b')).toEqual({
      blockedByViewer: true,
      blockedViewer: true,
    });
  });

  it('queries both directions of exactly that pair, and can use a transaction client', async () => {
    const { service, prisma } = withRows([]);
    const txClient = {
      userBlock: { findMany: vi.fn(() => Promise.resolve([])) },
    };

    await service.relationBetween('a', 'b');
    await service.relationBetween('a', 'b', txClient as never);

    const expectedWhere = {
      where: {
        OR: [
          { blockerId: 'a', blockedId: 'b' },
          { blockerId: 'b', blockedId: 'a' },
        ],
      },
      select: { blockerId: true },
    };
    expect(prisma.userBlock.findMany).toHaveBeenCalledWith(expectedWhere);
    expect(txClient.userBlock.findMany).toHaveBeenCalledWith(expectedWhere);
  });
});

describe('BlocksService.list', () => {
  const block = (blockedId: string) => ({
    blockerId: 'a',
    blockedId,
    createdAt: new Date(),
    blocked: { id: blockedId, username: blockedId, displayName: null },
  });

  it('lists only the caller’s own blocks and pages with a cursor', async () => {
    const { service, prisma } = build();
    prisma.userBlock.findMany.mockResolvedValue([
      block('x'),
      block('y'),
      block('z'),
    ] as never);

    const page = await service.list('a', { limit: 2 });

    expect(prisma.userBlock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { blockerId: 'a' }, take: 3 }),
    );
    expect(page.items.map((b) => b.blockedId)).toEqual(['x', 'y']);
    expect(page.nextCursor).toBe('y');
  });

  it('has no next cursor on the last page, and resumes after a cursor', async () => {
    const { service, prisma } = build();
    prisma.userBlock.findMany.mockResolvedValue([block('z')] as never);

    const page = await service.list('a', { limit: 2, cursor: 'y' });

    expect(page.nextCursor).toBeNull();
    expect(prisma.userBlock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { blockerId_blockedId: { blockerId: 'a', blockedId: 'y' } },
        skip: 1,
      }),
    );
  });
});
