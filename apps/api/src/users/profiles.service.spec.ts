import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ProfilesService } from './profiles.service.js';
import { BlocksService } from '../blocks/blocks.service.js';

/**
 * Phase 12 PR 2 - profiles, summaries and match statistics. The database is a
 * fake, so these prove the service's own behaviour: who is hidden, what is
 * returned, how many queries run, and the rules the statistics query encodes.
 * That the SQL really counts the right rows against Postgres is proved by
 * test/profiles.e2e-spec.ts, which only runs in CI.
 */

type UserRow = {
  id: string;
  username: string;
  displayName: string | null;
  status?: string;
  // Present on the fake row to prove they are never copied into a response.
  email?: string;
  phoneNumber?: string | null;
  dateOfBirth?: Date;
  role?: string;
  passwordHash?: string;
};

const user = (id: string, extra: Partial<UserRow> = {}): UserRow => ({
  id,
  username: `name-${id}`,
  displayName: null,
  status: 'ACTIVE',
  email: `${id}@example.com`,
  phoneNumber: '+23270000000',
  dateOfBirth: new Date('2000-01-01'),
  role: 'ADMIN',
  passwordHash: 'secret-hash',
  ...extra,
});

function build(
  options: {
    users?: UserRow[];
    blocks?: { blockerId: string; blockedId: string }[];
    statsRow?: { wins: bigint; losses: bigint; draws: bigint } | undefined;
  } = {},
) {
  const { users = [], blocks = [], statsRow } = options;
  const prisma = {
    user: {
      findUnique: vi.fn((args: { where: { id: string } }) =>
        Promise.resolve(users.find((u) => u.id === args.where.id) ?? null),
      ),
      findMany: vi.fn(
        (args: { where: { id: { in: string[] }; status: string } }) =>
          Promise.resolve(
            users.filter(
              (u) =>
                args.where.id.in.includes(u.id) &&
                u.status === args.where.status,
            ),
          ),
      ),
    },
    userBlock: { findMany: vi.fn(() => Promise.resolve(blocks)) },
    $queryRaw: vi.fn(() =>
      Promise.resolve(statsRow === undefined ? [] : [statsRow]),
    ),
  };
  const blocksService = new BlocksService(prisma as never, {} as never);
  const service = new ProfilesService(prisma as never, blocksService);
  return { service, prisma };
}

const PUBLIC_PROFILE_KEYS = [
  'displayName',
  'draws',
  'gamesPlayed',
  'id',
  'losses',
  'username',
  'wins',
];

