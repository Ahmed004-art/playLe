import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { WithdrawalsService } from './withdrawals.service.js';

/**
 * Review decisions on a `PENDING_REVIEW` withdrawal racing each other:
 * approve (which goes on to submit a payout), the user's cancel, and the admin's
 * reject. Exactly one may win; the loser must make no financial change, and a
 * payout may only be submitted for a withdrawal whose approval committed.
 *
 * The race is made deterministic with a one-shot gate rather than timing: the
 * "stale" actor has already read the withdrawal as PENDING_REVIEW and is held
 * at its first lock or write; the "winner" then runs to completion; only then is
 * the stale actor released. That is exactly the interleaving two overlapping
 * requests can produce, since every decision checks status outside its
 * transaction.
 *
 * The database is an in-memory model of the properties the code relies on:
 * writes apply as issued (an unconditional `update` overwrites whatever is
 * there, a conditional `updateMany` matches only its `where`), transactions roll
 * back on throw, and the ledger refuses a negative balance. Real behaviour
 * against Postgres is `test/payments-phase6.e2e-spec.ts` (CI only).
 */

const AMOUNT = 4000n;
/** Another pending withdrawal's hold on the same wallet. */
const OTHER_HOLD = 5000n;

function build() {
  const db = {
    withdrawal: {
      id: 'wd-1',
      userId: 'user-1',
      walletId: 'wallet-1',
      amountMinor: AMOUNT,
      currency: 'SLE',
      status: 'PENDING_REVIEW',
      providerReference: null as string | null,
      destinationDetails: { method: 'ORANGE_MONEY' },
    },
    // Another pending withdrawal's hold shares the wallet and is larger than
    // this one, so a hold released twice does not trip the non-negative check:
    // it would silently take the other withdrawal's funds.
    available: 6000n,
    held: AMOUNT + OTHER_HOLD,
    entries: [] as string[],
    openTransactions: 0,
    payouts: [] as Array<{ statusWhenSubmitted: string; openTx: number }>,
  };

  type Undo = Array<() => void>;
  const journals = new WeakMap<object, Undo>();
  const undoFor = (txClient: unknown): Undo =>
    journals.get(txClient as object) ?? [];

  // One-shot gate: the first lock or write after arming parks until released.
  let armed: { reached: () => void; released: Promise<void> } | null = null;
  const gateHere = async (): Promise<void> => {
    const gate = armed;
    if (!gate) return;
    armed = null;
    gate.reached();
    await gate.released;
  };
  const armGate = () => {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((r) => (reached = r));
    const released = new Promise<void>((r) => (release = r));
    armed = { reached, released };
    return { reached: reachedPromise, release };
  };

  const statusMatches = (
    want: string | { in: string[] } | undefined,
    actual: string,
  ) =>
    want === undefined ||
    (typeof want === 'string' ? want === actual : want.in.includes(actual));

  const applyStatus = (data: { status?: string }, undo?: Undo) => {
    const previous = { ...db.withdrawal };
    Object.assign(db.withdrawal, data);
    undo?.push(() => Object.assign(db.withdrawal, previous));
  };

  const withdrawalWrites = (undo?: Undo) => ({
    update: vi.fn(async (args: { data: { status?: string } }) => {
      await gateHere();
      applyStatus(args.data, undo);
      return { ...db.withdrawal };
    }),
    updateMany: vi.fn(
      async (args: {
        where: { status?: string | { in: string[] } };
        data: { status?: string };
      }) => {
        await gateHere();
        if (!statusMatches(args.where.status, db.withdrawal.status)) {
          return { count: 0 };
        }
        applyStatus(args.data, undo);
        return { count: 1 };
      },
    ),
    findUniqueOrThrow: vi.fn(() => Promise.resolve({ ...db.withdrawal })),
  });

  const prismaWrites = withdrawalWrites();
  const prisma = {
    withdrawal: {
      findUnique: vi.fn(() => Promise.resolve({ ...db.withdrawal })),
      ...prismaWrites,
    },
    providerOperation: {
      create: vi.fn(() => Promise.resolve({ id: 'op-1' })),
      update: vi.fn(() => Promise.resolve({})),
    },
    $transaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => {
      const undo: Undo = [];
      const tx = { withdrawal: withdrawalWrites(undo) };
      journals.set(tx, undo);
      db.openTransactions += 1;
      try {
        return await fn(tx);
      } catch (error) {
        undo.reverse().forEach((step) => step());
        throw error;
      } finally {
        db.openTransactions -= 1;
      }
    }),
  };

  const ledgerService = {
    lockWallet: vi.fn(async () => {
      await gateHere();
      return {};
    }),
    applyEntry: vi.fn(
      async (
        txClient: unknown,
        _walletId: string,
        p: {
          type: string;
          availableDeltaMinor: bigint;
          heldDeltaMinor: bigint;
        },
      ) => {
        await gateHere();
        const available = db.available + p.availableDeltaMinor;
        const held = db.held + p.heldDeltaMinor;
        if (available < 0n || held < 0n) {
          throw new Error('Insufficient balance');
        }
        const before = { available: db.available, held: db.held };
        db.available = available;
        db.held = held;
        db.entries.push(p.type);
        undoFor(txClient).push(() => {
          db.available = before.available;
          db.held = before.held;
          db.entries.splice(db.entries.lastIndexOf(p.type), 1);
        });
        return {};
      },
    ),
  };

  const provider = {
    name: 'FAKE',
    initiatePayout: vi.fn(() => {
      // What a separate connection would see at this instant: only committed
      // state, and no transaction still open.
      db.payouts.push({
        statusWhenSubmitted: db.withdrawal.status,
        openTx: db.openTransactions,
      });
      return Promise.resolve({
        providerReference: 'po-1',
        outcome: 'PENDING' as const,
      });
    }),
  };
  const notificationOutbox = {
    enqueue: vi.fn(() => Promise.resolve()),
    enqueueStandalone: vi.fn(() => Promise.resolve()),
  };
  const service = new WithdrawalsService(
    prisma as never,
    ledgerService as never,
    {} as never,
    {} as never,
    provider as never,
    notificationOutbox as never,
  );
  return { db, prisma, ledgerService, provider, service, armGate };
}

