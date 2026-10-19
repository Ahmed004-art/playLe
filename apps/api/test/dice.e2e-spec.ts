import { randomUUID } from 'node:crypto';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { MatchTimeoutService } from '../src/matches/match-timeout.service.js';
import { DICE_RNG, type DiceRng } from '../src/games/dice/dice-rng.js';
import type { DiceState } from '../src/games/dice/dice.types.js';

/**
 * A scripted RNG bound in place of the production `CryptoDiceRng` through
 * the same `DICE_RNG` token (ADR-025). Every roll a test expects must be
 * queued first; running dry throws, so a test can never silently depend
 * on real randomness.
 */
class ScriptedRng implements DiceRng {
  private queue: number[] = [];

  push(...dice: number[]): void {
    this.queue.push(...dice);
  }

  clear(): void {
    this.queue = [];
  }

  get remaining(): number {
    return this.queue.length;
  }

  rollDie(): number {
    const value = this.queue.shift();
    if (value === undefined) throw new Error('ScriptedRng exhausted');
    return value;
  }
}

type TestUser = { accessToken: string; userId: string };

/**
 * Dice end-to-end, against the real generic platform (real Postgres, the
 * real command pipeline, the real stake/settlement services) — never a
 * Dice-specific harness. Mirrors the conventions in
 * `checkers.e2e-spec.ts`/`match-lifecycle.e2e-spec.ts`. The only
 * substitution is the RNG, via the production DI token; everything else,
 * including the turn-timeout sweep, runs for real.
 *
 * Dice ships disabled (ADR-025), so the suite enables the catalog row for
 * its own duration and restores it afterwards.
 */
