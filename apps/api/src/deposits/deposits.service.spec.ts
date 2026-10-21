import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DepositsService } from './deposits.service.js';

/**
 * `completeFromProviderEvent` must credit a deposit at most once, even when
 * several completions all read it as PENDING before any of them commits. The
 * claim is a conditional PENDING -> COMPLETED update inside the transaction;
 * only the caller whose update matches a row may credit the wallet or enqueue
 * the notification. The database is replaced by fakes here; the real
 * interleaving against Postgres is `test/wallet.e2e-spec.ts` (CI only).
 */

const DEPOSIT_ID = 'deposit-1';

const pendingDeposit = {
  id: DEPOSIT_ID,
  userId: 'user-1',
  amountMinor: 4000n,
  currency: 'SLE',
  status: 'PENDING',
  providerReference: 'ref-1',
};

function build(opts: {
  initial?: typeof pendingDeposit | null;
  claimCount?: number;
}) {
  const completed = { ...pendingDeposit, status: 'COMPLETED' };
  const initial =
    opts.initial === undefined ? { ...pendingDeposit } : opts.initial;
  const tx = {
    deposit: {
      updateMany: vi.fn(() => Promise.resolve({ count: opts.claimCount ?? 1 })),
      findUniqueOrThrow: vi.fn(() => Promise.resolve(completed)),
    },
  };
  const prisma = {
    deposit: { findUnique: vi.fn(() => Promise.resolve(initial)) },
    $transaction: vi.fn((fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const ledgerService = { applyEntry: vi.fn(() => Promise.resolve({})) };
  const walletService = {
    getWalletIdForUser: vi.fn(() => Promise.resolve('wallet-1')),
  };
  const notificationOutbox = { enqueue: vi.fn(() => Promise.resolve()) };

  const service = new DepositsService(
    prisma as never,
    ledgerService as never,
    walletService as never,
    {} as never,
    {} as never,
    {} as never,
    notificationOutbox as never,
  );
  return { service, tx, prisma, ledgerService, notificationOutbox, completed };
}

describe('DepositsService.completeFromProviderEvent', () => {
  it('claims the deposit conditionally on PENDING, then credits once', async () => {
    const { service, tx, ledgerService, notificationOutbox, completed } = build(
      {},
    );

    const result = await service.completeFromProviderEvent(DEPOSIT_ID, 'ref-1');

    expect(tx.deposit.updateMany).toHaveBeenCalledWith({
      where: { id: DEPOSIT_ID, status: 'PENDING' },
      data: expect.objectContaining({
        status: 'COMPLETED',
        providerReference: 'ref-1',
      }),
    });
    expect(ledgerService.applyEntry).toHaveBeenCalledTimes(1);
    expect(ledgerService.applyEntry).toHaveBeenCalledWith(tx, 'wallet-1', {
      type: 'DEPOSIT',
      availableDeltaMinor: 4000n,
      heldDeltaMinor: 0n,
      currency: 'SLE',
      relatedDepositId: DEPOSIT_ID,
      providerReference: 'ref-1',
    });
    expect(notificationOutbox.enqueue).toHaveBeenCalledTimes(1);
    expect(result).toBe(completed);
    // The claim comes before the credit.
    expect(tx.deposit.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      ledgerService.applyEntry.mock.invocationCallOrder[0],
    );
  });

  it('does not credit or notify when another transaction already claimed it', async () => {
    // Both callers read PENDING; this one lost the conditional update.
    const { service, tx, ledgerService, notificationOutbox, completed } = build(
      { claimCount: 0 },
    );

    const result = await service.completeFromProviderEvent(DEPOSIT_ID, 'ref-1');

    expect(tx.deposit.updateMany).toHaveBeenCalledTimes(1);
    expect(ledgerService.applyEntry).not.toHaveBeenCalled();
    expect(notificationOutbox.enqueue).not.toHaveBeenCalled();
    // Returns the deposit as it now stands.
    expect(tx.deposit.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: DEPOSIT_ID },
    });
    expect(result).toBe(completed);
  });

  it('keeps the stored provider reference when the event carries none', async () => {
    const { service, tx } = build({});

    await service.completeFromProviderEvent(DEPOSIT_ID, undefined);

    expect(tx.deposit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ providerReference: 'ref-1' }),
      }),
    );
  });

  it('returns an already-completed deposit without opening a transaction', async () => {
    const done = { ...pendingDeposit, status: 'COMPLETED' };
    const { service, prisma, ledgerService } = build({ initial: done });

    const result = await service.completeFromProviderEvent(DEPOSIT_ID, 'ref-1');

    expect(result).toBe(done);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(ledgerService.applyEntry).not.toHaveBeenCalled();
  });

  it('throws NotFound for an unknown deposit', async () => {
    const { service, prisma } = build({ initial: null });

    await expect(
      service.completeFromProviderEvent(DEPOSIT_ID, 'ref-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

/**
 * `markFailed` / `markExpired` must never overwrite a deposit that a
 * concurrent completion (or another terminal event) already moved off
 * PENDING. Same conditional-claim shape as the completion, and the failure
 * notice is written in the claim's own transaction, only when the claim won.
 */
describe('DepositsService.markFailed / markExpired', () => {
  it('markFailed claims conditionally on PENDING and enqueues the notice in the same transaction', async () => {
    const { service, tx, prisma, notificationOutbox, completed } = build({});

    const result = await service.markFailed(DEPOSIT_ID, 'card declined');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.deposit.updateMany).toHaveBeenCalledWith({
      where: { id: DEPOSIT_ID, status: 'PENDING' },
      data: expect.objectContaining({
        status: 'FAILED',
        failureReason: 'card declined',
      }),
    });
    expect(notificationOutbox.enqueue).toHaveBeenCalledTimes(1);
    // The transactional API with the same client - not the standalone one.
    expect(notificationOutbox.enqueue).toHaveBeenCalledWith(tx, {
      userId: 'user-1',
      type: 'DEPOSIT_FAILED',
      payload: {
        depositId: DEPOSIT_ID,
        amountMinor: '4000',
        currency: 'SLE',
        reason: 'card declined',
      },
    });
    expect(result).toBe(completed);
  });

  it('markFailed neither overwrites nor notifies when the claim is lost', async () => {
    const { service, tx, notificationOutbox, completed } = build({
      claimCount: 0,
    });

    const result = await service.markFailed(DEPOSIT_ID, 'card declined');

    expect(tx.deposit.updateMany).toHaveBeenCalledTimes(1);
    expect(notificationOutbox.enqueue).not.toHaveBeenCalled();
    expect(tx.deposit.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: DEPOSIT_ID },
    });
    expect(result).toBe(completed);
  });

  it('markFailed returns an already-settled deposit without a transaction', async () => {
    const done = { ...pendingDeposit, status: 'COMPLETED' };
    const { service, prisma, notificationOutbox } = build({ initial: done });

    expect(await service.markFailed(DEPOSIT_ID, 'x')).toBe(done);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notificationOutbox.enqueue).not.toHaveBeenCalled();
  });

  it('markFailed throws NotFound for an unknown deposit', async () => {
    const { service } = build({ initial: null });

    await expect(service.markFailed(DEPOSIT_ID, 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('markExpired claims conditionally on PENDING and sends no notice', async () => {
    const { service, tx, notificationOutbox, completed } = build({});

    const result = await service.markExpired(DEPOSIT_ID);

    expect(tx.deposit.updateMany).toHaveBeenCalledWith({
      where: { id: DEPOSIT_ID, status: 'PENDING' },
      data: expect.objectContaining({ status: 'EXPIRED' }),
    });
    expect(notificationOutbox.enqueue).not.toHaveBeenCalled();
    expect(result).toBe(completed);
  });

  it('markExpired returns the current deposit when the claim is lost', async () => {
    const { service, tx, completed } = build({ claimCount: 0 });

    const result = await service.markExpired(DEPOSIT_ID);

    expect(tx.deposit.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.deposit.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: DEPOSIT_ID },
    });
    expect(result).toBe(completed);
  });

  it('markExpired returns an already-settled deposit without a transaction', async () => {
    const done = { ...pendingDeposit, status: 'COMPLETED' };
    const { service, prisma } = build({ initial: done });

    expect(await service.markExpired(DEPOSIT_ID)).toBe(done);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('markExpired throws NotFound for an unknown deposit', async () => {
    const { service } = build({ initial: null });

    await expect(service.markExpired(DEPOSIT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
