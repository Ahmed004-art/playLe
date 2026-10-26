import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FriendsService } from './friends.service.js';
import {
  MAX_FRIENDS,
  MAX_OUTGOING_PENDING_REQUESTS,
} from './friends.constants.js';
import { orderPair, pairKeyOf } from '../blocks/pair-lock.js';
import { isHiddenFromSummaries } from '../blocks/block-visibility.js';
import {
  toFriendRequestResponse,
  toFriendResponse,
} from './dto/friends.dto.js';

/**
 * Phase 12 PR 3 (ADR-026) - friend requests, friendships and presence.
 *
 * The database is an in-memory fake that behaves like the real one where it
 * matters here: `$transaction` rolls every write back when its callback throws,
 * the unique `pendingPairKey` and the CHECK constraints are enforced, and every
 * operation is logged in order so lock ordering and "emit after commit" can be
 * asserted. That the real Postgres constraints, locks and concurrency behave
 * the same is proved by test/friends.e2e-spec.ts, which only runs in CI.
 */

type UserRow = {
  id: string;
  username: string;
  displayName: string | null;
  status: string;
  // Never allowed to reach a response or an event.
  email: string;
};
type RequestRow = {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';
  pendingPairKey: string | null;
  createdAt: Date;
  respondedAt: Date | null;
};
type FriendshipRow = { userLowId: string; userHighId: string; createdAt: Date };

class UniqueViolation extends Error {
  code = 'P2002';
}