describe('Dice (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let matchTimeoutService: MatchTimeoutService;
  let seededEnabled: boolean | undefined;
  const rng = new ScriptedRng();
  const runId = randomUUID().slice(0, 8);

  const email = (label: string) => `${label}-${runId}@example.com`;
  const username = (label: string) =>
    `${label.replace(/[^a-z0-9]/gi, '').slice(0, 6)}${randomUUID().replace(/-/g, '').slice(0, 10)}`.slice(
      0,
      20,
    );

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DICE_RNG)
      .useValue(rng)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = moduleFixture.get(PrismaService);
    matchTimeoutService = moduleFixture.get(MatchTimeoutService);

    seededEnabled = (await prisma.game.findUnique({ where: { id: 'dice' } }))
      ?.enabled;
    await prisma.game.update({
      where: { id: 'dice' },
      data: { enabled: true },
    });
  }, 30000);

  afterAll(async () => {
    await prisma.game.update({
      where: { id: 'dice' },
      data: { enabled: false },
    });

    const users = await prisma.user.findMany({
      where: { email: { contains: runId } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);

    const matchIds = (
      await prisma.matchPlayer.findMany({
        where: { userId: { in: userIds } },
        select: { matchId: true },
      })
    ).map((m) => m.matchId);

    const matchStakeIds = (
      await prisma.matchStake.findMany({
        where: { matchId: { in: matchIds } },
        select: { id: true },
      })
    ).map((s) => s.id);
    await prisma.settlement.deleteMany({
      where: { matchStakeId: { in: matchStakeIds } },
    });
    await prisma.matchStake.deleteMany({
      where: { id: { in: matchStakeIds } },
    });
    await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
    await prisma.challenge.deleteMany({
      where: {
        OR: [
          { challengerId: { in: userIds } },
          { opponentId: { in: userIds } },
        ],
      },
    });
    await prisma.refreshToken.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.ledgerEntry.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.withdrawal.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.deposit.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  beforeEach(() => {
    rng.clear();
  });

  async function registerUser(label: string): Promise<TestUser> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: email(label),
        username: username(label),
        password: 'Passw0rd1',
        dateOfBirth: '2000-01-01',
      })
      .expect(201);
    return { accessToken: res.body.accessToken, userId: res.body.user.id };
  }

  async function makeAdmin(userId: string): Promise<void> {
    await prisma.user.update({
      where: { id: userId },
      data: { role: 'ADMIN' },
    });
  }

  async function creditViaAdmin(
    adminToken: string,
    userId: string,
    amountMinor: string,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/wallets/${userId}/adjustments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        direction: 'CREDIT',
        amountMinor,
        reason: 'Test fixture credit for e2e setup',
      })
      .expect(200);
  }

  async function availableBalance(userId: string): Promise<bigint> {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    return wallet.availableBalanceMinor;
  }

  /** Creates an ACTIVE dice match (challenger = seat 0 = x). */
  async function createActiveMatch(
    labelPrefix: string,
  ): Promise<{ matchId: string; x: TestUser; o: TestUser }> {
    const x = await registerUser(`${labelPrefix}x`);
    const o = await registerUser(`${labelPrefix}o`);

    const challenge = await request(app.getHttpServer())
      .post('/api/v1/challenges')
      .set('Authorization', `Bearer ${x.accessToken}`)
      .send({ gameId: 'dice', opponentUserId: o.userId })
      .expect(201);

    const accepted = await request(app.getHttpServer())
      .post(`/api/v1/challenges/${challenge.body.id}/accept`)
      .set('Authorization', `Bearer ${o.accessToken}`)
      .expect(200);

    return { matchId: accepted.body.matchId as string, x, o };
  }

  async function createStakedMatch(
    labelPrefix: string,
    stakeAmountMinor: string,
  ): Promise<{ matchId: string; x: TestUser; o: TestUser }> {
    const x = await registerUser(`${labelPrefix}x`);
    const o = await registerUser(`${labelPrefix}o`);
    const admin = await registerUser(`${labelPrefix}a`);
    await makeAdmin(admin.userId);
    await creditViaAdmin(admin.accessToken, x.userId, '100000');
    await creditViaAdmin(admin.accessToken, o.userId, '100000');

    const challenge = await request(app.getHttpServer())
      .post('/api/v1/challenges')
      .set('Authorization', `Bearer ${x.accessToken}`)
      .send({
        gameId: 'dice',
        opponentUserId: o.userId,
        stake: { amountMinor: stakeAmountMinor, currency: 'SLE' },
      })
      .expect(201);

    const accepted = await request(app.getHttpServer())
      .post(`/api/v1/challenges/${challenge.body.id}/accept`)
      .set('Authorization', `Bearer ${o.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/matches/${accepted.body.matchId}/stake/confirm`)
      .set('Authorization', `Bearer ${x.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/matches/${accepted.body.matchId}/stake/confirm`)
      .set('Authorization', `Bearer ${o.accessToken}`)
      .expect(200);

    return { matchId: accepted.body.matchId as string, x, o };
  }

  function postCommand(
    accessToken: string,
    matchId: string,
    body: {
      commandId?: string;
      type?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    return request(app.getHttpServer())
      .post(`/api/v1/matches/${matchId}/commands`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        commandId: body.commandId ?? randomUUID(),
        type: body.type,
        payload: body.payload ?? {},
      });
  }

  /** Queues the scripted dice, then submits a legitimate roll command. */
  function roll(
    user: TestUser,
    matchId: string,
    dice: [number, number],
    commandId?: string,
  ) {
    rng.push(...dice);
    return postCommand(user.accessToken, matchId, {
      commandId,
      payload: { action: 'roll' },
    });
  }

  function getMatch(accessToken: string, matchId: string) {
    return request(app.getHttpServer())
      .get(`/api/v1/matches/${matchId}`)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  async function dbState(matchId: string): Promise<DiceState> {
    const match = await prisma.match.findUniqueOrThrow({
      where: { id: matchId },
    });
    return match.state as unknown as DiceState;
  }

  /** x wins round 1, o wins round 2, x wins round 3 -> x wins the match. */
  async function playXWinsInThree(matchId: string, x: TestUser, o: TestUser) {
    await roll(x, matchId, [6, 6]).expect(200);
    await roll(o, matchId, [1, 1]).expect(200); // x wins round 1
    await roll(o, matchId, [6, 6]).expect(200); // o starts round 2
    await roll(x, matchId, [1, 1]).expect(200); // o wins round 2
    await roll(x, matchId, [6, 6]).expect(200); // x starts round 3
    await roll(o, matchId, [1, 1]).expect(200); // x wins the match
  }

  describe('catalog availability', () => {
    it('ships disabled — seeded with enabled = false', () => {
      expect(seededEnabled).toBe(false);
    });

    it('is invisible and unplayable while disabled', async () => {
      await prisma.game.update({
        where: { id: 'dice' },
        data: { enabled: false },
      });
      try {
        const x = await registerUser('dcoffx');
        const o = await registerUser('dcoffo');

        const list = await request(app.getHttpServer())
          .get('/api/v1/games')
          .set('Authorization', `Bearer ${x.accessToken}`)
          .expect(200);
        expect(list.body.some((g: { id: string }) => g.id === 'dice')).toBe(
          false,
        );

        await request(app.getHttpServer())
          .get('/api/v1/games/dice')
          .set('Authorization', `Bearer ${x.accessToken}`)
          .expect(404);

        await request(app.getHttpServer())
          .post('/api/v1/challenges')
          .set('Authorization', `Bearer ${x.accessToken}`)
          .send({ gameId: 'dice', opponentUserId: o.userId })
          .expect(404);
      } finally {
        await prisma.game.update({
          where: { id: 'dice' },
          data: { enabled: true },
        });
      }
    });

    it('lists and returns Dice once it is enabled, with the 30s turn clock', async () => {
      const { accessToken } = await registerUser('dccatalog');
      const list = await request(app.getHttpServer())
        .get('/api/v1/games')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(list.body.some((g: { id: string }) => g.id === 'dice')).toBe(true);

      const one = await request(app.getHttpServer())
        .get('/api/v1/games/dice')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(one.body.displayName).toBe('Dice');
      expect(one.body.minPlayers).toBe(2);
      expect(one.body.maxPlayers).toBe(2);

      const row = await prisma.game.findUniqueOrThrow({
        where: { id: 'dice' },
      });
      expect(row.turnTimeoutSeconds).toBe(30);
    });
  });

  describe('match creation', () => {
    it('starts ACTIVE with the challenger to roll, a 30s clock, and the Dice capabilities', async () => {
      const { matchId, x } = await createActiveMatch('dcopen');
      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('ACTIVE');
      expect(match.body.gameId).toBe('dice');
      expect(match.body.state.currentTurn).toBe(x.userId);
      expect(match.body.state.round).toBe(1);
      expect(match.body.state.attempts).toEqual([]);
      expect(match.body.state.pendingRoll).toBeNull();
      expect(match.body.supportsResignation).toBe(true);
      expect(match.body.supportsDraws).toBe(false);

      const msLeft =
        new Date(match.body.turnDeadlineAt as string).getTime() - Date.now();
      expect(msLeft).toBeGreaterThan(20_000);
      expect(msLeft).toBeLessThanOrEqual(30_000);
    });
  });

  describe('server-authoritative rolling', () => {
    it('plays a free match to a result, recording the full roll history', async () => {
      const { matchId, x, o } = await createActiveMatch('dcfull');

      const first = await roll(x, matchId, [3, 4]).expect(200);
      expect(first.body.resultStatus).toBe('ACCEPTED');
      let match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.state.pendingRoll).toEqual({
        userId: x.userId,
        dice: [3, 4],
        total: 7,
      });
      expect(match.body.state.currentTurn).toBe(o.userId);

      await roll(o, matchId, [6, 5]).expect(200); // o wins round 1
      match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.state.roundWins).toEqual([0, 1]);
      expect(match.body.state.round).toBe(2);
      expect(match.body.state.currentTurn).toBe(o.userId); // starter alternates

      await roll(o, matchId, [6, 6]).expect(200);
      const last = await roll(x, matchId, [1, 1]).expect(200); // o wins round 2
      expect(last.body.resultStatus).toBe('ACCEPTED');

      match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('COMPLETED');
      expect(match.body.winnerUserId).toBe(o.userId);
      expect(match.body.resultIsDraw).toBe(false);
      expect(match.body.terminationReason).toBeNull();
      expect(match.body.stateVersion).toBe(4);
      expect(match.body.turnDeadlineAt).toBeNull();
      expect(match.body.state.roundWins).toEqual([0, 2]);
      expect(match.body.state.attempts).toHaveLength(2);
      expect(match.body.state.attempts[0]).toEqual({
        round: 1,
        rolls: [
          { userId: x.userId, dice: [3, 4], total: 7 },
          { userId: o.userId, dice: [6, 5], total: 11 },
        ],
        winnerUserId: o.userId,
      });
    });

    it('rejects a roll out of turn without consuming randomness', async () => {
      const { matchId, o, x } = await createActiveMatch('dcturn');
      rng.push(6, 6);
      const res = await postCommand(o.accessToken, matchId, {
        payload: { action: 'roll' },
      }).expect(200);
      expect(res.body.resultStatus).toBe('REJECTED');
      expect(res.body.rejectionReason).toBe('It is not your turn');
      expect(rng.remaining).toBe(2);

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.stateVersion).toBe(0);
      expect(match.body.state.pendingRoll).toBeNull();
    });

    it.each([
      ['an empty payload', {}],
      ['a wrong action', { action: 'reroll' }],
      ['client-supplied dice', { action: 'roll', dice: [6, 6] }],
      ['a client-supplied total', { action: 'roll', total: 12 }],
      ['a client-claimed winner', { action: 'roll', winnerUserId: 'me' }],
    ])(
      'rejects %s and leaves state untouched',
      async (_label, payload: Record<string, unknown>) => {
        const { matchId, x } = await createActiveMatch('dcbad');
        rng.push(6, 6);
        const res = await postCommand(x.accessToken, matchId, {
          payload,
        }).expect(200);
        expect(res.body.resultStatus).toBe('REJECTED');
        expect(rng.remaining).toBe(2);

        const state = await dbState(matchId);
        expect(state.pendingRoll).toBeNull();
        expect(state.attempts).toEqual([]);
        expect(state.currentTurn).toBe(x.userId);
      },
    );

    it('rejects a non-participant with 404 and no state change', async () => {
      const { matchId } = await createActiveMatch('dcoutsider');
      const outsider = await registerUser('dcoutsiderz');
      rng.push(6, 6);
      await postCommand(outsider.accessToken, matchId, {
        payload: { action: 'roll' },
      }).expect(404);
      expect(rng.remaining).toBe(2);
      expect((await dbState(matchId)).pendingRoll).toBeNull();
    });

    it('rejects a roll once the match has ended', async () => {
      const { matchId, x, o } = await createActiveMatch('dcended');
      await roll(x, matchId, [6, 6]).expect(200);
      await roll(o, matchId, [1, 1]).expect(200);
      await roll(o, matchId, [1, 1]).expect(200);
      await roll(x, matchId, [6, 6]).expect(200); // x wins 2-0

      const late = await roll(x, matchId, [6, 6]).expect(200);
      expect(late.body.resultStatus).toBe('REJECTED');
      expect(late.body.rejectionReason).toBe('This match has already ended');
    });
  });

  describe('ties', () => {
    it('replays a tied round without scoring it, then continues', async () => {
      const { matchId, x, o } = await createActiveMatch('dctie');
      await roll(x, matchId, [3, 4]).expect(200);
      await roll(o, matchId, [2, 5]).expect(200); // 7 vs 7 — tie

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('ACTIVE');
      expect(match.body.state.roundWins).toEqual([0, 0]);
      expect(match.body.state.round).toBe(1);
      expect(match.body.state.consecutiveTies).toBe(1);
      expect(match.body.state.currentTurn).toBe(x.userId); // same starter
      expect(match.body.state.attempts[0].winnerUserId).toBeNull();
    });
  });

  describe('resignation and draw offers', () => {
    it('lets a player resign: the opponent wins with RESIGNATION', async () => {
      const { matchId, x, o } = await createActiveMatch('dcresign');
      const res = await postCommand(x.accessToken, matchId, {
        type: 'RESIGN',
      }).expect(200);
      expect(res.body.resultStatus).toBe('ACCEPTED');

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('COMPLETED');
      expect(match.body.winnerUserId).toBe(o.userId);
      expect(match.body.terminationReason).toBe('RESIGNATION');

      const late = await roll(o, matchId, [6, 6]).expect(200);
      expect(late.body.resultStatus).toBe('REJECTED');
    });

    it.each(['DRAW_OFFER', 'DRAW_ACCEPT', 'DRAW_REJECT'])(
      'rejects %s because Dice does not support agreed draws',
      async (type) => {
        const { matchId, x } = await createActiveMatch('dcdraw');
        const res = await postCommand(x.accessToken, matchId, {
          type,
        }).expect(200);
        expect(res.body.resultStatus).toBe('REJECTED');
        expect(res.body.rejectionReason).toBe(
          'This game does not support draw offers',
        );

        const match = await getMatch(x.accessToken, matchId).expect(200);
        expect(match.body.status).toBe('ACTIVE');
        expect(match.body.pendingDrawOfferByUserId).toBeNull();
      },
    );
  });

  describe('idempotency', () => {
    it('returns the stored command for a replayed commandId and never re-rolls', async () => {
      const { matchId, x } = await createActiveMatch('dcreplay');
      const commandId = randomUUID();

      const first = await roll(x, matchId, [3, 4], commandId).expect(200);
      expect(first.body.resultStatus).toBe('ACCEPTED');
      const afterFirst = await dbState(matchId);

      // Spare dice a buggy re-roll would consume.
      rng.push(6, 6);
      const replay = await postCommand(x.accessToken, matchId, {
        commandId,
        payload: { action: 'roll' },
      }).expect(200);
      expect(replay.body).toEqual(first.body);
      expect(rng.remaining).toBe(2);
      expect(await dbState(matchId)).toEqual(afterFirst);

      expect(
        await prisma.matchCommand.count({
          where: { matchId, id: commandId },
        }),
      ).toBe(1);
      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.stateVersion).toBe(1);
    });

    it('never double-rolls for concurrent duplicates of the same command', async () => {
      // The dangerous shape: after round 1 resolves, the player who
      // *responded* is also the next round's starter, so a duplicate of
      // that responding command is a *legal* roll a second time. If it
      // were ever applied, the transaction's command-row insert would hit
      // the (matchId, commandId) key and roll the whole thing back.
      for (let attempt = 0; attempt < 5; attempt++) {
        rng.clear(); // spare dice from a previous iteration must not leak
        const { matchId, x, o } = await createActiveMatch(`dcconc${attempt}`);
        await roll(x, matchId, [6, 6]).expect(200);

        const commandId = randomUUID();
        rng.push(1, 1); // the real roll
        // Spare dice for up to two phantom duplicate rolls (one per
        // duplicate request that could win the lock after the first).
        rng.push(5, 5, 5, 5);
        const body = {
          commandId,
          payload: { action: 'roll' },
        };
        const [a, b, c] = await Promise.all([
          postCommand(o.accessToken, matchId, body),
          postCommand(o.accessToken, matchId, body),
          postCommand(o.accessToken, matchId, body),
        ]);

        for (const res of [a, b, c]) {
          expect(res.status).toBe(200);
          expect(res.body.commandId).toBe(commandId);
          expect(res.body.resultStatus).toBe('ACCEPTED');
          expect(res.body.stateVersionAfter).toBe(2);
        }

        const state = await dbState(matchId);
        expect(state.attempts).toHaveLength(1);
        expect(state.attempts[0].rolls[1].dice).toEqual([1, 1]);
        expect(state.pendingRoll).toBeNull(); // no phantom roll persisted
        expect(state.round).toBe(2);
        expect(state.currentTurn).toBe(o.userId);
        expect(
          await prisma.matchCommand.count({
            where: { matchId, id: commandId },
          }),
        ).toBe(1);
        const match = await prisma.match.findUniqueOrThrow({
          where: { id: matchId },
        });
        expect(match.stateVersion).toBe(2);
      }
    });
  });

  describe('turn timeout', () => {
    async function expireTurn(matchId: string): Promise<void> {
      await prisma.match.update({
        where: { id: matchId },
        data: { turnDeadlineAt: new Date(Date.now() - 1000) },
      });
    }

    it('forfeits the player who failed to roll, idempotently', async () => {
      const { matchId, x, o } = await createActiveMatch('dctimeout');
      await expireTurn(matchId);

      await matchTimeoutService.processTurnTimeout(matchId);
      await matchTimeoutService.processTurnTimeout(matchId); // no-op

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('COMPLETED');
      expect(match.body.winnerUserId).toBe(o.userId);
      expect(match.body.terminationReason).toBe('TURN_TIMEOUT');

      const late = await roll(x, matchId, [6, 6]).expect(200);
      expect(late.body.resultStatus).toBe('REJECTED');
    });

    it('forfeits the responder when the starter already rolled', async () => {
      const { matchId, x, o } = await createActiveMatch('dctimeoutresp');
      await roll(x, matchId, [3, 4]).expect(200);
      await expireTurn(matchId);

      await matchTimeoutService.processTurnTimeout(matchId);

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.winnerUserId).toBe(x.userId);
      expect(match.body.terminationReason).toBe('TURN_TIMEOUT');
      expect(o.userId).not.toBe(match.body.winnerUserId);
    });

    it('serializes a roll racing the timeout sweep into exactly one outcome', async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        rng.clear(); // an unused roll from a previous iteration must not leak
        const { matchId, x, o } = await createActiveMatch(`dcrace${attempt}`);
        await expireTurn(matchId);
        rng.push(3, 3);

        const [rollRes] = await Promise.all([
          postCommand(x.accessToken, matchId, {
            payload: { action: 'roll' },
          }),
          matchTimeoutService.processTurnTimeout(matchId),
        ]);
        expect(rollRes.status).toBe(200);

        const match = await prisma.match.findUniqueOrThrow({
          where: { id: matchId },
        });
        const state = match.state as unknown as DiceState;

        if (match.terminationReason === 'TURN_TIMEOUT') {
          // The sweep won the lock: the roll must have been rejected and
          // left no trace in the state.
          expect(rollRes.body.resultStatus).toBe('REJECTED');
          expect(match.status).toBe('COMPLETED');
          expect(match.winnerUserId).toBe(o.userId);
          expect(state.pendingRoll).toBeNull();
        } else {
          // The roll won the lock: it refreshed the clock, so the sweep
          // was a no-op.
          expect(rollRes.body.resultStatus).toBe('ACCEPTED');
          expect(match.status).toBe('ACTIVE');
          expect(state.pendingRoll).toMatchObject({ userId: x.userId });
          expect(match.stateVersion).toBe(1);
        }
      }
    });
  });

  describe('staked matches (existing stake, ledger and settlement architecture)', () => {
    it('settles a win through the unchanged 10% fee math', async () => {
      const { matchId, x, o } = await createStakedMatch('dcwin', '1000');
      expect(await availableBalance(x.userId)).toBe(99000n);
      expect(await availableBalance(o.userId)).toBe(99000n);

      await playXWinsInThree(matchId, x, o);

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('COMPLETED');
      expect(match.body.winnerUserId).toBe(x.userId);
      expect(match.body.state.roundWins).toEqual([2, 1]);

      // Pool 2000, fee floor(2000 * 10 / 100) = 200, winner gets 1800.
      expect(await availableBalance(x.userId)).toBe(99000n + 1800n);
      expect(await availableBalance(o.userId)).toBe(99000n);

      const stake = await prisma.matchStake.findUniqueOrThrow({
        where: { matchId },
        include: { settlement: true },
      });
      expect(stake.status).toBe('SETTLED');
      expect(stake.settlement?.outcome).toBe('WIN');
      expect(stake.settlement?.poolAmountMinor).toBe(2000n);
      expect(stake.settlement?.platformFeeAmountMinor).toBe(200n);
    });

    it('refunds both stakes with no fee when three consecutive ties draw the match', async () => {
      const { matchId, x, o } = await createStakedMatch('dcdrawstake', '1000');

      await roll(x, matchId, [3, 3]).expect(200);
      await roll(o, matchId, [3, 3]).expect(200);
      await roll(x, matchId, [4, 4]).expect(200);
      await roll(o, matchId, [4, 4]).expect(200);
      await roll(x, matchId, [5, 5]).expect(200);
      await roll(o, matchId, [5, 5]).expect(200);

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('COMPLETED');
      expect(match.body.resultIsDraw).toBe(true);
      expect(match.body.winnerUserId).toBeNull();
      expect(match.body.terminationReason).toBeNull();
      expect(match.body.state.consecutiveTies).toBe(3);

      expect(await availableBalance(x.userId)).toBe(100000n);
      expect(await availableBalance(o.userId)).toBe(100000n);

      const stake = await prisma.matchStake.findUniqueOrThrow({
        where: { matchId },
        include: { settlement: true },
      });
      expect(stake.status).toBe('SETTLED');
      expect(stake.settlement?.outcome).toBe('DRAW');
      expect(stake.settlement?.platformFeeAmountMinor).toBe(0n);
    });

    it('settles a resignation as a win for the opponent', async () => {
      const { matchId, x, o } = await createStakedMatch('dcresstake', '1000');
      await postCommand(x.accessToken, matchId, { type: 'RESIGN' }).expect(200);

      expect(await availableBalance(o.userId)).toBe(99000n + 1800n);
      expect(await availableBalance(x.userId)).toBe(99000n);
      const stake = await prisma.matchStake.findUniqueOrThrow({
        where: { matchId },
        include: { settlement: true },
      });
      expect(stake.settlement?.outcome).toBe('WIN');
    });

    it('settles a turn timeout as a win for the opponent exactly once', async () => {
      const { matchId, x, o } = await createStakedMatch('dctostake', '1000');
      await prisma.match.update({
        where: { id: matchId },
        data: { turnDeadlineAt: new Date(Date.now() - 1000) },
      });

      await matchTimeoutService.processTurnTimeout(matchId);
      await matchTimeoutService.processTurnTimeout(matchId);

      expect(await availableBalance(o.userId)).toBe(99000n + 1800n);
      expect(await availableBalance(x.userId)).toBe(99000n);
      expect(
        await prisma.settlement.count({
          where: { matchStake: { matchId } },
        }),
      ).toBe(1);
    });
  });

  describe('eligibility restrictions (existing responsible-gaming controls)', () => {
    async function selfExclude(accessToken: string) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/responsible-gaming/self-exclude')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    }

    it('blocks a self-excluded challenger from staking on Dice', async () => {
      const challenger = await registerUser('dcselfexc');
      const opponent = await registerUser('dcselfexo');
      await selfExclude(challenger.accessToken);

      const res = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${challenger.accessToken}`)
        .send({
          gameId: 'dice',
          opponentUserId: opponent.userId,
          stake: { amountMinor: '100', currency: 'SLE' },
        });
      expect(res.status).toBe(403);
    });

    it('blocks a self-excluded opponent from accepting a staked Dice challenge', async () => {
      const challenger = await registerUser('dcselfacc');
      const opponent = await registerUser('dcselfaccopp');
      const admin = await registerUser('dcselfacca');
      await makeAdmin(admin.userId);
      await creditViaAdmin(admin.accessToken, challenger.userId, '100000');

      const challenge = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${challenger.accessToken}`)
        .send({
          gameId: 'dice',
          opponentUserId: opponent.userId,
          stake: { amountMinor: '100', currency: 'SLE' },
        })
        .expect(201);
      await selfExclude(opponent.accessToken);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/accept`)
        .set('Authorization', `Bearer ${opponent.accessToken}`);
      expect(res.status).toBe(403);

      const stillPending = await prisma.challenge.findUnique({
        where: { id: challenge.body.id as string },
      });
      expect(stillPending?.status).toBe('PENDING');
      expect(stillPending?.matchId).toBeNull();
    });
  });
});
