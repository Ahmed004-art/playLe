import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ChallengesService } from './challenges.service.js';

/**
 * Phase 12 PR 1 (ADR-026) - blocks are enforced when a challenge is created
 * and again, under the pair lock, when it is accepted. The database is
 * replaced by a fake; the real race against a concurrent block is in
 * test/blocks.e2e-spec.ts, which only runs in CI.
 */

type Relation = { blockedByViewer: boolean; blockedViewer: boolean };
const NONE: Relation = { blockedByViewer: false, blockedViewer: false };

const challengeRow = {
  id: 'ch1',
  gameId: 'tic_tac_toe',
  challengerId: 'zed',
  opponentId: 'amy',
  status: 'PENDING',
  matchId: null,
  stakeAmountMinor: null,
  stakeCurrency: null,
};

function build(
  relation: Relation = NONE,
  options: { claimCount?: number } = {},
) {
  const tx = {
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    challenge: {
      updateMany: vi.fn(() =>
        Promise.resolve({ count: options.claimCount ?? 1 }),
      ),
      update: vi.fn(() => Promise.resolve({ ...challengeRow, matchId: 'm1' })),
    },
    game: { findUniqueOrThrow: vi.fn(() => Promise.resolve({ id: 'g' })) },
  };
  const prisma = {
    matchPlayer: { findFirst: vi.fn(() => Promise.resolve(null)) },
    challenge: {
      findFirst: vi.fn(() => Promise.resolve(null)),
      findUnique: vi.fn(() => Promise.resolve(challengeRow)),
      create: vi.fn(() => Promise.resolve({ id: 'new' })),
    },
    $transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const gamesService = { findEnabledById: vi.fn(() => Promise.resolve({})) };
  const usersService = {
    findById: vi.fn(() => Promise.resolve({ id: 'amy', status: 'ACTIVE' })),
  };
  const matchesService = {
    createMatchGuarded: vi.fn(() => Promise.resolve({ id: 'm1' })),
  };
  const emitter = { emitToUser: vi.fn() };
  const matchStakesService = { validateStakeRequest: vi.fn() };
  const eligibilityService = { assertCanStake: vi.fn() };
  const configService = { get: vi.fn(() => 120000) };
  const blocksService = {
    relationBetween: vi.fn(() => Promise.resolve(relation)),
  };

  const service = new ChallengesService(
    prisma as never,
    gamesService as never,
    usersService as never,
    matchesService as never,
    emitter as never,
    matchStakesService as never,
    eligibilityService as never,
    configService as never,
    blocksService as never,
  );
  return { service, prisma, tx, matchesService, emitter, blocksService };
}

const order = (fn: { mock: { invocationCallOrder: number[] } }, i = 0) =>
  fn.mock.invocationCallOrder[i];

describe('ChallengesService.create - blocks', () => {
  const challenger = { id: 'zed' } as never;

  it('tells the blocker plainly (409) and creates nothing', async () => {
    const { service, prisma } = build({
      blockedByViewer: true,
      blockedViewer: false,
    });

    await expect(
      service.create('tic_tac_toe', challenger, 'amy'),
    ).rejects.toThrow(new ConflictException('You have blocked this player'));
    expect(prisma.challenge.create).not.toHaveBeenCalled();
  });

  it('gives the blocked player the same answer as a player that does not exist', async () => {
    const { service, prisma } = build({
      blockedByViewer: false,
      blockedViewer: true,
    });

    await expect(
      service.create('tic_tac_toe', challenger, 'amy'),
    ).rejects.toThrow(new NotFoundException('Opponent not found'));
    expect(prisma.challenge.create).not.toHaveBeenCalled();
  });

  it('a block the viewer placed takes precedence when both players blocked each other', async () => {
    const { service } = build({ blockedByViewer: true, blockedViewer: true });

    await expect(
      service.create('tic_tac_toe', challenger, 'amy'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('is checked before any other state-dependent check, so a blocked player learns nothing else', async () => {
    const { service, prisma } = build({
      blockedByViewer: false,
      blockedViewer: true,
    });

    await service
      .create('tic_tac_toe', challenger, 'amy')
      .catch(() => undefined);

    expect(prisma.matchPlayer.findFirst).not.toHaveBeenCalled();
    expect(prisma.challenge.findFirst).not.toHaveBeenCalled();
  });

  it('still creates and notifies when neither player has blocked the other', async () => {
    const { service, prisma, emitter } = build(NONE);

    await service.create('tic_tac_toe', challenger, 'amy');

    expect(prisma.challenge.create).toHaveBeenCalledTimes(1);
    expect(emitter.emitToUser).toHaveBeenCalledWith(
      'amy',
      'challenge:received',
      expect.objectContaining({ challengerId: 'zed' }),
    );
  });
});

describe('ChallengesService.accept - blocks', () => {
  it('takes the pair lock first - before the row claim and before creating the match', async () => {
    const { service, tx, matchesService } = build(NONE);

    await service.accept('amy', 'ch1');

    expect(order(tx.$executeRaw)).toBeLessThan(order(tx.challenge.updateMany));
    expect(order(tx.$executeRaw)).toBeLessThan(
      order(matchesService.createMatchGuarded),
    );
    // Sorted pair, so a concurrent block locks the very same key.
    const [, namespace, pairKey] = tx.$executeRaw.mock.calls[0] as unknown as [
      unknown,
      number,
      string,
    ];
    expect(namespace).toBe(1201);
    expect(pairKey).toBe('amy:zed');
  });

  it('rechecks blocks inside the locked transaction, on the transaction client', async () => {
    const { service, tx, blocksService } = build(NONE);

    await service.accept('amy', 'ch1');

    expect(blocksService.relationBetween).toHaveBeenCalledWith(
      'zed',
      'amy',
      tx,
    );
    expect(order(tx.$executeRaw)).toBeLessThan(
      order(blocksService.relationBetween),
    );
  });

  it.each([
    [
      'the challenger has blocked the opponent',
      { blockedByViewer: true, blockedViewer: false },
    ],
    [
      'the opponent has blocked the challenger',
      { blockedByViewer: false, blockedViewer: true },
    ],
    [
      'both have blocked each other',
      { blockedByViewer: true, blockedViewer: true },
    ],
  ])(
    'refuses to form a match when %s, cancels the challenge, and reveals nothing',
    async (_name, relation) => {
      const { service, tx, matchesService, emitter } = build(relation);

      await expect(service.accept('amy', 'ch1')).rejects.toThrow(
        new ConflictException('This challenge is no longer pending'),
      );

      expect(matchesService.createMatchGuarded).not.toHaveBeenCalled();
      // The one write is the cancellation - never the ACCEPTED claim.
      expect(tx.challenge.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.challenge.updateMany).toHaveBeenCalledWith({
        where: { id: 'ch1', status: 'PENDING' },
        data: { status: 'CANCELLED', respondedAt: expect.any(Date) },
      });
      for (const userId of ['zed', 'amy']) {
        expect(emitter.emitToUser).toHaveBeenCalledWith(
          userId,
          'challenge:resolved',
          { challengeId: 'ch1', status: 'CANCELLED' },
        );
      }
      expect(emitter.emitToUser).not.toHaveBeenCalledWith(
        expect.anything(),
        'challenge:resolved',
        expect.objectContaining({ status: 'ACCEPTED' }),
      );
    },
  );

  it('emits nothing when the blocked challenge had already left PENDING', async () => {
    const { service, emitter } = build(
      { blockedByViewer: false, blockedViewer: true },
      { claimCount: 0 },
    );

    await expect(service.accept('amy', 'ch1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(emitter.emitToUser).not.toHaveBeenCalled();
  });

  it('accepts normally when there is no block', async () => {
    const { service, tx, matchesService, emitter } = build(NONE);

    const result = await service.accept('amy', 'ch1');

    expect(tx.challenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'ACCEPTED', respondedAt: expect.any(Date) },
      }),
    );
    expect(matchesService.createMatchGuarded).toHaveBeenCalledTimes(1);
    expect(result.matchId).toBe('m1');
    expect(emitter.emitToUser).toHaveBeenCalledWith(
      'zed',
      'challenge:resolved',
      expect.objectContaining({ status: 'ACCEPTED', matchId: 'm1' }),
    );
  });
});