function makeDb(seed: {
  users?: string[];
  inactive?: string[];
  blocks?: { blockerId: string; blockedId: string }[];
  friendships?: [string, string][];
  requests?: Partial<RequestRow>[];
}) {
  let clock = 1;
  const nextDate = () => new Date(2026, 0, 1, 0, 0, clock++);
  const state = {
    users: new Map<string, UserRow>(),
    requests: [] as RequestRow[],
    friendships: [] as FriendshipRow[],
    blocks: [...(seed.blocks ?? [])],
  };
  for (const id of seed.users ?? []) {
    state.users.set(id, {
      id,
      username: `name-${id}`,
      displayName: id === 'a' ? 'Ay' : null,
      status: seed.inactive?.includes(id) ? 'SUSPENDED' : 'ACTIVE',
      email: `${id}@example.com`,
    });
  }
  for (const [x, y] of seed.friendships ?? []) {
    const { low, high } = orderPair(x, y);
    state.friendships.push({
      userLowId: low,
      userHighId: high,
      createdAt: nextDate(),
    });
  }
  let requestSeq = 1;
  for (const r of seed.requests ?? []) {
    const requesterId = r.requesterId as string;
    const addresseeId = r.addresseeId as string;
    state.requests.push({
      id: r.id ?? `req-${requestSeq++}`,
      requesterId,
      addresseeId,
      status: r.status ?? 'PENDING',
      pendingPairKey:
        (r.status ?? 'PENDING') === 'PENDING'
          ? pairKeyOf(requesterId, addresseeId)
          : null,
      createdAt: nextDate(),
      respondedAt: null,
    });
  }

  /** Everything the fake does, in order, so tests can assert sequencing. */
  const log: string[] = [];
  let txDepth = 0;

  const withUsers = (r: RequestRow) => ({
    ...r,
    requester: { ...state.users.get(r.requesterId)! },
    addressee: { ...state.users.get(r.addresseeId)! },
  });
  const matches = (r: RequestRow, where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
    );
  const involves = (f: FriendshipRow, id: string) =>
    f.userLowId === id || f.userHighId === id;

  const db = {
    user: {
      findUnique: vi.fn((args: { where: { id: string } }) => {
        log.push('user.findUnique');
        const u = state.users.get(args.where.id);
        return Promise.resolve(u ? { ...u } : null);
      }),
    },
    friendRequest: {
      findUnique: vi.fn(
        (args: { where: { id?: string; pendingPairKey?: string } }) => {
          log.push('request.findUnique');
          const r = state.requests.find((x) =>
            args.where.id !== undefined
              ? x.id === args.where.id
              : x.pendingPairKey === args.where.pendingPairKey,
          );
          return Promise.resolve(r ? withUsers(r) : null);
        },
      ),
      findUniqueOrThrow: vi.fn((args: { where: { id: string } }) => {
        log.push('request.findUniqueOrThrow');
        const r = state.requests.find((x) => x.id === args.where.id);
        return r
          ? Promise.resolve(withUsers(r))
          : Promise.reject(new Error('nf'));
      }),
      count: vi.fn((args: { where: Record<string, unknown> }) => {
        log.push('request.count');
        return Promise.resolve(
          state.requests.filter((r) => matches(r, args.where)).length,
        );
      }),
      create: vi.fn(
        (args: {
          data: {
            requesterId: string;
            addresseeId: string;
            pendingPairKey: string;
          };
        }) => {
          log.push('request.create');
          const { requesterId, addresseeId, pendingPairKey } = args.data;
          // The CHECK constraints and the unique index of the real table.
          if (requesterId === addresseeId)
            throw new Error('CHECK: self request');
          if (pendingPairKey !== pairKeyOf(requesterId, addresseeId)) {
            throw new Error('CHECK: pendingPairKey is not the sorted pair');
          }
          if (state.requests.some((r) => r.pendingPairKey === pendingPairKey)) {
            throw new UniqueViolation('pendingPairKey');
          }
          const row: RequestRow = {
            id: `req-${requestSeq++}`,
            requesterId,
            addresseeId,
            status: 'PENDING',
            pendingPairKey,
            createdAt: nextDate(),
            respondedAt: null,
          };
          state.requests.push(row);
          return Promise.resolve(withUsers(row));
        },
      ),
      updateMany: vi.fn(
        (args: {
          where: Record<string, unknown>;
          data: Partial<RequestRow>;
        }) => {
          log.push('request.updateMany');
          const rows = state.requests.filter((r) => matches(r, args.where));
          for (const r of rows) {
            Object.assign(r, args.data);
            // CHECK: pendingPairKey is set exactly while PENDING.
            if ((r.status === 'PENDING') !== (r.pendingPairKey !== null)) {
              throw new Error('CHECK: pendingPairKey vs status');
            }
          }
          return Promise.resolve({ count: rows.length });
        },
      ),
      findMany: vi.fn(
        (args: {
          where: Record<string, unknown>;
          take: number;
          cursor?: { id: string };
        }) => {
          log.push('request.findMany');
          let rows = state.requests
            .filter((r) => matches(r, args.where))
            .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
          if (args.cursor) {
            const i = rows.findIndex((r) => r.id === args.cursor!.id);
            rows = rows.slice(i + 1);
          }
          return Promise.resolve(rows.slice(0, args.take).map(withUsers));
        },
      ),
    },
    friendship: {
      findUnique: vi.fn(
        (args: {
          where: {
            userLowId_userHighId: { userLowId: string; userHighId: string };
          };
        }) => {
          log.push('friendship.findUnique');
          const k = args.where.userLowId_userHighId;
          const f = state.friendships.find(
            (x) => x.userLowId === k.userLowId && x.userHighId === k.userHighId,
          );
          return Promise.resolve(f ? { ...f } : null);
        },
      ),
      count: vi.fn(
        (args: {
          where: { OR: { userLowId?: string; userHighId?: string }[] };
        }) => {
          log.push('friendship.count');
          const id = (args.where.OR[0].userLowId ??
            args.where.OR[1].userHighId)!;
          return Promise.resolve(
            state.friendships.filter((f) => involves(f, id)).length,
          );
        },
      ),
      createMany: vi.fn(
        (args: { data: { userLowId: string; userHighId: string }[] }) => {
          log.push('friendship.createMany');
          let count = 0;
          for (const d of args.data) {
            if (!(d.userLowId < d.userHighId)) {
              throw new Error('CHECK: friendship not canonical (low < high)');
            }
            if (
              state.friendships.some(
                (f) =>
                  f.userLowId === d.userLowId && f.userHighId === d.userHighId,
              )
            ) {
              continue; // skipDuplicates
            }
            state.friendships.push({ ...d, createdAt: nextDate() });
            count++;
          }
          return Promise.resolve({ count });
        },
      ),
      deleteMany: vi.fn(
        (args: { where: { userLowId: string; userHighId: string } }) => {
          log.push('friendship.deleteMany');
          const before = state.friendships.length;
          state.friendships = state.friendships.filter(
            (f) =>
              !(
                f.userLowId === args.where.userLowId &&
                f.userHighId === args.where.userHighId
              ),
          );
          return Promise.resolve({ count: before - state.friendships.length });
        },
      ),
      findMany: vi.fn(
        (args: {
          where: { OR: { userLowId?: string; userHighId?: string }[] };
          take: number;
          cursor?: {
            userLowId_userHighId: { userLowId: string; userHighId: string };
          };
        }) => {
          log.push('friendship.findMany');
          const me = (args.where.OR[0].userLowId ??
            args.where.OR[1].userHighId)!;
          let rows = state.friendships
            .filter((f) => involves(f, me))
            .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
          if (args.cursor) {
            const k = args.cursor.userLowId_userHighId;
            const i = rows.findIndex(
              (f) =>
                f.userLowId === k.userLowId && f.userHighId === k.userHighId,
            );
            rows = rows.slice(i + 1);
          }
          return Promise.resolve(
            rows.slice(0, args.take).map((f) => ({
              ...f,
              low: { ...state.users.get(f.userLowId)! },
              high: { ...state.users.get(f.userHighId)! },
            })),
          );
        },
      ),
    },
    $executeRaw: vi.fn(() => {
      log.push('lock');
      return Promise.resolve(1);
    }),
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const snapshot = {
        requests: state.requests.map((r) => ({ ...r })),
        friendships: state.friendships.map((f) => ({ ...f })),
      };
      txDepth++;
      log.push('tx:begin');
      try {
        const result = await cb(db);
        log.push('tx:commit');
        return result;
      } catch (error) {
        // A failed transaction leaves nothing behind.
        state.requests = snapshot.requests;
        state.friendships = snapshot.friendships;
        log.push('tx:rollback');
        throw error;
      } finally {
        txDepth--;
      }
    }),
  };
  void txDepth;
  return { db, state, log };
}

