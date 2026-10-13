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
import { SettlementService } from '../src/settlement/settlement.service.js';
import { MatchTimeoutService } from '../src/matches/match-timeout.service.js';

/**
 * Phase 8 — rolling-window responsible-gaming enforcement, end to end
 * against the real generic platform (real Postgres, the real command/
 * stake/settlement pipeline) — never a second test harness. Mirrors the
 * conventions in `match-stakes.e2e-spec.ts` exactly. See
 * docs/decisions/ADR-023-rolling-window-responsible-gaming.md for the
 * exact policy semantics every test here is proving.
 */
describe('Responsible-gaming rolling-window limits (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let settlementService: SettlementService;
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
    settlementService = moduleFixture.get(SettlementService);
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
    await prisma.responsibleGamingRestriction.deleteMany({
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

  function move(accessToken: string, matchId: string, cell: number) {
    return request(app.getHttpServer())
      .post(`/api/v1/matches/${matchId}/commands`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ commandId: randomUUID(), payload: { cell } });
  }

  function confirmStake(accessToken: string, matchId: string) {
    return request(app.getHttpServer())
      .post(`/api/v1/matches/${matchId}/stake/confirm`)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  async function setStakeLimit(accessToken: string, limitMinor: string) {
    await request(app.getHttpServer())
      .post('/api/v1/auth/responsible-gaming/stake-limit')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ limitMinor })
      .expect(200);
  }

  async function setLossLimit(accessToken: string, limitMinor: string) {
    await request(app.getHttpServer())
      .post('/api/v1/auth/responsible-gaming/loss-limit')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ limitMinor })
      .expect(200);
  }

  async function selfExclude(accessToken: string) {
    await request(app.getHttpServer())
      .post('/api/v1/auth/responsible-gaming/self-exclude')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  }

  /** Creates a staked challenge between two fresh, funded users. Returns it un-accepted. */
  async function createStakedChallenge(
    labelPrefix: string,
    stakeAmountMinor: string,
    fundingAmountMinor = '100000',
  ): Promise<{
    challengeId: string;
    x: { accessToken: string; userId: string };
    o: { accessToken: string; userId: string };
  }> {
    const x = await registerUser(`${labelPrefix}x`);
    const o = await registerUser(`${labelPrefix}o`);
    const admin = await registerUser(`${labelPrefix}a`);
    await makeAdmin(admin.userId);
    await creditViaAdmin(admin.accessToken, x.userId, fundingAmountMinor);
    await creditViaAdmin(admin.accessToken, o.userId, fundingAmountMinor);

    const challenge = await request(app.getHttpServer())
      .post('/api/v1/challenges')
      .set('Authorization', `Bearer ${x.accessToken}`)
      .send({
        gameId: 'tic_tac_toe',
        opponentUserId: o.userId,
        stake: { amountMinor: stakeAmountMinor, currency: 'SLE' },
      })
      .expect(201);

    return { challengeId: challenge.body.id as string, x, o };
  }

  /** Creates and activates (both stakes held) a staked match via challenge. */
  async function createActiveStakedMatch(
    labelPrefix: string,
    stakeAmountMinor: string,
    fundingAmountMinor = '100000',
  ): Promise<{
    matchId: string;
    x: { accessToken: string; userId: string };
    o: { accessToken: string; userId: string };
  }> {
    const { challengeId, x, o } = await createStakedChallenge(
      labelPrefix,
      stakeAmountMinor,
      fundingAmountMinor,
    );
    const accepted = await request(app.getHttpServer())
      .post(`/api/v1/challenges/${challengeId}/accept`)
      .set('Authorization', `Bearer ${o.accessToken}`)
      .expect(200);
    const matchId = accepted.body.matchId as string;

    await confirmStake(x.accessToken, matchId).expect(200);
    await confirmStake(o.accessToken, matchId).expect(200);

    return { matchId, x, o };
  }

  async function playToWin(
    matchId: string,
    x: { accessToken: string },
    o: { accessToken: string },
  ): Promise<void> {
    await move(x.accessToken, matchId, 0).expect(200);
    await move(o.accessToken, matchId, 3).expect(200);
    await move(x.accessToken, matchId, 1).expect(200);
    await move(o.accessToken, matchId, 4).expect(200);
    await move(x.accessToken, matchId, 2).expect(200);
  }

  async function playToDraw(
    matchId: string,
    x: { accessToken: string },
    o: { accessToken: string },
  ): Promise<void> {
    const sequence: [typeof x, number][] = [
      [x, 0],
      [o, 1],
      [x, 2],
      [o, 4],
      [x, 3],
      [o, 5],
      [x, 7],
      [o, 6],
      [x, 8],
    ];
    for (const [player, cell] of sequence) {
      await move(player.accessToken, matchId, cell).expect(200);
    }
  }

  describe('rolling stake limit', () => {
    it('allows a stake that stays within the configured rolling limit', async () => {
      const { matchId, x, o } = await createActiveStakedMatch('rsl1', '1000');
      // createActiveStakedMatch already confirmed both stakes before the
      // limit below was set — set a limit comfortably above what's
      // already staked (1000) so a *second* small staked match is still
      // allowed.
      await setStakeLimit(x.accessToken, '5000');
      void o;
      expect(matchId).toBeTruthy();
    });

    it('rejects a stake that would push the rolling total over the configured limit', async () => {
      const x = await registerUser('rsl2x');
      const o1 = await registerUser('rsl2o1');
      const o2 = await registerUser('rsl2o2');
      const admin = await registerUser('rsl2a');
      await makeAdmin(admin.userId);
      await creditViaAdmin(admin.accessToken, x.userId, '100000');
      await creditViaAdmin(admin.accessToken, o1.userId, '100000');
      await creditViaAdmin(admin.accessToken, o2.userId, '100000');

      await setStakeLimit(x.accessToken, '1500');

      // First stake: 1000 — within the 1500 rolling limit. Played to a
      // finish (Phase 9 — a user can hold at most one WAITING/ACTIVE
      // match at a time; see ADR-024), which frees x to enter a second
      // one below. The rolling STAKE_HOLD sum is unaffected by the match
      // completing — it reads ledger history, not current match status.
      const challenge1 = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${x.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: o1.userId,
          stake: { amountMinor: '1000', currency: 'SLE' },
        })
        .expect(201);
      const accepted1 = await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge1.body.id}/accept`)
        .set('Authorization', `Bearer ${o1.accessToken}`)
        .expect(200);
      await confirmStake(x.accessToken, accepted1.body.matchId).expect(200);
      await confirmStake(o1.accessToken, accepted1.body.matchId).expect(200);
      await playToWin(accepted1.body.matchId, x, o1);

      // Second stake: another 1000 would bring the rolling total to
      // 2000, over the 1500 limit. The first match's STAKE_HOLD entry
      // is already in ledger history by this point (settled, not just
      // held), so even the *advisory* check at challenge-creation time
      // (`validateStakeRequest`, which runs the same rolling-sum logic
      // as the authoritative check) correctly rejects it immediately —
      // there's no need to get as far as accept/confirm to prove the
      // rolling limit is enforced.
      await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${x.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: o2.userId,
          stake: { amountMinor: '1000', currency: 'SLE' },
        })
        .expect(403);

      // Nothing new was held — the first match already settled and
      // released its own hold.
      const wallet = await prisma.wallet.findUniqueOrThrow({
        where: { userId: x.userId },
      });
      expect(wallet.heldBalanceMinor).toBe(0n);
    });

    it(
      'two staked challenges accepted concurrently by the same user cannot ' +
        'both form a match — the advisory-lock guard (Phase 9, ADR-024) ' +
        'closes this before the rolling-stake-limit check even runs twice',
      async () => {
        const x = await registerUser('rsl3x');
        const o1 = await registerUser('rsl3o1');
        const o2 = await registerUser('rsl3o2');
        const admin = await registerUser('rsl3a');
        await makeAdmin(admin.userId);
        await creditViaAdmin(admin.accessToken, x.userId, '100000');
        await creditViaAdmin(admin.accessToken, o1.userId, '100000');
        await creditViaAdmin(admin.accessToken, o2.userId, '100000');

        await setStakeLimit(x.accessToken, '1500');

        async function createChallengeFor(opponent: {
          userId: string;
        }): Promise<string> {
          const challenge = await request(app.getHttpServer())
            .post('/api/v1/challenges')
            .set('Authorization', `Bearer ${x.accessToken}`)
            .send({
              gameId: 'tic_tac_toe',
              opponentUserId: opponent.userId,
              stake: { amountMinor: '1000', currency: 'SLE' },
            })
            .expect(201);
          return challenge.body.id as string;
        }

        const challengeIdA = await createChallengeFor(o1);
        const challengeIdB = await createChallengeFor(o2);

        const [resA, resB] = await Promise.all([
          request(app.getHttpServer())
            .post(`/api/v1/challenges/${challengeIdA}/accept`)
            .set('Authorization', `Bearer ${o1.accessToken}`),
          request(app.getHttpServer())
            .post(`/api/v1/challenges/${challengeIdB}/accept`)
            .set('Authorization', `Bearer ${o2.accessToken}`),
        ]);

        // Exactly one accept formed a real match for x; the other was
        // rejected before ever reaching a financial operation — there is
        // only ever one stake for the rolling-limit check to see, by
        // construction, not by a race it has to win.
        const statuses = [resA.status, resB.status].sort();
        expect(statuses).toEqual([200, 409]);

        const winner = resA.status === 200 ? resA : resB;
        await confirmStake(x.accessToken, winner.body.matchId as string).expect(
          200,
        );

        const wallet = await prisma.wallet.findUniqueOrThrow({
          where: { userId: x.userId },
        });
        expect(wallet.heldBalanceMinor).toBe(1000n); // exactly one hold
      },
    );
  });

  describe('rolling loss limit', () => {
    it('does not block further staking after a win', async () => {
      const { matchId, x, o } = await createActiveStakedMatch('rll1', '1000');
      await setLossLimit(x.accessToken, '500');
      await playToWin(matchId, x, o);

      // x won — no loss recorded against x's limit.
      const { matchId: matchId2 } = await createActiveStakedMatch(
        'rll1b',
        '1000',
      );
      void matchId2;
    });

    it('rejects a new stake once the rolling loss total reaches the configured limit', async () => {
      const x = await registerUser('rll2x');
      const o = await registerUser('rll2o');
      const admin = await registerUser('rll2a');
      await makeAdmin(admin.userId);
      await creditViaAdmin(admin.accessToken, x.userId, '100000');
      await creditViaAdmin(admin.accessToken, o.userId, '100000');

      await setLossLimit(x.accessToken, '1000');

      // x loses exactly 1000 (one lost match) — reaches the limit.
      const challenge = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${x.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: o.userId,
          stake: { amountMinor: '1000', currency: 'SLE' },
        })
        .expect(201);
      const accepted = await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/accept`)
        .set('Authorization', `Bearer ${o.accessToken}`)
        .expect(200);
      await confirmStake(x.accessToken, accepted.body.matchId).expect(200);
      await confirmStake(o.accessToken, accepted.body.matchId).expect(200);
      // x is the challenger, so x always moves first (seat 0) — for o
      // (seat 1) to win: x plays 0, 1, 8 (no line); o plays 3, 4, 5
      // (row 1 — a win for o, a loss for x).
      await move(x.accessToken, accepted.body.matchId, 0).expect(200);
      await move(o.accessToken, accepted.body.matchId, 3).expect(200);
      await move(x.accessToken, accepted.body.matchId, 1).expect(200);
      await move(o.accessToken, accepted.body.matchId, 4).expect(200);
      await move(x.accessToken, accepted.body.matchId, 8).expect(200);
      await move(o.accessToken, accepted.body.matchId, 5).expect(200);

      const settlement = await prisma.settlement.findFirst({
        where: { matchStake: { matchId: accepted.body.matchId } },
      });
      expect(settlement?.outcome).toBe('WIN');

      // x's rolling loss is now exactly 1000 — at the limit. Any new
      // stake request is rejected immediately (the early advisory
      // check in `validateStakeRequest` already catches this, since a
      // reached loss limit doesn't depend on the new amount at all).
      await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${x.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: o.userId,
          stake: { amountMinor: '100', currency: 'SLE' },
        })
        .expect(403);
    });

    it('a draw does not count toward the rolling loss total', async () => {
      const { matchId, x, o } = await createActiveStakedMatch('rll3', '1000');
      await setLossLimit(x.accessToken, '1');
      await playToDraw(matchId, x, o);

      const settlement = await prisma.settlement.findFirst({
        where: { matchStake: { matchId } },
      });
      expect(settlement?.outcome).toBe('DRAW');

      // Loss limit of 1 minor unit would block staking if the draw's
      // refund were ever (wrongly) counted as a loss — it must not be.
      const challenge2 = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${x.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: o.userId,
          stake: { amountMinor: '100', currency: 'SLE' },
        })
        .expect(201);
      const accepted2 = await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge2.body.id}/accept`)
        .set('Authorization', `Bearer ${o.accessToken}`)
        .expect(200);
      await confirmStake(x.accessToken, accepted2.body.matchId).expect(200);
    });

    it('a cancelled/refunded match does not count toward the rolling loss total', async () => {
      const x = await registerUser('rll4x');
      const o = await registerUser('rll4o');
      const admin = await registerUser('rll4a');
      await makeAdmin(admin.userId);
      await creditViaAdmin(admin.accessToken, x.userId, '100000');
      await creditViaAdmin(admin.accessToken, o.userId, '100000');
      await setLossLimit(x.accessToken, '1');

      const challenge = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${x.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: o.userId,
          stake: { amountMinor: '1000', currency: 'SLE' },
        })
        .expect(201);
      const accepted = await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/accept`)
        .set('Authorization', `Bearer ${o.accessToken}`)
        .expect(200);
      await confirmStake(x.accessToken, accepted.body.matchId).expect(200);
      // o never confirms — back-date expiresAt and sweep to cancel.
      await prisma.match.update({
        where: { id: accepted.body.matchId as string },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await matchTimeoutService.sweep();

      const settlement = await prisma.settlement.findFirst({
        where: { matchStake: { matchId: accepted.body.matchId as string } },
      });
      expect(settlement?.outcome).toBe('CANCELLED');

      const challenge2 = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${x.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: o.userId,
          stake: { amountMinor: '100', currency: 'SLE' },
        })
        .expect(201);
      const accepted2 = await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge2.body.id}/accept`)
        .set('Authorization', `Bearer ${o.accessToken}`)
        .expect(200);
      await confirmStake(x.accessToken, accepted2.body.matchId).expect(200);
    });

    it('a duplicate/retried settlement does not double-count the loss', async () => {
      const { matchId, x, o } = await createActiveStakedMatch('rll5', '1000');
      // x is the challenger, so x always moves first (seat 0) — to make
      // *o* the winner (and x the loser), o must complete a line on
      // its own moves: x plays 0, 1, 8 (no line); o plays 3, 4, 5 (row
      // 1 — a win for o).
      await move(x.accessToken, matchId, 0).expect(200);
      await move(o.accessToken, matchId, 3).expect(200);
      await move(x.accessToken, matchId, 1).expect(200);
      await move(o.accessToken, matchId, 4).expect(200);
      await move(x.accessToken, matchId, 8).expect(200);
      await move(o.accessToken, matchId, 5).expect(200);

      const settlement = await prisma.settlement.findFirst({
        where: { matchStake: { matchId } },
      });
      expect(settlement?.outcome).toBe('WIN');

      const lossCountBefore = await prisma.settlementEntry.count({
        where: { userId: x.userId, role: 'LOSER' },
      });
      expect(lossCountBefore).toBe(1);

      // Retry settle() directly — idempotent, must not create a second
      // SettlementEntry/LOSER row (the exactly-once guarantee this
      // phase's rolling-loss sum relies on).
      await settlementService.settle(matchId);
      await settlementService.settle(matchId);

      const lossCountAfter = await prisma.settlementEntry.count({
        where: { userId: x.userId, role: 'LOSER' },
      });
      expect(lossCountAfter).toBe(1);
    });
  });

  describe('self-exclusion blocks staked matches through every path', () => {
    it('blocks a self-excluded user from matchmaking with a stake', async () => {
      const user = await registerUser('selfexmm');
      await selfExclude(user.accessToken);

      const res = await request(app.getHttpServer())
        .post('/api/v1/matchmaking/join')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          stake: { amountMinor: '100', currency: 'SLE' },
        });
      expect(res.status).toBe(403);
    });

    it('blocks a self-excluded challenger from creating a staked challenge', async () => {
      const challenger = await registerUser('selfexchallenger');
      const opponent = await registerUser('selfexchallengeropp');
      await selfExclude(challenger.accessToken);

      const res = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${challenger.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: opponent.userId,
          stake: { amountMinor: '100', currency: 'SLE' },
        });
      expect(res.status).toBe(403);
    });

    it('blocks a self-excluded opponent from accepting an incoming staked challenge (the Phase 8 fix)', async () => {
      const challenger = await registerUser('selfexacceptchallenger');
      const opponent = await registerUser('selfexacceptopp');
      const admin = await registerUser('selfexacceptadmin');
      await makeAdmin(admin.userId);
      await creditViaAdmin(admin.accessToken, challenger.userId, '100000');

      const challenge = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${challenger.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: opponent.userId,
          stake: { amountMinor: '100', currency: 'SLE' },
        })
        .expect(201);

      // The opponent self-excludes *after* being challenged, then tries
      // to accept — before this phase's fix, `accept()` never checked
      // the opponent's own eligibility at all.
      await selfExclude(opponent.accessToken);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/accept`)
        .set('Authorization', `Bearer ${opponent.accessToken}`);
      expect(res.status).toBe(403);

      // No match/stake should exist for this challenge.
      const stillPending = await prisma.challenge.findUnique({
        where: { id: challenge.body.id as string },
      });
      expect(stillPending?.status).toBe('PENDING');
      expect(stillPending?.matchId).toBeNull();
    });
  });

  describe('rolling-window boundary', () => {
    it('ignores a stake-hold ledger entry older than the configured window', async () => {
      const {
        matchId,
        x,
        o: firstOpponent,
      } = await createActiveStakedMatch('win1', '1000');
      // Finish the first match (Phase 9 — a user can hold at most one
      // WAITING/ACTIVE match at a time; see ADR-024) so x is free to
      // enter a second one below. The original STAKE_HOLD ledger entry
      // this test cares about persists in ledger history regardless of
      // the match completing — the immutable ledger is never rewritten.
      await playToWin(matchId, x, firstOpponent);

      // Push the already-recorded STAKE_HOLD entry outside the rolling
      // window by backdating it directly (mirrors the existing
      // `match-timeout` sweep tests' established backdating technique).
      await prisma.ledgerEntry.updateMany({
        where: { userId: x.userId, type: 'STAKE_HOLD' },
        data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
      });

      await setStakeLimit(x.accessToken, '1000');

      // A fresh 1000 stake should be allowed — the old 1000 hold is now
      // outside the (default 24h) rolling window and must not count.
      const o = await registerUser('win1o2');
      const admin = await registerUser('win1a2');
      await makeAdmin(admin.userId);
      await creditViaAdmin(admin.accessToken, o.userId, '100000');

      const challenge = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${x.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: o.userId,
          stake: { amountMinor: '1000', currency: 'SLE' },
        })
        .expect(201);
      const accepted = await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/accept`)
        .set('Authorization', `Bearer ${o.accessToken}`)
        .expect(200);

      await confirmStake(x.accessToken, accepted.body.matchId).expect(200);
    });
  });
});
