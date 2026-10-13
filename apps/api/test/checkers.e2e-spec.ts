import { randomUUID } from 'node:crypto';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { MatchTimeoutService } from '../src/matches/match-timeout.service.js';
import type {
  CheckersPiece,
  CheckersState,
} from '../src/games/checkers/checkers.types.js';

/**
 * Checkers end-to-end, against the real generic platform (real Postgres,
 * the real command pipeline, the real stake/settlement services) — never
 * a second, Checkers-specific test harness. Mirrors the conventions in
 * `matches.e2e-spec.ts`/`match-stakes.e2e-spec.ts` exactly.
 *
 * Several tests inject a custom `Match.state` directly via Prisma before
 * submitting the one real move being tested — the same technique
 * `match-stakes.e2e-spec.ts` already uses to backdate `expiresAt`/
 * `disconnectedAt` for its sweep tests. `Match.state` is explicitly
 * opaque-to-the-platform (ADR-015), so this is a legitimate fixture
 * shortcut for reaching a specific board position without playing out
 * dozens of real diagonal moves from the standard opening — the move
 * actually being asserted on always goes through the real REST command
 * pipeline (`MatchesService.submitCommand` → `CheckersModule`), never a
 * fabricated result.
 */
describe('Checkers (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let matchTimeoutService: MatchTimeoutService;
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
    }).compile();

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
  }, 30000);

  afterAll(async () => {
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

  async function registerUser(
    label: string,
  ): Promise<{ accessToken: string; userId: string }> {
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

  /** Creates an ACTIVE checkers match (challenger = seat 0 = x). */
  async function createActiveMatch(labelPrefix: string): Promise<{
    matchId: string;
    x: { accessToken: string; userId: string };
    o: { accessToken: string; userId: string };
  }> {
    const x = await registerUser(`${labelPrefix}x`);
    const o = await registerUser(`${labelPrefix}o`);

    const challenge = await request(app.getHttpServer())
      .post('/api/v1/challenges')
      .set('Authorization', `Bearer ${x.accessToken}`)
      .send({ gameId: 'checkers', opponentUserId: o.userId })
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
  ): Promise<{
    matchId: string;
    x: { accessToken: string; userId: string };
    o: { accessToken: string; userId: string };
  }> {
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
        gameId: 'checkers',
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

  function move(
    accessToken: string,
    matchId: string,
    from: { row: number; col: number },
    to: { row: number; col: number },
    commandId = randomUUID(),
  ) {
    return request(app.getHttpServer())
      .post(`/api/v1/matches/${matchId}/commands`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ commandId, payload: { from, to } });
  }

  function getMatch(accessToken: string, matchId: string) {
    return request(app.getHttpServer())
      .get(`/api/v1/matches/${matchId}`)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  function emptyBoard(): (CheckersPiece | null)[][] {
    return Array.from({ length: 8 }, () =>
      new Array<CheckersPiece | null>(8).fill(null),
    );
  }

  /** Overwrites a match's opaque state directly — see the file doc comment. */
  async function setState(
    matchId: string,
    state: CheckersState,
  ): Promise<void> {
    await prisma.match.update({
      where: { id: matchId },
      data: { state: state as unknown as Prisma.InputJsonValue },
    });
  }

  describe('game catalog', () => {
    it('lists checkers alongside tic_tac_toe', async () => {
      const { accessToken } = await registerUser('ckcatalog');
      const res = await request(app.getHttpServer())
        .get('/api/v1/games')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(res.body.some((g: { id: string }) => g.id === 'checkers')).toBe(
        true,
      );
    });

    it('returns Checkers by id', async () => {
      const { accessToken } = await registerUser('ckcatalogone');
      const res = await request(app.getHttpServer())
        .get('/api/v1/games/checkers')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(res.body.displayName).toBe('Checkers');
      expect(res.body.minPlayers).toBe(2);
      expect(res.body.maxPlayers).toBe(2);
    });
  });

  describe('match creation and the standard opening', () => {
    it('starts with 24 pieces, 12 per side, and the challenger to move first', async () => {
      const { matchId, x } = await createActiveMatch('ckopen');
      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('ACTIVE');
      const flat = (match.body.state.board as unknown[][]).flat();
      expect(flat.filter((c) => c !== null)).toHaveLength(24);
      expect(match.body.state.currentTurn).toBe(x.userId);
    });

    it('accepts a legal opening move and pushes the next state', async () => {
      const { matchId, x } = await createActiveMatch('ckfirstmove');
      const res = await move(
        x.accessToken,
        matchId,
        { row: 2, col: 1 },
        { row: 3, col: 0 },
      ).expect(200);
      expect(res.body.resultStatus).toBe('ACCEPTED');

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.state.board[2][1]).toBeNull();
      expect(match.body.state.board[3][0]).toMatchObject({ owner: x.userId });
      expect(match.body.stateVersion).toBe(1);
    });
  });

  describe('server-authoritative rule enforcement', () => {
    it('rejects a move out of turn', async () => {
      const { matchId, o } = await createActiveMatch('ckoutofturn');
      const res = await move(
        o.accessToken,
        matchId,
        { row: 5, col: 0 },
        { row: 4, col: 1 },
      ).expect(200);
      expect(res.body.resultStatus).toBe('REJECTED');
      expect(res.body.rejectionReason).toMatch(/not your turn/i);
    });

    it('rejects a non-diagonal move', async () => {
      const { matchId, x } = await createActiveMatch('ckbadshape');
      const res = await move(
        x.accessToken,
        matchId,
        { row: 2, col: 1 },
        { row: 2, col: 3 },
      ).expect(200);
      expect(res.body.resultStatus).toBe('REJECTED');
    });

    it('rejects a malformed command payload', async () => {
      const { matchId, x } = await createActiveMatch('ckmalformed');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/matches/${matchId}/commands`)
        .set('Authorization', `Bearer ${x.accessToken}`)
        .send({ commandId: randomUUID(), payload: { foo: 'bar' } })
        .expect(200);
      expect(res.body.resultStatus).toBe('REJECTED');
      expect(res.body.rejectionReason).toMatch(/not valid/i);
    });

    it('404s a command from a non-participant', async () => {
      const { matchId } = await createActiveMatch('cknonparticipant');
      const outsider = await registerUser('cknonparticipantoutsider');
      await move(
        outsider.accessToken,
        matchId,
        { row: 2, col: 1 },
        { row: 3, col: 0 },
      ).expect(404);
    });

    it('enforces mandatory capture: a simple move elsewhere is rejected while a capture is available', async () => {
      const { matchId, x } = await createActiveMatch('ckmandatory');
      const board = emptyBoard();
      board[2][1] = { owner: x.userId, king: false };
      board[3][2] = {
        owner: await getOpponentId(matchId, x.userId),
        king: false,
      };
      board[2][5] = { owner: x.userId, king: false };
      await setState(matchId, {
        board,
        playerOrder: await playerOrderOf(matchId),
        currentTurn: x.userId,
        mustContinueFrom: null,
        movesSinceProgress: 0,
        winnerUserId: null,
        isDraw: false,
      });

      const simpleElsewhere = await move(
        x.accessToken,
        matchId,
        { row: 2, col: 5 },
        { row: 3, col: 4 },
      ).expect(200);
      expect(simpleElsewhere.body.resultStatus).toBe('REJECTED');
      expect(simpleElsewhere.body.rejectionReason).toMatch(
        /capture is available/i,
      );

      const capture = await move(
        x.accessToken,
        matchId,
        { row: 2, col: 1 },
        { row: 4, col: 3 },
      ).expect(200);
      expect(capture.body.resultStatus).toBe('ACCEPTED');
    });

    it('forces a multi-jump continuation with the same piece before the turn passes', async () => {
      const { matchId, x, o } = await createActiveMatch('ckmultijump');
      const board = emptyBoard();
      board[2][1] = { owner: x.userId, king: false };
      board[3][2] = { owner: o.userId, king: false };
      board[5][4] = { owner: o.userId, king: false };
      await setState(matchId, {
        board,
        playerOrder: [x.userId, o.userId],
        currentTurn: x.userId,
        mustContinueFrom: null,
        movesSinceProgress: 0,
        winnerUserId: null,
        isDraw: false,
      });

      const firstJump = await move(
        x.accessToken,
        matchId,
        { row: 2, col: 1 },
        { row: 4, col: 3 },
      ).expect(200);
      expect(firstJump.body.resultStatus).toBe('ACCEPTED');

      const midMatch = await getMatch(x.accessToken, matchId).expect(200);
      expect(midMatch.body.status).toBe('ACTIVE');
      expect(midMatch.body.state.mustContinueFrom).toEqual({ row: 4, col: 3 });
      expect(midMatch.body.state.currentTurn).toBe(x.userId);

      // The opponent must not be able to move while it's still x's
      // forced continuation.
      const opponentAttempt = await move(
        o.accessToken,
        matchId,
        { row: 5, col: 0 },
        { row: 4, col: 1 },
      ).expect(200);
      expect(opponentAttempt.body.resultStatus).toBe('REJECTED');
      expect(opponentAttempt.body.rejectionReason).toMatch(/not your turn/i);

      const secondJump = await move(
        x.accessToken,
        matchId,
        { row: 4, col: 3 },
        { row: 6, col: 5 },
      ).expect(200);
      expect(secondJump.body.resultStatus).toBe('ACCEPTED');

      const finalMatch = await getMatch(x.accessToken, matchId).expect(200);
      expect(finalMatch.body.state.mustContinueFrom).toBeNull();
      expect(finalMatch.body.state.currentTurn).toBe(o.userId);
    });

    it('a forced multi-jump refreshes the turn clock on each jump, rather than expiring mid-chain (Phase 9 — ADR-024)', async () => {
      const { matchId, x, o } = await createActiveMatch('ckmultijumptimer');
      const board = emptyBoard();
      board[2][1] = { owner: x.userId, king: false };
      board[3][2] = { owner: o.userId, king: false };
      board[5][4] = { owner: o.userId, king: false };
      // A third, uninvolved o piece — otherwise capturing both of the
      // pieces above would immediately win the game by no-remaining-
      // pieces, leaving nothing left to test o's own post-chain timeout.
      board[7][6] = { owner: o.userId, king: false };
      await setState(matchId, {
        board,
        playerOrder: [x.userId, o.userId],
        currentTurn: x.userId,
        mustContinueFrom: null,
        movesSinceProgress: 0,
        winnerUserId: null,
        isDraw: false,
      });

      // Simulate the clock having already run out *before* x's first
      // jump of the chain — a move is still honored if it commits before
      // the sweep catches up (the sweep, not the move itself, is the
      // sole arbiter of expiry).
      await prisma.match.update({
        where: { id: matchId },
        data: { turnDeadlineAt: new Date(Date.now() - 1000) },
      });

      const firstJump = await move(
        x.accessToken,
        matchId,
        { row: 2, col: 1 },
        { row: 4, col: 3 },
      ).expect(200);
      expect(firstJump.body.resultStatus).toBe('ACCEPTED');

      // The accepted jump refreshed the deadline — it's no longer stale,
      // even though x (not the opponent) still holds the turn mid-chain.
      const midMatch = await getMatch(x.accessToken, matchId).expect(200);
      expect(new Date(midMatch.body.turnDeadlineAt).getTime()).toBeGreaterThan(
        Date.now(),
      );

      // So the sweep correctly finds nothing to expire mid-continuation.
      await matchTimeoutService.processTurnTimeout(matchId);
      const stillActive = await getMatch(x.accessToken, matchId).expect(200);
      expect(stillActive.body.status).toBe('ACTIVE');
      expect(stillActive.body.state.mustContinueFrom).toEqual({
        row: 4,
        col: 3,
      });

      const secondJump = await move(
        x.accessToken,
        matchId,
        { row: 4, col: 3 },
        { row: 6, col: 5 },
      ).expect(200);
      expect(secondJump.body.resultStatus).toBe('ACCEPTED');

      // The chain ended and the turn passed to o — their own deadline is
      // still a real, bounded window, not an indefinite grace period
      // just because a multi-jump happened before them.
      await prisma.match.update({
        where: { id: matchId },
        data: { turnDeadlineAt: new Date(Date.now() - 1000) },
      });
      await matchTimeoutService.processTurnTimeout(matchId);

      const final = await getMatch(x.accessToken, matchId).expect(200);
      expect(final.body.status).toBe('COMPLETED');
      expect(final.body.winnerUserId).toBe(x.userId);
      expect(final.body.terminationReason).toBe('TURN_TIMEOUT');
    });

    it('promotes a man that reaches the far row', async () => {
      const { matchId, x } = await createActiveMatch('ckpromote');
      const board = emptyBoard();
      board[6][1] = { owner: x.userId, king: false };
      await setState(matchId, {
        board,
        playerOrder: await playerOrderOf(matchId),
        currentTurn: x.userId,
        mustContinueFrom: null,
        movesSinceProgress: 0,
        winnerUserId: null,
        isDraw: false,
      });

      await move(
        x.accessToken,
        matchId,
        { row: 6, col: 1 },
        { row: 7, col: 0 },
      ).expect(200);

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.state.board[7][0]).toMatchObject({ king: true });
    });

    it('rejects any further move once the match has completed', async () => {
      const { matchId, x, o } = await createActiveMatch('ckpostcompletion');
      const board = emptyBoard();
      board[0][1] = { owner: x.userId, king: false };
      await setState(matchId, {
        board,
        playerOrder: [x.userId, o.userId],
        currentTurn: x.userId,
        mustContinueFrom: null,
        movesSinceProgress: 0,
        winnerUserId: null,
        isDraw: false,
      });
      // x has the only piece left — this move wins immediately.
      await move(
        x.accessToken,
        matchId,
        { row: 0, col: 1 },
        { row: 1, col: 0 },
      ).expect(200);

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('COMPLETED');
      expect(match.body.winnerUserId).toBe(x.userId);

      const after = await move(
        o.accessToken,
        matchId,
        { row: 1, col: 0 },
        { row: 2, col: 1 },
      ).expect(200);
      expect(after.body.resultStatus).toBe('REJECTED');
      expect(after.body.rejectionReason).toMatch(/already ended/i);
    });

    it('is idempotent against a retried identical command', async () => {
      const { matchId, x } = await createActiveMatch('ckidempotent');
      const commandId = randomUUID();
      const first = await move(
        x.accessToken,
        matchId,
        { row: 2, col: 1 },
        { row: 3, col: 0 },
        commandId,
      ).expect(200);
      const retry = await move(
        x.accessToken,
        matchId,
        { row: 2, col: 1 },
        { row: 3, col: 0 },
        commandId,
      ).expect(200);
      expect(retry.body).toEqual(first.body);

      const match = await prisma.match.findUnique({ where: { id: matchId } });
      expect(match?.stateVersion).toBe(1);
    });

    it('serializes two concurrent moves from the same player — exactly one is accepted', async () => {
      const { matchId, x } = await createActiveMatch('ckconcurrent');
      const [first, second] = await Promise.all([
        move(x.accessToken, matchId, { row: 2, col: 1 }, { row: 3, col: 0 }),
        move(x.accessToken, matchId, { row: 2, col: 3 }, { row: 3, col: 2 }),
      ]);
      const results = [
        first.body.resultStatus,
        second.body.resultStatus,
      ].sort();
      expect(results).toEqual(['ACCEPTED', 'REJECTED']);

      const match = await prisma.match.findUnique({ where: { id: matchId } });
      expect(match?.stateVersion).toBe(1);
    });
  });

  describe('win and draw reach the generic settlement pipeline unmodified', () => {
    it('a capture-all win on a staked match settles the prize pool through the existing LedgerService/SettlementService', async () => {
      const { matchId, x, o } = await createStakedMatch('ckstakewin', '1000');
      const beforeX = await availableBalance(x.userId);

      const board = emptyBoard();
      board[0][1] = { owner: x.userId, king: false };
      await setState(matchId, {
        board,
        playerOrder: [x.userId, o.userId],
        currentTurn: x.userId,
        mustContinueFrom: null,
        movesSinceProgress: 0,
        winnerUserId: null,
        isDraw: false,
      });

      await move(
        x.accessToken,
        matchId,
        { row: 0, col: 1 },
        { row: 1, col: 0 },
      ).expect(200);

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('COMPLETED');
      expect(match.body.winnerUserId).toBe(x.userId);

      // Pool 2000, fee 10% = 200, winner receives 1800 — the exact same
      // SettlementService math Tic-Tac-Toe already exercises; nothing
      // about Checkers changes the financial rule.
      const afterX = await availableBalance(x.userId);
      expect(afterX - beforeX).toBe(1800n);

      const settlement = await prisma.settlement.findFirst({
        where: { matchStake: { matchId } },
      });
      expect(settlement?.outcome).toBe('WIN');
    });

    it('declares a draw after 40 half-moves with no progress, refunding a staked match', async () => {
      // Captured before `createStakedMatch` holds each player's stake —
      // the draw must release that hold back to exactly this amount,
      // not merely leave the (already-held-down) balance unchanged.
      const fundedAmount = 100000n;
      const { matchId, x, o } = await createStakedMatch('ckstakedraw', '1000');
      expect(await availableBalance(x.userId)).toBe(fundedAmount - 1000n);
      expect(await availableBalance(o.userId)).toBe(fundedAmount - 1000n);

      const board = emptyBoard();
      board[4][3] = { owner: x.userId, king: true };
      board[4][5] = { owner: o.userId, king: false };
      await setState(matchId, {
        board,
        playerOrder: [x.userId, o.userId],
        currentTurn: x.userId,
        mustContinueFrom: null,
        movesSinceProgress: 39,
        winnerUserId: null,
        isDraw: false,
      });

      await move(
        x.accessToken,
        matchId,
        { row: 4, col: 3 },
        { row: 5, col: 4 },
      ).expect(200);

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('COMPLETED');
      expect(match.body.resultIsDraw).toBe(true);
      expect(match.body.winnerUserId).toBeNull();

      // A draw refunds each player's own stake — nobody loses money to
      // the no-progress rule.
      expect(await availableBalance(x.userId)).toBe(fundedAmount);
      expect(await availableBalance(o.userId)).toBe(fundedAmount);
    });
  });

  describe('disconnect/reconnect and recovery', () => {
    it('forfeits an abandoned match to the still-connected opponent via the existing sweep', async () => {
      const { matchId, x, o } = await createActiveMatch('ckabandon');

      await prisma.matchPlayer.update({
        where: { matchId_userId: { matchId, userId: x.userId } },
        data: { disconnectedAt: new Date(Date.now() - 60 * 60 * 1000) },
      });

      await matchTimeoutService.sweep();

      const match = await getMatch(o.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('ABANDONED');
      expect(match.body.winnerUserId).toBe(o.userId);
      expect(match.body.terminationReason).toBe('ABANDONED_DISCONNECT');
    });
  });

  async function playerOrderOf(matchId: string): Promise<[string, string]> {
    const players = await prisma.matchPlayer.findMany({
      where: { matchId },
      orderBy: { seat: 'asc' },
    });
    return [players[0].userId, players[1].userId];
  }

  async function getOpponentId(
    matchId: string,
    userId: string,
  ): Promise<string> {
    const player = await prisma.matchPlayer.findFirstOrThrow({
      where: { matchId, userId: { not: userId } },
    });
    return player.userId;
  }
});