describe('ProfilesService.getProfile', () => {
  it('returns exactly the public fields and never anything private', async () => {
    const { service } = build({
      users: [user('v'), user('p', { displayName: 'Pee' })],
      statsRow: { wins: 3n, losses: 2n, draws: 1n },
    });

    const profile = await service.getProfile('v', 'p');

    expect(Object.keys(profile).sort()).toEqual(PUBLIC_PROFILE_KEYS);
    expect(profile).toEqual({
      id: 'p',
      username: 'name-p',
      displayName: 'Pee',
      gamesPlayed: 6,
      wins: 3,
      losses: 2,
      draws: 1,
    });
    const json = JSON.stringify(profile);
    for (const secret of [
      'example.com',
      '+2327',
      '2000-01-01',
      'ADMIN',
      'secret-hash',
      'ACTIVE',
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it('returns a null display name as stored', async () => {
    const { service } = build({
      users: [user('v'), user('p', { displayName: null })],
    });

    expect((await service.getProfile('v', 'p')).displayName).toBeNull();
  });

  it('404s for a player that does not exist', async () => {
    const { service } = build({ users: [user('v')] });

    await expect(service.getProfile('v', 'nobody')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s for a player that is not ACTIVE', async () => {
    const { service } = build({
      users: [user('v'), user('p', { status: 'SUSPENDED' })],
    });

    await expect(service.getProfile('v', 'p')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a player who has blocked the viewer gets the exact same 404 as a nonexistent one', async () => {
    const hidden = build({
      users: [user('v'), user('p')],
      blocks: [{ blockerId: 'p', blockedId: 'v' }],
    });
    const missing = build({ users: [user('v')] });

    const hiddenError = await hidden.service
      .getProfile('v', 'p')
      .catch((e: NotFoundException) => e);
    const missingError = await missing.service
      .getProfile('v', 'nobody')
      .catch((e: NotFoundException) => e);

    expect(hiddenError).toBeInstanceOf(NotFoundException);
    expect((hiddenError as NotFoundException).getStatus()).toBe(404);
    expect((hiddenError as NotFoundException).getResponse()).toEqual(
      (missingError as NotFoundException).getResponse(),
    );
    // And it never got as far as computing statistics for them.
    expect(hidden.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('a blocker can still open the profile of a player they blocked', async () => {
    const { service } = build({
      users: [user('v'), user('p')],
      blocks: [{ blockerId: 'v', blockedId: 'p' }],
    });

    expect((await service.getProfile('v', 'p')).id).toBe('p');
  });

  it('is hidden when both have blocked each other (the other side blocked the viewer)', async () => {
    const { service } = build({
      users: [user('v'), user('p')],
      blocks: [
        { blockerId: 'v', blockedId: 'p' },
        { blockerId: 'p', blockedId: 'v' },
      ],
    });

    await expect(service.getProfile('v', 'p')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lets a player open their own profile without any block lookup', async () => {
    const { service, prisma } = build({ users: [user('v')] });

    expect((await service.getProfile('v', 'v')).id).toBe('v');
    expect(prisma.userBlock.findMany).not.toHaveBeenCalled();
  });
});

describe('ProfilesService.getMatchStats', () => {
  it('maps the aggregate row to numbers and derives gamesPlayed', async () => {
    const { service } = build({
      statsRow: { wins: 4n, losses: 5n, draws: 2n },
    });

    expect(await service.getMatchStats('p')).toEqual({
      gamesPlayed: 11,
      wins: 4,
      losses: 5,
      draws: 2,
    });
  });

  it('reports zeros when the aggregate returns no row', async () => {
    const { service } = build({ statsRow: undefined });

    expect(await service.getMatchStats('p')).toEqual({
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      draws: 0,
    });
  });

  it('keeps gamesPlayed equal to wins + losses + draws', async () => {
    const { service } = build({
      statsRow: { wins: 7n, losses: 0n, draws: 3n },
    });

    const stats = await service.getMatchStats('p');
    expect(stats.gamesPlayed).toBe(stats.wins + stats.losses + stats.draws);
  });

  it('runs exactly one query', async () => {
    const { service, prisma } = build({
      statsRow: { wins: 1n, losses: 1n, draws: 1n },
    });

    await service.getMatchStats('p');

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  describe('the statistics query encodes the counting rules', () => {
    async function sqlFor(userId: string) {
      const { service, prisma } = build({
        statsRow: { wins: 0n, losses: 0n, draws: 0n },
      });
      await service.getMatchStats(userId);
      const [strings, ...values] = prisma.$queryRaw.mock
        .calls[0] as unknown as [string[], ...unknown[]];
      return {
        sql: strings.join('?').replace(/\s+/g, ' '),
        values,
      };
    }

    it('counts only COMPLETED matches', async () => {
      const { sql } = await sqlFor('p');

      expect(sql).toContain("WHERE m.status = 'COMPLETED'");
      for (const excluded of ['ABANDONED', 'CANCELLED', 'EXPIRED', 'ACTIVE']) {
        expect(sql).not.toContain(excluded);
      }
    });

    it('requires the player to be one of the match’s players', async () => {
      const { sql } = await sqlFor('p');

      expect(sql).toMatch(
        /EXISTS \( SELECT 1 FROM match_players p WHERE p\."matchId" = m\.id AND p\."userId" = \?\s*\)/,
      );
    });

    it('a win needs a non-draw result naming the player as winner', async () => {
      const { sql } = await sqlFor('p');

      expect(sql).toContain(
        `m."resultIsDraw" = false AND m."winnerUserId" = ?`,
      );
    });

    it('a loss needs a non-draw result naming a different winner who is also a player', async () => {
      const { sql } = await sqlFor('p');

      expect(sql).toContain('m."winnerUserId" IS NOT NULL');
      expect(sql).toContain('m."winnerUserId" <> ?');
      expect(sql).toMatch(
        /SELECT 1 FROM match_players w WHERE w\."matchId" = m\.id AND w\."userId" = m\."winnerUserId"/,
      );
    });

    it('a draw needs an explicit draw result with no winner', async () => {
      const { sql } = await sqlFor('p');

      expect(sql).toContain(
        `m."resultIsDraw" = true AND m."winnerUserId" IS NULL`,
      );
    });

    it('reads only matches and match_players - never money, stakes, settlement or challenges', async () => {
      const { sql } = await sqlFor('p');

      expect(sql).toMatch(/FROM matches m/);
      for (const forbidden of [
        'wallet',
        'ledger',
        'settlement',
        'stake',
        'challenge',
        'deposit',
        'withdrawal',
        'disconnectedAt',
        'terminationReason',
      ]) {
        expect(sql.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    });

    it('binds the player id as a parameter, never into the SQL text', async () => {
      const { sql, values } = await sqlFor("p'; DROP TABLE matches;--");

      expect(sql).not.toContain('DROP TABLE');
      // One bound parameter per use of the id: the win, the loss and the
      // participation checks.
      expect(values).toEqual(Array(3).fill("p'; DROP TABLE matches;--"));
    });
  });
});

describe('ProfilesService.getSummaries', () => {
  const players = [user('v'), user('a'), user('b'), user('c'), user('d')];

  it('returns nothing - and runs no query - for an empty list', async () => {
    const { service, prisma } = build({ users: players });

    expect(await service.getSummaries('v', [])).toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.userBlock.findMany).not.toHaveBeenCalled();
  });

  it('returns only id, username and display name', async () => {
    const { service } = build({
      users: [user('v'), user('a', { displayName: 'Ay' })],
    });

    const [summary] = await service.getSummaries('v', ['a']);

    expect(Object.keys(summary).sort()).toEqual([
      'displayName',
      'id',
      'username',
    ]);
    expect(summary).toEqual({ id: 'a', username: 'name-a', displayName: 'Ay' });
    expect(JSON.stringify(summary)).not.toContain('example.com');
  });

  it('uses two queries however many players are asked for (no N+1)', async () => {
    const many = Array.from({ length: 50 }, (_, i) => user(`u${i}`));
    const { service, prisma } = build({ users: [user('v'), ...many] });

    const result = await service.getSummaries(
      'v',
      many.map((u) => u.id),
    );

    expect(result).toHaveLength(50);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.userBlock.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('hides a player in BOTH block directions', async () => {
    const { service } = build({
      users: players,
      blocks: [
        { blockerId: 'v', blockedId: 'a' }, // the viewer blocked a
        { blockerId: 'b', blockedId: 'v' }, // b blocked the viewer
        { blockerId: 'v', blockedId: 'c' }, // both ways with c
        { blockerId: 'c', blockedId: 'v' },
      ],
    });

    const result = await service.getSummaries('v', ['a', 'b', 'c', 'd']);

    expect(result.map((r) => r.id)).toEqual(['d']);
  });

  it('a hidden player is indistinguishable from a nonexistent one', async () => {
    const hidden = build({
      users: players,
      blocks: [{ blockerId: 'a', blockedId: 'v' }],
    });
    const missing = build({ users: players });

    expect(await hidden.service.getSummaries('v', ['a', 'd'])).toEqual(
      await missing.service.getSummaries('v', ['ghost', 'd']),
    );
  });

  it('omits players that are not ACTIVE', async () => {
    const { service } = build({
      users: [user('v'), user('a', { status: 'SUSPENDED' }), user('b')],
    });

    expect(
      (await service.getSummaries('v', ['a', 'b'])).map((r) => r.id),
    ).toEqual(['b']);
  });

  it('always includes the viewer themselves, with no block lookup for them', async () => {
    const { service, prisma } = build({ users: [user('v')] });

    expect((await service.getSummaries('v', ['v'])).map((r) => r.id)).toEqual([
      'v',
    ]);
    // Nobody else was asked about, so the block query was handed an empty
    // list and never ran.
    expect(prisma.userBlock.findMany).not.toHaveBeenCalled();
  });

  it('keeps the order of the requested ids', async () => {
    const { service } = build({ users: players });

    const result = await service.getSummaries('v', ['d', 'a', 'v', 'b']);

    expect(result.map((r) => r.id)).toEqual(['d', 'a', 'v', 'b']);
  });

  it('shows normal, unblocked players', async () => {
    const { service } = build({ users: players });

    expect(
      (await service.getSummaries('v', ['a', 'b'])).map((r) => r.id),
    ).toEqual(['a', 'b']);
  });
});
