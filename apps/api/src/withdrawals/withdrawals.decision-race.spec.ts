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
    operations: [] as Array<{ status: string }>,
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
      create: vi.fn(() => {
        db.operations.push({ status: 'PENDING' });
        return Promise.resolve({ id: 'op-1' });
      }),
      update: vi.fn((args: { data: { status?: string } }) => {
        Object.assign(db.operations[db.operations.length - 1], args.data);
        return Promise.resolve({});
      }),
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

  // What the payout provider answers, and an optional park while its call is
  // "in flight" (the request has been sent; the reply has not come back).
  let providerAnswer: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'NETWORK_ERROR' =
    'PENDING';
  const setProviderAnswer = (answer: typeof providerAnswer) => {
    providerAnswer = answer;
  };
  let inFlight: { reached: () => void; released: Promise<void> } | null = null;
  const armInFlight = () => {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((r) => (reached = r));
    const released = new Promise<void>((r) => (release = r));
    inFlight = { reached, released };
    return { reached: reachedPromise, release };
  };
  const provider = {
    name: 'FAKE',
    initiatePayout: vi.fn(async () => {
      // What a separate connection would see at this instant: only committed
      // state, and no transaction still open.
      db.payouts.push({
        statusWhenSubmitted: db.withdrawal.status,
        openTx: db.openTransactions,
      });
      const parked = inFlight;
      if (parked) {
        inFlight = null;
        parked.reached();
        await parked.released;
      }
      if (providerAnswer === 'NETWORK_ERROR') {
        throw new Error('fake network error');
      }
      return providerAnswer === 'FAILED'
        ? {
            providerReference: 'po-1',
            outcome: 'FAILED' as const,
            failureReason: 'rejected',
          }
        : { providerReference: 'po-1', outcome: providerAnswer };
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
  return {
    db,
    prisma,
    ledgerService,
    notificationOutbox,
    provider,
    service,
    armGate,
    armInFlight,
    setProviderAnswer,
  };
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

describe('a payout submission racing a terminal outcome', () => {
  /**
   * `approve` has committed its claim and `submitPayout` has sent the request:
   * the provider call is in flight and the withdrawal is still APPROVED. An
   * admin finalises it by hand (`complete`/`fail` are allowed from APPROVED)
   * before the reply returns. The reply must not drag the withdrawal back to
   * PROCESSING: that would let a later payout event debit or release the hold
   * a second time.
   */
  async function adminFinalisesWhileInFlight(
    h: Harness,
    finalise: () => Promise<unknown>,
  ) {
    const call = h.armInFlight();
    const approval = settle(h.service.approve('admin-1', 'wd-1', 'ok'));
    await call.reached;
    expect(h.db.withdrawal.status).toBe('APPROVED');
    const adminOutcome = await settle(finalise());
    call.release();
    return { approval: await approval, admin: adminOutcome };
  }

  const complete = (h: Harness) => () =>
    h.service.complete('admin-1', 'wd-1', 'paid by hand');
  const fail = (h: Harness) => () =>
    h.service.fail('admin-1', 'wd-1', 'could not pay');

  it('an admin completion during the call is not overwritten, and a later payout event debits nothing more', async () => {
    const h = build();

    const result = await adminFinalisesWhileInFlight(h, complete(h));

    expect(result.admin.ok).toBe(true);
    expect(result.approval.ok).toBe(true);
    expect(h.db.withdrawal.status).toBe('COMPLETED');
    expect(h.db.entries).toEqual(['WITHDRAWAL']);
    // The provider's own completion event then arrives for the reference.
    await h.service.completeFromProviderEvent('wd-1', 'po-1');
    expect(h.db.entries).toEqual(['WITHDRAWAL']);
    expect(h.db.held).toBe(OTHER_HOLD);
    expect(h.notificationOutbox.enqueueStandalone).not.toHaveBeenCalled();
  });

  it('an admin failure during the call is not overwritten, and the provider answering SUCCEEDED debits a hold already released', async () => {
    const h = build();
    h.setProviderAnswer('SUCCEEDED');

    const result = await adminFinalisesWhileInFlight(h, fail(h));

    expect(result.admin.ok).toBe(true);
    expect(h.db.withdrawal.status).toBe('FAILED');
    expect(h.db.entries).toEqual(['RELEASE']);
    expect(h.db.available).toBe(10_000n);
    expect(h.db.held).toBe(OTHER_HOLD);
  });

  it('an admin completion during the call is not overwritten when the call ends in an unknown outcome, which is still recorded', async () => {
    const h = build();
    h.setProviderAnswer('NETWORK_ERROR');

    const result = await adminFinalisesWhileInFlight(h, complete(h));

    expect(result.admin.ok).toBe(true);
    expect(h.db.withdrawal.status).toBe('COMPLETED');
    expect(h.db.entries).toEqual(['WITHDRAWAL']);
    // The safeguard is intact: the attempt is on record as UNKNOWN, never retried.
    expect(h.db.operations).toEqual([
      expect.objectContaining({ status: 'UNKNOWN' }),
    ]);
    expect(h.provider.initiatePayout).toHaveBeenCalledTimes(1);
  });

  it('the provider operation still records what the provider answered', async () => {
    const h = build();
    h.setProviderAnswer('SUCCEEDED');

    await adminFinalisesWhileInFlight(h, complete(h));

    expect(h.db.operations).toEqual([
      expect.objectContaining({ status: 'SUCCEEDED' }),
    ]);
    expect(h.db.entries).toEqual(['WITHDRAWAL']);
  });
});

describe('an uncontended payout submission is unchanged', () => {
  it('a pending answer leaves the withdrawal PROCESSING with the provider reference and announces it', async () => {
    const h = build();

    const result = await h.service.approve('admin-1', 'wd-1', 'ok');

    expect(result.status).toBe('PROCESSING');
    expect(h.db.withdrawal.providerReference).toBe('po-1');
    expect(h.db.operations).toEqual([
      expect.objectContaining({ status: 'PENDING' }),
    ]);
    expect(h.notificationOutbox.enqueueStandalone).toHaveBeenCalledTimes(1);
  });

  it('a synchronous SUCCEEDED answer completes the withdrawal once', async () => {
    const h = build();
    h.setProviderAnswer('SUCCEEDED');

    const result = await h.service.approve('admin-1', 'wd-1', 'ok');

    expect(result.status).toBe('COMPLETED');
    expect(h.db.entries).toEqual(['WITHDRAWAL']);
  });

  it('a synchronous FAILED answer fails the withdrawal and releases the hold once', async () => {
    const h = build();
    h.setProviderAnswer('FAILED');

    const result = await h.service.approve('admin-1', 'wd-1', 'ok');

    expect(result.status).toBe('FAILED');
    expect(h.db.entries).toEqual(['RELEASE']);
  });

  it('an unknown outcome leaves the withdrawal PROCESSING, the hold in place and the attempt UNKNOWN', async () => {
    const h = build();
    h.setProviderAnswer('NETWORK_ERROR');

    const result = await h.service.approve('admin-1', 'wd-1', 'ok');

    expect(result.status).toBe('PROCESSING');
    expect(h.db.entries).toEqual([]);
    expect(h.db.operations).toEqual([
      expect.objectContaining({ status: 'UNKNOWN' }),
    ]);
    expect(h.provider.initiatePayout).toHaveBeenCalledTimes(1);
  });
});