function build(
  seed: Parameters<typeof makeDb>[0] & {
    presence?: Map<string, string | null> | Error;
  },
) {
  const { db, state, log } = makeDb(seed);
  const relationFor = (viewer: string, other: string) => ({
    blockedByViewer: state.blocks.some(
      (b) => b.blockerId === viewer && b.blockedId === other,
    ),
    blockedViewer: state.blocks.some(
      (b) => b.blockerId === other && b.blockedId === viewer,
    ),
  });
  const blocksService = {
    relationBetween: vi.fn((viewer: string, other: string) => {
      log.push('blocks.relationBetween');
      return Promise.resolve(relationFor(viewer, other));
    }),
    relationsBetween: vi.fn((viewer: string, others: string[]) => {
      log.push('blocks.relationsBetween');
      return Promise.resolve(
        new Map(others.map((o) => [o, relationFor(viewer, o)])),
      );
    }),
  };
  const presenceSeed = seed.presence;
  const presenceService = {
    getMany: vi.fn((ids: string[]) => {
      log.push('presence.getMany');
      if (presenceSeed instanceof Error) return Promise.reject(presenceSeed);
      return Promise.resolve(
        new Map(
          ids.map((id) => [id, (presenceSeed?.get(id) ?? null) as never]),
        ),
      );
    }),
    get: vi.fn(),
  };
  const emitter = {
    emitToUser: vi.fn(
      (userId: string, event: string, ..._payload: unknown[]) => {
        log.push(`emit:${event}:${userId}`);
      },
    ),
  };
  const service = new FriendsService(
    db as never,
    blocksService as never,
    presenceService as never,
    emitter as never,
  );
  return { service, db, state, log, blocksService, presenceService, emitter };
}

const ids = (...names: string[]) => names;
const idx = (log: string[], entry: string) => log.indexOf(entry);

