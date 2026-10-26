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
import { SettlementService } from '../src/settlement/settlement.service.js';
import { WalletService } from '../src/wallet/wallet.service.js';
import { LedgerService } from '../src/ledger/ledger.service.js';
import { SYSTEM_ACCOUNT_USER_ID } from '../src/system-account/system-account.constants.js';
import { vi } from 'vitest';

describe('Match Stakes / Settlement / Disputes / Reconciliation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let matchTimeoutService: MatchTimeoutService;
  let settlementService: SettlementService;
  let walletService: WalletService;
  let ledgerService: LedgerService;
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
    settlementService = moduleFixture.get(SettlementService);
    walletService = moduleFixture.get(WalletService);
    ledgerService = moduleFixture.get(LedgerService);
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

    // Settlement/MatchStake/Dispute are all `onDelete: Restrict` toward
    // Match — must be removed before Match itself (SettlementEntry/
    // MatchStakePlayer cascade from their own parents automatically).
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
    await prisma.dispute.deleteMany({
      where: { raisedByUserId: { in: userIds } },
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
    dateOfBirth = '2000-01-01',
  ): Promise<{ accessToken: string; userId: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: email(label),
        username: username(label),
        password: 'Passw0rd1',
        dateOfBirth,
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
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId },
    });
    return wallet.availableBalanceMinor;
  }

  async function heldBalance(userId: string): Promise<bigint> {
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId },
    });
    return wallet.heldBalanceMinor;
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

  function financial(accessToken: string, matchId: string) {
    return request(app.getHttpServer())
      .get(`/api/v1/matches/${matchId}/financial`)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  /** Creates a WAITING, financially-backed match via a staked challenge. */
  async function createStakedMatch(
    labelPrefix: string,
    stakeAmountMinor: string,
    fundingAmountMinor = '100000',
  ): Promise<{
    matchId: string;
    x: { accessToken: string; userId: string };
    o: { accessToken: string; userId: string };
    admin: { accessToken: string; userId: string };
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

    const accepted = await request(app.getHttpServer())
      .post(`/api/v1/challenges/${challenge.body.id}/accept`)
      .set('Authorization', `Bearer ${o.accessToken}`)
      .expect(200);

    return { matchId: accepted.body.matchId as string, x, o, admin };
  }

  /** Confirms both players' stakes and asserts the match is now ACTIVE. */
  async function confirmBothAndActivate(
    matchId: string,
    x: { accessToken: string },
    o: { accessToken: string },
  ): Promise<void> {
    await confirmStake(x.accessToken, matchId).expect(200);
    const afterSecond = await confirmStake(o.accessToken, matchId).expect(200);
    expect(afterSecond.body.stake.status).toBe('ACTIVE');

    const match = await request(app.getHttpServer())
      .get(`/api/v1/matches/${matchId}`)
      .set('Authorization', `Bearer ${x.accessToken}`)
      .expect(200);
    expect(match.body.status).toBe('ACTIVE');
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

  describe('full lifecycle — win', () => {
    it('matches the documented example exactly, settles once, and leaves no anomaly', async () => {
      const { matchId, x, o } = await createStakedMatch('win', '1000');

      const beforeX = await availableBalance(x.userId);
      const beforeO = await availableBalance(o.userId);

      await confirmBothAndActivate(matchId, x, o);
      expect(await availableBalance(x.userId)).toBe(beforeX - 1000n);
      expect(await heldBalance(x.userId)).toBe(1000n);
      expect(await availableBalance(o.userId)).toBe(beforeO - 1000n);
      expect(await heldBalance(o.userId)).toBe(1000n);

      await playToWin(matchId, x, o);

      // Winner (x): own Le10 stake back + Le8 net win = Le18 credited,
      // held released. Loser (o): held released, nothing credited.
      expect(await availableBalance(x.userId)).toBe(beforeX + 800n);
      expect(await heldBalance(x.userId)).toBe(0n);
      expect(await availableBalance(o.userId)).toBe(beforeO - 1000n);
      expect(await heldBalance(o.userId)).toBe(0n);

      const view = await financial(x.accessToken, matchId).expect(200);
      expect(view.body.stake.status).toBe('SETTLED');
      expect(view.body.settlement.outcome).toBe('WIN');
      expect(view.body.settlement.poolAmountMinor).toBe('2000');
      expect(view.body.settlement.platformFeeAmountMinor).toBe('200');

      // Idempotent retry: calling settle() again must not pay twice.
      await settlementService.settle(matchId);
      expect(await availableBalance(x.userId)).toBe(beforeX + 800n);
      expect(await heldBalance(o.userId)).toBe(0n);

      const platformWallet = await prisma.wallet.findUniqueOrThrow({
        where: { userId: SYSTEM_ACCOUNT_USER_ID },
      });
      const platformEntries = await prisma.ledgerEntry.count({
        where: {
          walletId: platformWallet.id,
          relatedMatchStakeId: view.body.stake.id,
        },
      });
      expect(platformEntries).toBe(1);
    });
  });

  describe('full lifecycle — draw', () => {
    it('refunds both players exactly their stake, with no fee', async () => {
      const { matchId, x, o } = await createStakedMatch('draw', '500');
      const beforeX = await availableBalance(x.userId);
      const beforeO = await availableBalance(o.userId);

      await confirmBothAndActivate(matchId, x, o);
      await playToDraw(matchId, x, o);

      expect(await availableBalance(x.userId)).toBe(beforeX);
      expect(await heldBalance(x.userId)).toBe(0n);
      expect(await availableBalance(o.userId)).toBe(beforeO);
      expect(await heldBalance(o.userId)).toBe(0n);

      const view = await financial(x.accessToken, matchId).expect(200);
      expect(view.body.settlement.outcome).toBe('DRAW');
      expect(view.body.settlement.platformFeeAmountMinor).toBe('0');
    });
  });

  describe('stake-commit timeout', () => {
    it('cancels the match and refunds whichever player already held', async () => {
      const { matchId, x, o } = await createStakedMatch('timeout', '750');
      const beforeX = await availableBalance(x.userId);

      await confirmStake(x.accessToken, matchId).expect(200);
      expect(await heldBalance(x.userId)).toBe(750n);

      await prisma.match.update({
        where: { id: matchId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await matchTimeoutService.sweep();

      const match = await request(app.getHttpServer())
        .get(`/api/v1/matches/${matchId}`)
        .set('Authorization', `Bearer ${x.accessToken}`)
        .expect(200);
      expect(match.body.status).toBe('CANCELLED');

      expect(await availableBalance(x.userId)).toBe(beforeX);
      expect(await heldBalance(x.userId)).toBe(0n);
      // o never confirmed — never held anything to refund.
      expect(await heldBalance(o.userId)).toBe(0n);

      const view = await financial(x.accessToken, matchId).expect(200);
      expect(view.body.stake.status).toBe('REFUNDED');
      expect(view.body.settlement.outcome).toBe('CANCELLED');
    });
  });

  describe('recovery of a one-sided stake on a cancelled match', () => {
    // OUTSTANDING_WORK item 26. A match can be cancelled while only SOME
    // players had held (stake-commit timeout). That stake never reached
    // ACTIVE — it is still PENDING — so the crash-recovery sweep used to
    // ignore it: if the process died (or settle() failed) between the
    // CANCELLED transition and the refund, the holder's funds were stranded.
    //
    // Deliberately free of timing: no sleeps, no reliance on a background
    // sweep. The "crash window" is created directly by performing the
    // WAITING -> CANCELLED transition `expireWaitingMatches` makes WITHOUT
    // the settle() call that follows it, then the existing sweep runs. The
    // sweep's recovery step itself settles — or, if a concurrent sweep is
    // already settling, waits for that committed settlement — so the end
    // state is the same whichever instance gets there first.

    /** Keeps the match from expiring on its own while the test sets up. */
    async function keepWaiting(matchId: string): Promise<void> {
      await prisma.match.update({
        where: { id: matchId },
        data: { expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
      });
    }

    it('refunds the lone holder exactly once, ending REFUNDED', async () => {
      const { matchId, x, o, admin } = await createStakedMatch(
        'pendrec',
        '750',
      );
      await keepWaiting(matchId);
      const beforeX = await availableBalance(x.userId);
      const beforeO = await availableBalance(o.userId);

      // Exactly one player holds. ACTIVE needs every player held, so the
      // stake is still PENDING. (Checked while the match is WAITING and
      // nothing else could have touched it.)
      await confirmStake(x.accessToken, matchId).expect(200);
      const held = await prisma.matchStake.findUniqueOrThrow({
        where: { matchId },
        include: { players: true },
      });
      expect(held.status).toBe('PENDING');
      expect(held.players.filter((p) => p.heldAt !== null)).toHaveLength(1);
      expect(await availableBalance(x.userId)).toBe(beforeX - 750n);
      expect(await heldBalance(x.userId)).toBe(750n);

      // The crash window: cancelled, refund not yet settled.
      const flipped = await prisma.match.updateMany({
        where: { id: matchId, status: 'WAITING' },
        data: { status: 'CANCELLED', terminationReason: 'WAITING_TIMEOUT' },
      });
      expect(flipped.count).toBe(1);

      await matchTimeoutService.sweep();

      // Funds back, exactly.
      expect(await availableBalance(x.userId)).toBe(beforeX);
      expect(await heldBalance(x.userId)).toBe(0n);
      expect(await availableBalance(o.userId)).toBe(beforeO);
      expect(await heldBalance(o.userId)).toBe(0n);

      const stake = await prisma.matchStake.findUniqueOrThrow({
        where: { matchId },
        include: { settlement: { include: { entries: true } } },
      });
      expect(stake.status).toBe('REFUNDED');
      expect(stake.settlement?.outcome).toBe('CANCELLED');
      expect(stake.settlement?.status).toBe('COMPLETED');
      expect(stake.settlement?.platformFeeAmountMinor).toBe(0n);
      expect(stake.settlement?.entries).toHaveLength(1);
      expect(stake.settlement?.entries[0]).toMatchObject({
        userId: x.userId,
        role: 'REFUND_RECIPIENT',
        availableDeltaMinor: 750n,
        heldDeltaMinor: -750n,
      });

      // Ledger: one hold and one refund for this stake, both x's, netting to
      // zero — and nothing at all for the player who never held.
      const ledger = await prisma.ledgerEntry.findMany({
        where: { relatedMatchStakeId: stake.id },
      });
      expect(ledger.map((e) => e.type).sort()).toEqual([
        'STAKE_HOLD',
        'STAKE_REFUND',
      ]);
      expect(ledger.every((e) => e.userId === x.userId)).toBe(true);
      expect(ledger.reduce((sum, e) => sum + e.availableDeltaMinor, 0n)).toBe(
        0n,
      );
      expect(ledger.reduce((sum, e) => sum + e.heldDeltaMinor, 0n)).toBe(0n);

      // Exactly once: more recovery passes and a direct settle() change
      // nothing.
      await matchTimeoutService.sweep();
      await settlementService.settle(matchId);
      expect(await availableBalance(x.userId)).toBe(beforeX);
      expect(await heldBalance(x.userId)).toBe(0n);
      expect(
        await prisma.settlement.count({ where: { matchStakeId: stake.id } }),
      ).toBe(1);
      expect(
        await prisma.ledgerEntry.count({
          where: { relatedMatchStakeId: stake.id, type: 'STAKE_REFUND' },
        }),
      ).toBe(1);

      // Reconciliation sees a consistent picture for this match.
      const report = await request(app.getHttpServer())
        .get('/api/v1/admin/reconciliation/run')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      const relevant = report.body.anomalies.filter(
        (a: { matchId?: string; matchStakeId?: string }) =>
          a.matchId === matchId || a.matchStakeId === stake.id,
      );
      expect(relevant).toHaveLength(0);
    });

    it('leaves a one-sided stake on a still-WAITING match untouched', async () => {
      // Safety: recovery must only ever pick up a PENDING stake whose match
      // is CANCELLED. A live waiting room must not be settled or refunded.
      const { matchId, x } = await createStakedMatch('pendwait', '750');
      await keepWaiting(matchId);
      await confirmStake(x.accessToken, matchId).expect(200);

      await matchTimeoutService.sweep();

      const match = await prisma.match.findUniqueOrThrow({
        where: { id: matchId },
      });
      expect(match.status).toBe('WAITING');
      const stake = await prisma.matchStake.findUniqueOrThrow({
        where: { matchId },
        include: { settlement: true },
      });
      expect(stake.status).toBe('PENDING');
      expect(stake.settlement).toBeNull();
      expect(await heldBalance(x.userId)).toBe(750n);
    });
  });

  describe('stake-commit timeout racing other work (item 26)', () => {
    // OUTSTANDING_WORK item 26. The original intermittent failure of the
    // stake-commit timeout test above saw the match CANCELLED with the lone
    // holder's refund not yet applied (expected 100000n, received 99250n).
    // Two explanations fit and the run's logs were never readable: another
    // sweep cancelled the match first and was still settling it (race), or
    // the refund's settle() failed once (transient failure). Both are forced
    // here deterministically - with gates, not sleeps - and with them a
    // third interleaving found while tracing the path: a stake confirmed
    // while the timeout is cancelling the match.

    function deferred(): { promise: Promise<void>; resolve: () => void } {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve };
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** One player holds, then the stake-commit window is made to elapse. */
    async function holdOneSideAndExpire(label: string) {
      const created = await createStakedMatch(label, '750');
      const beforeX = await availableBalance(created.x.userId);
      await confirmStake(created.x.accessToken, created.matchId).expect(200);
      expect(await heldBalance(created.x.userId)).toBe(750n);
      await prisma.match.update({
        where: { id: created.matchId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      return { ...created, beforeX };
    }

    async function expectRefundedExactlyOnce(
      matchId: string,
      holder: { userId: string },
      before: bigint,
    ): Promise<void> {
      expect(await availableBalance(holder.userId)).toBe(before);
      expect(await heldBalance(holder.userId)).toBe(0n);
      const stake = await prisma.matchStake.findUniqueOrThrow({
        where: { matchId },
        include: { settlement: { include: { entries: true } } },
      });
      expect(stake.status).toBe('REFUNDED');
      expect(stake.settlement?.outcome).toBe('CANCELLED');
      expect(stake.settlement?.entries).toHaveLength(1);
      expect(stake.settlement?.entries[0]).toMatchObject({
        userId: holder.userId,
        role: 'REFUND_RECIPIENT',
        availableDeltaMinor: 750n,
        heldDeltaMinor: -750n,
      });
      expect(
        await prisma.settlement.count({ where: { matchStakeId: stake.id } }),
      ).toBe(1);
      const ledger = await prisma.ledgerEntry.findMany({
        where: { relatedMatchStakeId: stake.id },
      });
      expect(ledger.map((e) => e.type).sort()).toEqual([
        'STAKE_HOLD',
        'STAKE_REFUND',
      ]);
      expect(ledger.every((e) => e.userId === holder.userId)).toBe(true);
    }

    it('a sweep that finds the match already cancelled still finishes the refund', async () => {
      const { matchId, x, beforeX } = await holdOneSideAndExpire('ovrlap');
      const realSettle = settlementService.settle.bind(settlementService);
      const reached = deferred();
      const gate = deferred();
      let paused = false;
      vi.spyOn(settlementService, 'settle').mockImplementation(async (id) => {
        if (id === matchId && !paused) {
          paused = true;
          reached.resolve();
          await gate.promise;
        }
        return realSettle(id);
      });

      // The first sweep cancels the match and is held inside its settle().
      const first = matchTimeoutService.sweep();
      try {
        await reached.promise;
        // Exactly the state the original failure observed.
        const cancelled = await prisma.match.findUniqueOrThrow({
          where: { id: matchId },
        });
        expect(cancelled.status).toBe('CANCELLED');
        expect(await availableBalance(x.userId)).toBe(beforeX - 750n);

        // A second sweep (another instance, or the test's own) finds nothing
        // to expire; its recovery step must still refund before returning.
        await matchTimeoutService.sweep();
        await expectRefundedExactlyOnce(matchId, x, beforeX);
      } finally {
        gate.resolve();
        await first;
      }

      // The first sweep's settle() then finds the settlement and pays nothing.
      await expectRefundedExactlyOnce(matchId, x, beforeX);
    });

    /**
     * Waits until some backend is blocked by `blockerPid`, polling
     * `pg_blocking_pids` from the test's own connection. A bounded condition
     * wait, not a sleep: it returns the moment Postgres reports the block.
     */
    async function waitForBackendBlockedBy(
      blockerPid: number,
      timeoutMs = 5000,
    ): Promise<
      { pid: number; wait_event_type: string | null; query: string }[]
    > {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        const rows = await prisma.$queryRaw<
          { pid: number; wait_event_type: string | null; query: string }[]
        >`SELECT pid, wait_event_type, query FROM pg_stat_activity
          WHERE ${blockerPid}::int = ANY(pg_blocking_pids(pid))`;
        if (rows.length > 0) return rows;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        `No backend became blocked by pid ${blockerPid} within ${timeoutMs}ms`,
      );
    }

    it('a recovery sweep that races an in-flight refund waits for it, then pays nothing', async () => {
      const { matchId, x, beforeX } = await holdOneSideAndExpire('inflt');
      const { id: stakeId } = await prisma.matchStake.findUniqueOrThrow({
        where: { matchId },
      });

      // Hold the first refund *inside* its settlement transaction, after the
      // real applyEntry has run: the settlement row (unique on matchStakeId),
      // x's locked wallet update and the STAKE_REFUND entry are all written
      // but uncommitted.
      const realApplyEntry = ledgerService.applyEntry.bind(ledgerService);
      const reached = deferred();
      const gate = deferred();
      let paused = false;
      let firstPid: number | undefined;
      const applyEntry = vi
        .spyOn(ledgerService, 'applyEntry')
        .mockImplementation(async (tx, walletId, params) => {
          const result = await realApplyEntry(tx, walletId, params);
          if (
            params.type === 'STAKE_REFUND' &&
            params.relatedMatchStakeId === stakeId &&
            !paused
          ) {
            paused = true;
            const [{ pid }] = await tx.$queryRaw<
              { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            firstPid = pid;
            reached.resolve();
            await gate.promise;
          }
          return result;
        });

      const first = matchTimeoutService.sweep();
      void first.catch(() => undefined);
      let second: Promise<void> | undefined;
      let secondDone = false;
      try {
        await reached.promise;
        if (firstPid === undefined) throw new Error('first pid not captured');

        // Cancelled, refund written but not committed: invisible here.
        const cancelled = await prisma.match.findUniqueOrThrow({
          where: { id: matchId },
        });
        expect(cancelled.status).toBe('CANCELLED');
        expect(await availableBalance(x.userId)).toBe(beforeX - 750n);
        expect(await heldBalance(x.userId)).toBe(750n);
        expect(
          await prisma.settlement.count({ where: { matchStakeId: stakeId } }),
        ).toBe(0);

        // The competing recovery sweep cannot see the uncommitted settlement,
        // so it retries this stake and must block on the settlement insert.
        second = matchTimeoutService.sweep().then(() => {
          secondDone = true;
        });
        void second.catch(() => undefined);
        const blocked = await waitForBackendBlockedBy(firstPid);
        expect(blocked).toHaveLength(1);
        expect(blocked[0].wait_event_type).toBe('Lock');
        expect(blocked[0].query).toMatch(/INSERT INTO "public"\."settlements"/);
        expect(secondDone).toBe(false);

        // Release the first refund. The second sweep returns only after it
        // has committed - so the refund is visible the moment it does.
        gate.resolve();
        await second;
        await expectRefundedExactlyOnce(matchId, x, beforeX);
      } finally {
        gate.resolve();
        await Promise.allSettled([first, second ?? Promise.resolve()]);
      }

      // The first sweep finished its own refund; nothing was paid twice and
      // the second settle() never reached the ledger.
      await expectRefundedExactlyOnce(matchId, x, beforeX);
      expect(
        applyEntry.mock.calls.filter(
          ([, , params]) =>
            params.type === 'STAKE_REFUND' &&
            params.relatedMatchStakeId === stakeId,
        ),
      ).toHaveLength(1);
    }, 20000);

    it('a refund whose settle() fails once is retried by the same sweep', async () => {
      const { matchId, x, beforeX } = await holdOneSideAndExpire('retry');
      const realSettle = settlementService.settle.bind(settlementService);
      let failed = false;
      const settle = vi
        .spyOn(settlementService, 'settle')
        .mockImplementation(async (id) => {
          if (id === matchId && !failed) {
            failed = true;
            throw new Error('injected transient settlement failure');
          }
          return realSettle(id);
        });

      await matchTimeoutService.sweep();

      // Cancellation's settle() failed (logged and swallowed); the recovery
      // step at the end of the same sweep retried it.
      expect(settle.mock.calls.filter(([id]) => id === matchId)).toHaveLength(
        2,
      );
      expect(failed).toBe(true);
      await expectRefundedExactlyOnce(matchId, x, beforeX);

      // More passes change nothing.
      await matchTimeoutService.sweep();
      await expectRefundedExactlyOnce(matchId, x, beforeX);
    });

    it('a stake confirmed while the match is being cancelled is rejected, never stranded', async () => {
      const { matchId, x, o, admin } = await createStakedMatch(
        'lateconf',
        '750',
      );
      const beforeX = await availableBalance(x.userId);
      const beforeO = await availableBalance(o.userId);
      await confirmStake(x.accessToken, matchId).expect(200);

      // Hold o's confirm at the first statement of its hold transaction:
      // after its WAITING pre-check, before it holds anything or takes any
      // lock. (Every other caller passes straight through.)
      const realGetWalletId =
        walletService.getWalletIdForUser.bind(walletService);
      const reached = deferred();
      const gate = deferred();
      let paused = false;
      vi.spyOn(walletService, 'getWalletIdForUser').mockImplementation(
        async (client, userId) => {
          if (userId === o.userId && client !== prisma && !paused) {
            paused = true;
            reached.resolve();
            await gate.promise;
          }
          return realGetWalletId(client, userId);
        },
      );

      const lateConfirm = confirmStake(o.accessToken, matchId).then(
        (res) => res,
      );
      let status: number;
      try {
        await reached.promise;
        // Meanwhile the stake-commit window elapses and the sweep cancels
        // the match and refunds x - the only player who has held.
        await prisma.match.update({
          where: { id: matchId },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
        await matchTimeoutService.sweep();
        await expectRefundedExactlyOnce(matchId, x, beforeX);
      } finally {
        gate.resolve();
        status = (await lateConfirm).status;
      }

      // o's hold must not land on the cancelled, already-refunded match.
      expect(status).toBe(422);
      expect(await availableBalance(o.userId)).toBe(beforeO);
      expect(await heldBalance(o.userId)).toBe(0n);
      const match = await prisma.match.findUniqueOrThrow({
        where: { id: matchId },
      });
      expect(match.status).toBe('CANCELLED');
      await expectRefundedExactlyOnce(matchId, x, beforeX);

      const stake = await prisma.matchStake.findUniqueOrThrow({
        where: { matchId },
        include: { players: true },
      });
      expect(
        stake.players.find((p) => p.userId === o.userId)?.heldAt,
      ).toBeNull();

      const report = await request(app.getHttpServer())
        .get('/api/v1/admin/reconciliation/run')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      const relevant = report.body.anomalies.filter(
        (a: { matchId?: string; matchStakeId?: string }) =>
          a.matchId === matchId || a.matchStakeId === stake.id,
      );
      expect(relevant).toHaveLength(0);
    });
  });

  describe('stranded-hold detection (item 26)', () => {
    it('reconciliation reports a hold that landed after its stake was refunded (the pre-PR #6 state)', async () => {
      // PR #6 makes this state impossible to create through the API. Holds it
      // left behind before the fix still exist in any database it ran against,
      // so this recreates the exact end state directly and checks that the
      // admin reconciliation run surfaces it - it is the audit item 26 asks for.
      const { matchId, x, o, admin } = await createStakedMatch('strand', '750');
      await confirmStake(x.accessToken, matchId).expect(200);
      await prisma.match.update({
        where: { id: matchId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await matchTimeoutService.sweep();
      const stake = await prisma.matchStake.findUniqueOrThrow({
        where: { matchId },
      });
      expect(stake.status).toBe('REFUNDED');

      const run = async () =>
        (
          await request(app.getHttpServer())
            .get('/api/v1/admin/reconciliation/run')
            .set('Authorization', `Bearer ${admin.accessToken}`)
            .expect(200)
        ).body.anomalies.filter(
          (a: { matchStakeId?: string }) => a.matchStakeId === stake.id,
        ) as { type: string; userId?: string }[];

      // Clean before the late hold: x was released by the refund.
      expect(await run()).toHaveLength(0);

      // The late hold, exactly as the old bug committed it: heldAt set and a
      // STAKE_HOLD through the ledger (so the wallet still matches its ledger),
      // after the stake had already been REFUNDED.
      const oWallet = await prisma.wallet.findUniqueOrThrow({
        where: { userId: o.userId },
      });
      await prisma.$transaction(async (tx) => {
        await tx.matchStakePlayer.updateMany({
          where: { matchStakeId: stake.id, userId: o.userId },
          data: { heldAt: new Date() },
        });
        await ledgerService.applyEntry(tx, oWallet.id, {
          type: 'STAKE_HOLD',
          availableDeltaMinor: -750n,
          heldDeltaMinor: 750n,
          relatedMatchStakeId: stake.id,
        });
      });
      expect(await heldBalance(o.userId)).toBe(750n);

      const anomalies = await run();
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]).toMatchObject({
        type: 'STRANDED_HOLD',
        userId: o.userId,
      });
      // None of the pre-existing checks would have caught it on their own.
      expect(anomalies.some((a) => a.type === 'ORPHANED_HOLD')).toBe(false);
      expect(anomalies.some((a) => a.type === 'MISSING_SETTLEMENT')).toBe(
        false,
      );
    }, 20000);
  });

  describe('disconnect forfeit settles like a win', () => {
    it('awards the connected player a forfeit win and settles it', async () => {
      const { matchId, x, o } = await createStakedMatch('forfeit', '600');
      await confirmBothAndActivate(matchId, x, o);

      await prisma.matchPlayer.updateMany({
        where: { matchId, userId: o.userId },
        data: { disconnectedAt: new Date(Date.now() - 60_000) },
      });
      await matchTimeoutService.sweep();

      const match = await request(app.getHttpServer())
        .get(`/api/v1/matches/${matchId}`)
        .set('Authorization', `Bearer ${x.accessToken}`)
        .expect(200);
      expect(match.body.status).toBe('ABANDONED');
      expect(match.body.winnerUserId).toBe(x.userId);

      const view = await financial(x.accessToken, matchId).expect(200);
      expect(view.body.settlement.outcome).toBe('WIN');
      expect(await heldBalance(x.userId)).toBe(0n);
      expect(await heldBalance(o.userId)).toBe(0n);
    });
  });

  describe('eligibility and validation (via a staked challenge — no Redis needed)', () => {
    it('rejects a stake below the configured minimum', async () => {
      const a = await registerUser('stakemin');
      const b = await registerUser('stakeminopp');
      await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: b.userId,
          stake: { amountMinor: '1', currency: 'SLE' },
        })
        .expect(422);
    });

    it('rejects a user under the real-money minimum age', async () => {
      const tooYoung = new Date();
      tooYoung.setFullYear(tooYoung.getFullYear() - 17);
      const a = await registerUser(
        'stakeyoung',
        tooYoung.toISOString().slice(0, 10),
      );
      const b = await registerUser('stakeyoungopp');
      await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: b.userId,
          stake: { amountMinor: '1000', currency: 'SLE' },
        })
        .expect(403);
    });

    it('rejects staking more than the available balance', async () => {
      const a = await registerUser('stakepoor');
      const b = await registerUser('stakepooropp');
      await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: b.userId,
          stake: { amountMinor: '1000', currency: 'SLE' },
        })
        .expect(422);
    });
  });

  describe('security', () => {
    it('404s a non-participant reading the financial view (IDOR)', async () => {
      const { matchId } = await createStakedMatch('idorfin', '1000');
      const outsider = await registerUser('idorfinoutsider');

      await financial(outsider.accessToken, matchId).expect(404);
    });

    it('404s a non-participant trying to confirm a stake they have no part in', async () => {
      const { matchId } = await createStakedMatch('idorconfirm', '1000');
      const outsider = await registerUser('idorconfirmoutsider');

      await confirmStake(outsider.accessToken, matchId).expect(404);
    });

    it('is idempotent and concurrency-safe against a double confirm by the same player', async () => {
      const { matchId, x, o } = await createStakedMatch(
        'doubleconfirm',
        '1000',
      );
      const before = await availableBalance(x.userId);

      const [first, second] = await Promise.all([
        confirmStake(x.accessToken, matchId),
        confirmStake(x.accessToken, matchId),
      ]);
      expect([first.status, second.status]).toEqual([200, 200]);

      // Exactly one hold — not two.
      expect(await availableBalance(x.userId)).toBe(before - 1000n);
      expect(await heldBalance(x.userId)).toBe(1000n);

      await confirmStake(o.accessToken, matchId).expect(200);
    });
  });

  describe('disputes', () => {
    it('lets a participant open a dispute on a completed match, visible to admin, resolvable without moving money', async () => {
      const { matchId, x, o, admin } = await createStakedMatch(
        'dispute',
        '400',
      );
      await confirmBothAndActivate(matchId, x, o);
      await playToWin(matchId, x, o);

      const loserBalance = await availableBalance(o.userId);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/matches/${matchId}/dispute`)
        .set('Authorization', `Bearer ${o.accessToken}`)
        .send({ reason: 'I think there was a client-side rendering glitch' })
        .expect(201);
      expect(created.body.status).toBe('OPEN');

      // Duplicate open dispute by the same user is rejected.
      await request(app.getHttpServer())
        .post(`/api/v1/matches/${matchId}/dispute`)
        .set('Authorization', `Bearer ${o.accessToken}`)
        .send({ reason: 'Filing again just in case' })
        .expect(409);

      // An outsider cannot dispute a match they weren't in (IDOR).
      const outsider = await registerUser('disputeoutsider');
      await request(app.getHttpServer())
        .post(`/api/v1/matches/${matchId}/dispute`)
        .set('Authorization', `Bearer ${outsider.accessToken}`)
        .send({ reason: 'Not my match but trying anyway' })
        .expect(404);

      const resolved = await request(app.getHttpServer())
        .post(`/api/v1/admin/disputes/${created.body.id}/resolve`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          status: 'RESOLVED',
          resolution: 'Reviewed the match log — result stands as played',
        })
        .expect(200);
      expect(resolved.body.status).toBe('RESOLVED');

      // Resolving a dispute never itself moves money.
      expect(await availableBalance(o.userId)).toBe(loserBalance);

      // Resolving again is rejected — already final.
      await request(app.getHttpServer())
        .post(`/api/v1/admin/disputes/${created.body.id}/resolve`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ status: 'RESOLVED', resolution: 'Trying to resolve twice' })
        .expect(403);
    });
  });

  describe('admin visibility', () => {
    it("lets an admin inspect any match's full financial detail, no participant restriction", async () => {
      const { matchId, x, o, admin } = await createStakedMatch(
        'adminfin',
        '900',
      );
      await confirmBothAndActivate(matchId, x, o);
      await playToWin(matchId, x, o);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/admin/matches/${matchId}/financial`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      expect(res.body.stake.status).toBe('SETTLED');
      expect(res.body.settlement.outcome).toBe('WIN');
      expect(res.body.settlement.poolAmountMinor).toBe('1800');
    });

    it('rejects a non-admin from the financial admin routes', async () => {
      const { matchId } = await createStakedMatch('adminfinauth', '100');
      const notAdmin = await registerUser('notadmin');

      await request(app.getHttpServer())
        .get(`/api/v1/admin/matches/${matchId}/financial`)
        .set('Authorization', `Bearer ${notAdmin.accessToken}`)
        .expect(403);
    });
  });

  describe('reconciliation', () => {
    it('reports no anomaly after a normal settled lifecycle', async () => {
      const { matchId, x, o, admin } = await createStakedMatch('recon', '300');
      await confirmBothAndActivate(matchId, x, o);
      await playToWin(matchId, x, o);

      const report = await request(app.getHttpServer())
        .get('/api/v1/admin/reconciliation/run')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      const relevant = report.body.anomalies.filter(
        (a: { matchId?: string }) => a.matchId === matchId,
      );
      expect(relevant).toHaveLength(0);
    });
  });
});