type Harness = ReturnType<typeof build>;
type Outcome = { ok: true } | { ok: false; error: unknown };

const settle = (promise: Promise<unknown>): Promise<Outcome> =>
  promise.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/**
 * `stale` starts first and is parked at its first lock or write, having already
 * read the withdrawal as PENDING_REVIEW; `winner` then runs to completion; only
 * then is `stale` released.
 */
async function race(
  h: Harness,
  stale: () => Promise<unknown>,
  winner: () => Promise<unknown>,
): Promise<{ stale: Outcome; winner: Outcome }> {
  const gate = h.armGate();
  const stalePromise = settle(stale());
  await gate.reached;
  const winnerOutcome = await settle(winner());
  gate.release();
  return { stale: await stalePromise, winner: winnerOutcome };
}

const approve = (h: Harness) => () =>
  h.service.approve('admin-1', 'wd-1', 'Verified identity');
const cancel = (h: Harness) => () => h.service.cancel('user-1', 'wd-1');
const reject = (h: Harness) => () =>
  h.service.reject('admin-1', 'wd-1', 'Not eligible');

function expectConflict(outcome: Outcome): void {
  expect(outcome.ok).toBe(false);
  expect((outcome as { error: unknown }).error).toBeInstanceOf(
    ConflictException,
  );
}

describe('approval vs cancellation', () => {
  it('cancel wins, then a stale approval must not submit a payout or resurrect the withdrawal', async () => {
    const h = build();

    const result = await race(h, approve(h), cancel(h));

    expect(result.winner.ok).toBe(true);
    expect(h.provider.initiatePayout).not.toHaveBeenCalled();
    expect(h.db.withdrawal.status).toBe('CANCELLED');
    expect(h.db.entries).toEqual(['RELEASE']);
    expect(h.db.available).toBe(10_000n);
    expect(h.db.held).toBe(OTHER_HOLD);

    // The loser must be refused the usual way, after the money checks above.
    expectConflict(result.stale);
  });

  it('approval wins and proceeds to payout, then a stale cancel must not release the hold', async () => {
    const h = build();

    const result = await race(h, cancel(h), approve(h));

    expect(result.winner.ok).toBe(true);
    expect(h.provider.initiatePayout).toHaveBeenCalledTimes(1);
    expect(h.db.withdrawal.status).toBe('PROCESSING');
    expect(h.db.entries).toEqual([]);
    expect(h.db.available).toBe(6000n);
    expect(h.db.held).toBe(AMOUNT + OTHER_HOLD);

    // The loser must be refused the usual way, after the money checks above.
    expectConflict(result.stale);
  });
});