describe('FriendsService.sendRequest', () => {
  it('refuses a self-request without touching the database', async () => {
    const { service, db } = build({ users: ids('a') });

    await expect(service.sendRequest('a', 'a')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('404s for a player who does not exist, or is not ACTIVE', async () => {
    const { service } = build({ users: ids('a', 'b'), inactive: ids('b') });

    await expect(service.sendRequest('a', 'nobody')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.sendRequest('a', 'b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a player who blocked the sender gets exactly the 404 of a nonexistent player, and nothing is written', async () => {
    const hidden = build({
      users: ids('a', 'b'),
      blocks: [{ blockerId: 'b', blockedId: 'a' }],
    });
    const missing = build({ users: ids('a') });

    const hiddenError = await hidden.service
      .sendRequest('a', 'b')
      .catch((e: NotFoundException) => e);
    const missingError = await missing.service
      .sendRequest('a', 'nobody')
      .catch((e: NotFoundException) => e);

    expect(hiddenError).toBeInstanceOf(NotFoundException);
    expect((hiddenError as NotFoundException).getResponse()).toEqual(
      (missingError as NotFoundException).getResponse(),
    );
    expect(hidden.state.requests).toHaveLength(0);
    expect(hidden.emitter.emitToUser).not.toHaveBeenCalled();
  });

  it('tells the blocker plainly (409), including when both blocked each other', async () => {
    const mine = build({
      users: ids('a', 'b'),
      blocks: [{ blockerId: 'a', blockedId: 'b' }],
    });
    const both = build({
      users: ids('a', 'b'),
      blocks: [
        { blockerId: 'a', blockedId: 'b' },
        { blockerId: 'b', blockedId: 'a' },
      ],
    });

    await expect(mine.service.sendRequest('a', 'b')).rejects.toThrow(
      new ConflictException('You have blocked this player'),
    );
    await expect(both.service.sendRequest('a', 'b')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('creates a PENDING request keyed by the sorted pair, and tells only the recipient, after commit', async () => {
    const { service, state, emitter, log } = build({
      users: ids('a', 'b', 'c'),
    });

    const request = await service.sendRequest('b', 'a');

    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]).toMatchObject({
      requesterId: 'b',
      addresseeId: 'a',
      status: 'PENDING',
      pendingPairKey: 'a:b',
    });
    expect(request.id).toBe(state.requests[0].id);
    expect(emitter.emitToUser).toHaveBeenCalledTimes(1);
    expect(emitter.emitToUser).toHaveBeenCalledWith(
      'a',
      'friend:request-received',
      {
        requestId: state.requests[0].id,
        from: { id: 'b', username: 'name-b', displayName: null },
      },
    );
    expect(idx(log, 'tx:commit')).toBeLessThan(
      idx(log, 'emit:friend:request-received:a'),
    );
  });

  it('never puts anything private in the event or the response', async () => {
    const { service, emitter } = build({ users: ids('a', 'b') });

    const request = await service.sendRequest('b', 'a');

    const payload = emitter.emitToUser.mock.calls[0][2];
    for (const value of [payload, toFriendRequestResponse(request, 'b')]) {
      const json = JSON.stringify(value);
      expect(json).not.toContain('example.com');
      expect(json).not.toContain('ACTIVE');
      expect(json).not.toContain('email');
      expect(json).not.toContain('pendingPairKey');
    }
    expect(Object.keys(toFriendRequestResponse(request, 'b')).sort()).toEqual([
      'createdAt',
      'direction',
      'id',
      'player',
      'respondedAt',
      'status',
    ]);
  });

  it('takes the pair lock and then both friend slots before reading anything', async () => {
    const { service, log } = build({ users: ids('a', 'b') });

    await service.sendRequest('a', 'b');

    const begin = idx(log, 'tx:begin');
    expect(log.slice(begin + 1, begin + 4)).toEqual(['lock', 'lock', 'lock']);
    expect(idx(log, 'blocks.relationBetween')).toBeGreaterThan(begin + 3);
    expect(idx(log, 'friendship.findUnique')).toBeGreaterThan(begin + 3);
    expect(idx(log, 'request.findUnique')).toBeGreaterThan(begin + 3);
  });

  it('a duplicate request in the same direction is a 409 and creates nothing', async () => {
    const { service, state } = build({
      users: ids('a', 'b'),
      requests: [{ requesterId: 'a', addresseeId: 'b' }],
    });

    await expect(service.sendRequest('a', 'b')).rejects.toThrow(
      new ConflictException(
        'You already have a pending friend request to this player',
      ),
    );
    expect(state.requests).toHaveLength(1);
  });

  it('refuses a request to someone who is already a friend', async () => {
    const { service, state } = build({
      users: ids('a', 'b'),
      friendships: [['a', 'b']],
    });

    await expect(service.sendRequest('b', 'a')).rejects.toThrow(
      new ConflictException('You are already friends with this player'),
    );
    expect(state.requests).toHaveLength(0);
  });

  it('a crossed request accepts theirs: exactly one friendship, the request ACCEPTED, the original sender told', async () => {
    const { service, state, emitter, log } = build({
      users: ids('a', 'b'),
      requests: [{ id: 'theirs', requesterId: 'b', addresseeId: 'a' }],
    });

    const result = await service.sendRequest('a', 'b');

    expect(result.status).toBe('ACCEPTED');
    expect(result.id).toBe('theirs');
    expect(state.requests).toHaveLength(1); // no second request row
    expect(state.requests[0]).toMatchObject({
      status: 'ACCEPTED',
      pendingPairKey: null,
    });
    expect(state.friendships).toHaveLength(1);
    expect(state.friendships[0]).toMatchObject({
      userLowId: 'a',
      userHighId: 'b',
    });

    expect(emitter.emitToUser).toHaveBeenCalledTimes(1);
    expect(emitter.emitToUser).toHaveBeenCalledWith(
      'b',
      'friend:request-accepted',
      {
        requestId: 'theirs',
        friend: { id: 'a', username: 'name-a', displayName: 'Ay' },
      },
    );
    expect(idx(log, 'tx:commit')).toBeLessThan(
      idx(log, 'emit:friend:request-accepted:b'),
    );
  });

  it('after a crossed accept a further send is refused as already friends (one friendship, ever)', async () => {
    const { service, state } = build({
      users: ids('a', 'b'),
      requests: [{ requesterId: 'b', addresseeId: 'a' }],
    });
    await service.sendRequest('a', 'b');

    await expect(service.sendRequest('b', 'a')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(state.friendships).toHaveLength(1);
  });

  describe('limits', () => {
    const many = (n: number, prefix: string) =>
      Array.from(
        { length: n },
        (_, i) => `${prefix}${String(i).padStart(3, '0')}`,
      );

    it(`allows ${MAX_OUTGOING_PENDING_REQUESTS - 1} pending and then the ${MAX_OUTGOING_PENDING_REQUESTS}th, refuses the next`, async () => {
      const targets = many(MAX_OUTGOING_PENDING_REQUESTS + 1, 't');
      const { service, state, emitter } = build({
        users: ['me', ...targets],
        requests: targets
          .slice(0, MAX_OUTGOING_PENDING_REQUESTS - 1)
          .map((t) => ({ requesterId: 'me', addresseeId: t })),
      });

      await service.sendRequest(
        'me',
        targets[MAX_OUTGOING_PENDING_REQUESTS - 1],
      );
      expect(state.requests).toHaveLength(MAX_OUTGOING_PENDING_REQUESTS);

      await expect(
        service.sendRequest('me', targets[MAX_OUTGOING_PENDING_REQUESTS]),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(state.requests).toHaveLength(MAX_OUTGOING_PENDING_REQUESTS);
      expect(emitter.emitToUser).toHaveBeenCalledTimes(1);
    });

    it('resolved requests do not count against the outgoing limit', async () => {
      const targets = many(MAX_OUTGOING_PENDING_REQUESTS + 1, 't');
      const { service } = build({
        users: ['me', ...targets],
        requests: targets
          .slice(0, MAX_OUTGOING_PENDING_REQUESTS)
          .map((t, i) => ({
            requesterId: 'me',
            addresseeId: t,
            status: i === 0 ? ('DECLINED' as const) : ('PENDING' as const),
          })),
      });

      await expect(
        service.sendRequest('me', targets[MAX_OUTGOING_PENDING_REQUESTS]),
      ).resolves.toBeDefined();
    });

    it('a crossed request cannot push either player past the friend limit: rolled back, still PENDING, nobody told', async () => {
      const friends = many(MAX_FRIENDS, 'f');
      const { service, state, emitter } = build({
        users: ['me', 'other', ...friends],
        friendships: friends.map((f) => ['me', f] as [string, string]),
        requests: [{ id: 'theirs', requesterId: 'other', addresseeId: 'me' }],
      });

      await expect(service.sendRequest('me', 'other')).rejects.toThrow(
        new ConflictException(
          `Your friend list is full (limit ${MAX_FRIENDS})`,
        ),
      );

      expect(state.requests[0]).toMatchObject({
        id: 'theirs',
        status: 'PENDING',
        pendingPairKey: 'me:other',
      });
      expect(state.friendships).toHaveLength(MAX_FRIENDS);
      expect(emitter.emitToUser).not.toHaveBeenCalled();
    });
  });

  it('a unique-key violation from the database surfaces as an error, never as a second open request', async () => {
    const { service, state, db } = build({ users: ids('a', 'b') });
    // The application-level check is bypassed (as a lost race would): the
    // table's unique index is the backstop.
    db.friendRequest.findUnique.mockResolvedValueOnce(null);
    state.requests.push({
      id: 'sneaky',
      requesterId: 'a',
      addresseeId: 'b',
      status: 'PENDING',
      pendingPairKey: 'a:b',
      createdAt: new Date(),
      respondedAt: null,
    });

    await expect(service.sendRequest('a', 'b')).rejects.toMatchObject({
      code: 'P2002',
    });
    expect(
      state.requests.filter((r) => r.pendingPairKey === 'a:b'),
    ).toHaveLength(1);
  });
});

describe('FriendsService.acceptRequest', () => {
  const pending = (extra: Partial<RequestRow> = {}) => ({
    id: 'req',
    requesterId: 'a',
    addresseeId: 'b',
    ...extra,
  });

  it('creates the canonical friendship and tells the SENDER only, after commit, with a minimal payload', async () => {
    const { service, state, emitter, log } = build({
      users: ids('a', 'b'),
      requests: [pending()],
    });

    const result = await service.acceptRequest('b', 'req');

    expect(result.status).toBe('ACCEPTED');
    expect(state.requests[0]).toMatchObject({
      status: 'ACCEPTED',
      pendingPairKey: null,
    });
    expect(state.friendships).toEqual([
      expect.objectContaining({ userLowId: 'a', userHighId: 'b' }),
    ]);
    expect(emitter.emitToUser).toHaveBeenCalledTimes(1);
    expect(emitter.emitToUser).toHaveBeenCalledWith(
      'a',
      'friend:request-accepted',
      {
        requestId: 'req',
        friend: { id: 'b', username: 'name-b', displayName: null },
      },
    );
    expect(JSON.stringify(emitter.emitToUser.mock.calls)).not.toContain(
      'example.com',
    );
    expect(idx(log, 'tx:commit')).toBeLessThan(
      idx(log, 'emit:friend:request-accepted:a'),
    );
  });

  it('takes the pair lock and the friend slots before claiming the request row', async () => {
    const { service, log } = build({
      users: ids('a', 'b'),
      requests: [pending()],
    });

    await service.acceptRequest('b', 'req');

    const begin = idx(log, 'tx:begin');
    expect(log.slice(begin + 1, begin + 4)).toEqual(['lock', 'lock', 'lock']);
    expect(idx(log, 'request.updateMany')).toBeGreaterThan(begin + 3);
  });

  it('404s for someone who is not a party, 403s for the sender, 404s for an unknown id', async () => {
    const { service } = build({
      users: ids('a', 'b', 'c'),
      requests: [pending()],
    });

    await expect(service.acceptRequest('c', 'req')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.acceptRequest('a', 'req')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.acceptRequest('b', 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('accepting twice is a 409 and does not make a second friendship', async () => {
    const { service, state } = build({
      users: ids('a', 'b'),
      requests: [pending()],
    });
    await service.acceptRequest('b', 'req');

    await expect(service.acceptRequest('b', 'req')).rejects.toThrow(
      new ConflictException('This friend request is no longer pending'),
    );
    expect(state.friendships).toHaveLength(1);
  });

  it('cannot accept a declined or cancelled request', async () => {
    const declined = build({
      users: ids('a', 'b'),
      requests: [pending({ status: 'DECLINED' })],
    });
    const cancelled = build({
      users: ids('a', 'b'),
      requests: [pending({ status: 'CANCELLED' })],
    });

    await expect(
      declined.service.acceptRequest('b', 'req'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      cancelled.service.acceptRequest('b', 'req'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(declined.state.friendships).toHaveLength(0);
  });

  describe('the friend limit', () => {
    const friends = Array.from(
      { length: MAX_FRIENDS },
      (_, i) => `f${String(i).padStart(3, '0')}`,
    );

    it('refuses when the ACCEPTOR is at the limit: rolled back, still PENDING, nobody told', async () => {
      const { service, state, emitter } = build({
        users: ['a', 'b', ...friends],
        friendships: friends.map((f) => ['b', f] as [string, string]),
        requests: [pending()],
      });

      await expect(service.acceptRequest('b', 'req')).rejects.toThrow(
        new ConflictException(
          `Your friend list is full (limit ${MAX_FRIENDS})`,
        ),
      );

      expect(state.requests[0].status).toBe('PENDING');
      expect(state.requests[0].pendingPairKey).toBe('a:b');
      expect(state.friendships).toHaveLength(MAX_FRIENDS);
      expect(emitter.emitToUser).not.toHaveBeenCalled();
    });

    it('refuses when the SENDER is at the limit, without revealing that to the acceptor', async () => {
      const { service, state, emitter } = build({
        users: ['a', 'b', ...friends],
        friendships: friends.map((f) => ['a', f] as [string, string]),
        requests: [pending()],
      });

      const error = await service
        .acceptRequest('b', 'req')
        .catch((e: ConflictException) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toBe(
        'This friend request cannot be accepted',
      );
      expect((error as ConflictException).message).not.toMatch(
        /full|200|limit/i,
      );
      expect(state.requests[0].status).toBe('PENDING');
      expect(emitter.emitToUser).not.toHaveBeenCalled();
    });

    it(`accepts the ${MAX_FRIENDS}th friend, then refuses the ${MAX_FRIENDS + 1}th`, async () => {
      const { service, state } = build({
        users: ['a', 'b', 'c', ...friends.slice(0, MAX_FRIENDS - 1)],
        friendships: friends
          .slice(0, MAX_FRIENDS - 1)
          .map((f) => ['b', f] as [string, string]),
        requests: [
          pending({ id: 'r1', requesterId: 'a' }),
          pending({ id: 'r2', requesterId: 'c' }),
        ],
      });

      await service.acceptRequest('b', 'r1');
      await expect(service.acceptRequest('b', 'r2')).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(
        state.friendships.filter(
          (f) => f.userLowId === 'b' || f.userHighId === 'b',
        ),
      ).toHaveLength(MAX_FRIENDS);
    });
  });

  it('if a block exists by the time of acceptance the request is cancelled (and that is committed), not accepted, and nothing reveals the block', async () => {
    const { service, state, emitter, log } = build({
      users: ids('a', 'b'),
      requests: [pending()],
      blocks: [{ blockerId: 'a', blockedId: 'b' }],
    });

    await expect(service.acceptRequest('b', 'req')).rejects.toThrow(
      new ConflictException('This friend request is no longer pending'),
    );

    expect(state.requests[0]).toMatchObject({
      status: 'CANCELLED',
      pendingPairKey: null,
    });
    expect(state.friendships).toHaveLength(0);
    expect(emitter.emitToUser).not.toHaveBeenCalled();
    // The cancellation was committed, not rolled back by the thrown error.
    expect(log).toContain('tx:commit');
    expect(log).not.toContain('tx:rollback');
  });
});

describe('FriendsService.declineRequest and cancelRequest', () => {
  const pending = { id: 'req', requesterId: 'a', addresseeId: 'b' };

  it('only the recipient may decline; only the sender may cancel; strangers get 404', async () => {
    const { service } = build({
      users: ids('a', 'b', 'c'),
      requests: [pending],
    });

    await expect(service.declineRequest('a', 'req')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.cancelRequest('b', 'req')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.declineRequest('c', 'req')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.cancelRequest('c', 'req')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('decline resolves the request, frees the pair key, creates no friendship and tells nobody', async () => {
    const { service, state, emitter } = build({
      users: ids('a', 'b'),
      requests: [pending],
    });

    const result = await service.declineRequest('b', 'req');

    expect(result.status).toBe('DECLINED');
    expect(state.requests[0]).toMatchObject({
      status: 'DECLINED',
      pendingPairKey: null,
    });
    expect(state.friendships).toHaveLength(0);
    expect(emitter.emitToUser).not.toHaveBeenCalled();
  });

  it('cancel resolves the request and frees the pair key', async () => {
    const { service, state } = build({
      users: ids('a', 'b'),
      requests: [pending],
    });

    const result = await service.cancelRequest('a', 'req');

    expect(result.status).toBe('CANCELLED');
    expect(state.requests[0].pendingPairKey).toBeNull();
  });

  it('a resolved request cannot be resolved again (409)', async () => {
    const { service } = build({ users: ids('a', 'b'), requests: [pending] });
    await service.declineRequest('b', 'req');

    await expect(service.declineRequest('b', 'req')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('after a decline the pair can ask again - the old request does not block a new one', async () => {
    const { service, state } = build({
      users: ids('a', 'b'),
      requests: [pending],
    });
    await service.declineRequest('b', 'req');

    await service.sendRequest('a', 'b');

    expect(state.requests.map((r) => r.status).sort()).toEqual([
      'DECLINED',
      'PENDING',
    ]);
  });
});

describe('FriendsService.removeFriend', () => {
  it('takes the pair lock first, removes the friendship, and nothing recreates it', async () => {
    const { service, state, log } = build({
      users: ids('a', 'b'),
      friendships: [['a', 'b']],
    });

    await service.removeFriend('b', 'a');

    expect(idx(log, 'lock')).toBeLessThan(idx(log, 'friendship.deleteMany'));
    expect(state.friendships).toHaveLength(0);
    expect(state.requests).toHaveLength(0);
  });

  it('404s when they are not friends, and refuses removing yourself', async () => {
    const { service } = build({ users: ids('a', 'b') });

    await expect(service.removeFriend('a', 'b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.removeFriend('a', 'a')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('removing one friend leaves the others', async () => {
    const { service, state } = build({
      users: ids('a', 'b', 'c'),
      friendships: [
        ['a', 'b'],
        ['a', 'c'],
      ],
    });

    await service.removeFriend('a', 'b');

    expect(state.friendships).toEqual([
      expect.objectContaining({ userLowId: 'a', userHighId: 'c' }),
    ]);
  });
});

describe('FriendsService.listRequests', () => {
  it('lists only PENDING requests in the asked direction', async () => {
    const { service } = build({
      users: ids('a', 'b', 'c', 'd'),
      requests: [
        { id: 'in1', requesterId: 'b', addresseeId: 'a' },
        { id: 'out1', requesterId: 'a', addresseeId: 'c' },
        { id: 'old', requesterId: 'd', addresseeId: 'a', status: 'DECLINED' },
      ],
    });

    const incoming = await service.listRequests('a', 'incoming', { limit: 20 });
    const outgoing = await service.listRequests('a', 'outgoing', { limit: 20 });

    expect(incoming.items.map((r) => r.id)).toEqual(['in1']);
    expect(outgoing.items.map((r) => r.id)).toEqual(['out1']);
  });

  it('hides a request whose other player has a block against the viewer (either way) or is inactive', async () => {
    const { service } = build({
      users: ids('a', 'b', 'c', 'd', 'e'),
      inactive: ids('e'),
      blocks: [
        { blockerId: 'b', blockedId: 'a' },
        { blockerId: 'a', blockedId: 'c' },
      ],
      requests: [
        { id: 'rb', requesterId: 'b', addresseeId: 'a' },
        { id: 'rc', requesterId: 'c', addresseeId: 'a' },
        { id: 'rd', requesterId: 'd', addresseeId: 'a' },
        { id: 're', requesterId: 'e', addresseeId: 'a' },
      ],
    });

    const page = await service.listRequests('a', 'incoming', { limit: 20 });

    expect(page.items.map((r) => r.id)).toEqual(['rd']);
  });

  it('asks for block relations in one batch, not per request', async () => {
    const { service, blocksService } = build({
      users: ids('a', 'b', 'c', 'd'),
      requests: [
        { requesterId: 'b', addresseeId: 'a' },
        { requesterId: 'c', addresseeId: 'a' },
        { requesterId: 'd', addresseeId: 'a' },
      ],
    });

    await service.listRequests('a', 'incoming', { limit: 20 });

    expect(blocksService.relationsBetween).toHaveBeenCalledTimes(1);
    expect(blocksService.relationBetween).not.toHaveBeenCalled();
  });

  it('pages with a cursor', async () => {
    const { service } = build({
      users: ids('a', 'b', 'c', 'd'),
      requests: [
        { id: 'r1', requesterId: 'b', addresseeId: 'a' },
        { id: 'r2', requesterId: 'c', addresseeId: 'a' },
        { id: 'r3', requesterId: 'd', addresseeId: 'a' },
      ],
    });

    const first = await service.listRequests('a', 'incoming', { limit: 2 });
    const second = await service.listRequests('a', 'incoming', {
      limit: 2,
      cursor: first.nextCursor!,
    });

    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((r) => r.id))).toEqual(
      new Set(['r1', 'r2', 'r3']),
    );
  });
});

describe('FriendsService.listFriends (presence)', () => {
  const friendsOfA = ['b', 'c', 'd'];
  const seed = () => ({
    users: ['a', ...friendsOfA, 'stranger'],
    friendships: friendsOfA.map((f) => ['a', f] as [string, string]),
  });

  it('shows presence from ONE batch call for exactly the friends, never one call per friend', async () => {
    const { service, presenceService } = build({
      ...seed(),
      presence: new Map([
        ['b', 'ONLINE'],
        ['c', 'IN_MATCH'],
      ]),
    });

    const page = await service.listFriends('a', { limit: 20 });

    expect(presenceService.getMany).toHaveBeenCalledTimes(1);
    const asked = presenceService.getMany.mock.calls[0][0];
    expect([...asked].sort()).toEqual(['b', 'c', 'd']);
    expect(presenceService.get).not.toHaveBeenCalled();

    const byId = Object.fromEntries(
      page.items.map((i) => [i.friend.id, i.presence]),
    );
    expect(byId).toEqual({ b: 'ONLINE', c: 'IN_MATCH', d: 'OFFLINE' });
  });

  it('never asks for the presence of anyone who is not a friend', async () => {
    const { service, presenceService } = build({
      ...seed(),
      presence: new Map([['stranger', 'ONLINE']]),
    });

    const page = await service.listFriends('a', { limit: 20 });

    expect(presenceService.getMany.mock.calls[0][0]).not.toContain('stranger');
    expect(page.items.map((i) => i.friend.id)).not.toContain('stranger');
  });

  it('reports everyone OFFLINE, with the friends still listed, when Redis fails', async () => {
    const { service, presenceService } = build({
      ...seed(),
      presence: new Error('Redis is down'),
    });

    const page = await service.listFriends('a', { limit: 20 });

    expect(presenceService.getMany).toHaveBeenCalledTimes(1);
    expect(page.items).toHaveLength(3);
    expect(page.items.every((i) => i.presence === 'OFFLINE')).toBe(true);
  });

  it('a stale friendship across a block is left out and its presence is never requested', async () => {
    const { service, presenceService } = build({
      ...seed(),
      blocks: [{ blockerId: 'c', blockedId: 'a' }],
      presence: new Map([['c', 'ONLINE']]),
    });

    const page = await service.listFriends('a', { limit: 20 });

    expect(page.items.map((i) => i.friend.id).sort()).toEqual(['b', 'd']);
    expect(presenceService.getMany.mock.calls[0][0]).not.toContain('c');
  });

  it('also hides it when the VIEWER is the blocker, and hides inactive friends', async () => {
    const { service, presenceService } = build({
      ...seed(),
      inactive: ['d'],
      blocks: [{ blockerId: 'a', blockedId: 'b' }],
    });

    const page = await service.listFriends('a', { limit: 20 });

    expect(page.items.map((i) => i.friend.id)).toEqual(['c']);
    expect(presenceService.getMany.mock.calls[0][0]).toEqual(['c']);
  });

  it('with no visible friends it does not call Redis at all', async () => {
    const { service, presenceService } = build({ users: ['a', 'b'] });

    expect((await service.listFriends('a', { limit: 20 })).items).toEqual([]);
    expect(presenceService.getMany).not.toHaveBeenCalled();
  });

  it('uses a constant number of queries however many friends there are', async () => {
    const many = Array.from(
      { length: 60 },
      (_, i) => `f${String(i).padStart(2, '0')}`,
    );
    const { service, db, blocksService, presenceService } = build({
      users: ['a', ...many],
      friendships: many.map((f) => ['a', f] as [string, string]),
    });

    const page = await service.listFriends('a', { limit: 100 });

    expect(page.items).toHaveLength(60);
    expect(db.friendship.findMany).toHaveBeenCalledTimes(1);
    expect(blocksService.relationsBetween).toHaveBeenCalledTimes(1);
    expect(presenceService.getMany).toHaveBeenCalledTimes(1);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns each friend as the OTHER player of the row, with only public fields', async () => {
    const { service } = build(seed());

    const page = await service.listFriends('a', { limit: 20 });
    const dto = page.items.map(toFriendResponse);

    for (const item of dto) {
      expect(Object.keys(item).sort()).toEqual([
        'displayName',
        'friendsSince',
        'presence',
        'userId',
        'username',
      ]);
      expect(item.userId).not.toBe('a');
    }
    expect(JSON.stringify(dto)).not.toContain('example.com');
  });

  it('works whichever side of the canonical pair the viewer is on, and pages', async () => {
    const { service } = build({
      users: ['a', 'b', 'c', 'z'],
      friendships: [
        ['z', 'a'],
        ['b', 'z'],
        ['z', 'c'],
      ],
    });

    const first = await service.listFriends('z', { limit: 2 });
    const second = await service.listFriends('z', {
      limit: 2,
      cursor: first.nextCursor!,
    });

    expect(
      new Set([...first.items, ...second.items].map((i) => i.friend.id)),
    ).toEqual(new Set(['a', 'b', 'c']));
    expect(second.nextCursor).toBeNull();
  });
});

describe('block visibility policy used by the lists', () => {
  it('is the same one summaries use', () => {
    expect(
      isHiddenFromSummaries({ blockedByViewer: true, blockedViewer: false }),
    ).toBe(true);
  });
});