describe('approval vs rejection', () => {
  it('reject wins, then a stale approval must not submit a payout or resurrect the withdrawal', async () => {
    const h = build();

    const result = await race(h, approve(h), reject(h));

    expect(result.winner.ok).toBe(true);
    expect(h.provider.initiatePayout).not.toHaveBeenCalled();
    expect(h.db.withdrawal.status).toBe('REJECTED');
    expect(h.db.entries).toEqual(['RELEASE']);
    expect(h.db.held).toBe(OTHER_HOLD);

    // The loser must be refused the usual way, after the money checks above.
    expectConflict(result.stale);
  });

  it('approval wins and proceeds to payout, then a stale rejection must not release the hold', async () => {
    const h = build();

    const result = await race(h, reject(h), approve(h));

    expect(result.winner.ok).toBe(true);
    expect(h.provider.initiatePayout).toHaveBeenCalledTimes(1);
    expect(h.db.withdrawal.status).toBe('PROCESSING');
    expect(h.db.entries).toEqual([]);
    expect(h.db.held).toBe(AMOUNT + OTHER_HOLD);

    // The loser must be refused the usual way, after the money checks above.
    expectConflict(result.stale);
  });
});

describe('cancellation vs rejection', () => {
  it('cancel wins, then a stale rejection must not release the hold a second time', async () => {
    const h = build();

    const result = await race(h, reject(h), cancel(h));

    expect(result.winner.ok).toBe(true);
    expect(h.db.entries).toEqual(['RELEASE']);
    expect(h.db.withdrawal.status).toBe('CANCELLED');
    expect(h.db.held).toBe(OTHER_HOLD);
    expect(h.db.available).toBe(10_000n);

    // The loser must be refused the usual way, after the money checks above.
    expectConflict(result.stale);
  });

  it('reject wins, then a stale cancel must not release the hold a second time', async () => {
    const h = build();

    const result = await race(h, cancel(h), reject(h));

    expect(result.winner.ok).toBe(true);
    expect(h.db.entries).toEqual(['RELEASE']);
    expect(h.db.withdrawal.status).toBe('REJECTED');
    expect(h.db.held).toBe(OTHER_HOLD);
    expect(h.db.available).toBe(10_000n);

    // The loser must be refused the usual way, after the money checks above.
    expectConflict(result.stale);
  });
});

describe('a payout is only submitted for a committed approval', () => {
  it('submits after the approval is committed and no transaction is open', async () => {
    const h = build();

    await h.service.approve('admin-1', 'wd-1', 'Verified identity');

    expect(h.db.payouts).toEqual([
      { statusWhenSubmitted: 'APPROVED', openTx: 0 },
    ]);
    expect(h.db.withdrawal.status).toBe('PROCESSING');
    expect(h.db.withdrawal.providerReference).toBe('po-1');
  });
});

describe('uncontended decisions are unchanged', () => {
  it('approve submits one payout and leaves the hold in place', async () => {
    const h = build();

    const result = await h.service.approve('admin-1', 'wd-1', 'ok');

    expect(result.status).toBe('PROCESSING');
    expect(h.provider.initiatePayout).toHaveBeenCalledTimes(1);
    expect(h.db.entries).toEqual([]);
  });

  it('cancel releases the hold exactly once and submits nothing', async () => {
    const h = build();

    const result = await h.service.cancel('user-1', 'wd-1');

    expect(result.status).toBe('CANCELLED');
    expect(h.db.entries).toEqual(['RELEASE']);
    expect(h.provider.initiatePayout).not.toHaveBeenCalled();
  });

  it('reject releases the hold exactly once and submits nothing', async () => {
    const h = build();

    const result = await h.service.reject('admin-1', 'wd-1', 'no');

    expect(result.status).toBe('REJECTED');
    expect(h.db.entries).toEqual(['RELEASE']);
    expect(h.provider.initiatePayout).not.toHaveBeenCalled();
  });

  it.each([
    ['approve', approve],
    ['cancel', cancel],
    ['reject', reject],
  ] as const)(
    '%s of an already-decided withdrawal is the usual conflict, with no change',
    async (_name, act) => {
      const h = build();
      h.db.withdrawal.status = 'REJECTED';

      expectConflict(await settle(act(h)()));

      expect(h.db.entries).toEqual([]);
      expect(h.provider.initiatePayout).not.toHaveBeenCalled();
    },
  );
});
