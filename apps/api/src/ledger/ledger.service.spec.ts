import { randomUUID } from 'node:crypto';
import {
  UnprocessableEntityException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { LedgerService } from './ledger.service.js';

interface FakeWalletRow {
  id: string;
  userId: string;
  availableBalanceMinor: bigint;
  heldBalanceMinor: bigint;
  currency: string;
}

/**
 * A minimal fake `Prisma.TransactionClient` — enough surface area for
 * `LedgerService.applyEntry` (`$queryRaw`, `wallet.update`,
 * `ledgerEntry.create`). Mirrors the fake-Prisma pattern already used in
 * `token.service.spec.ts`. Real row-locking (`FOR UPDATE`) semantics are
 * verified against real Postgres in the e2e concurrency test instead —
 * this fake only exercises the balance/invariant logic.
 */
function createFakeTx(initialWallet: FakeWalletRow) {
  const wallet = { ...initialWallet };
  const ledgerEntries: unknown[] = [];

  return {
    tx: {
      $queryRaw: () => Promise.resolve([{ ...wallet }]),
      wallet: {
        update: ({ data }: { data: Partial<FakeWalletRow> }) => {
          Object.assign(wallet, data);
          return Promise.resolve({ ...wallet });
        },
      },
      ledgerEntry: {
        create: ({ data }: { data: Record<string, unknown> }) => {
          const entry = { id: randomUUID(), createdAt: new Date(), ...data };
          ledgerEntries.push(entry);
          return Promise.resolve(entry);
        },
      },
    } as any,
    wallet,
    ledgerEntries,
  };
}

describe('LedgerService.applyEntry', () => {
  let service: LedgerService;
  let initialWallet: FakeWalletRow;

  beforeEach(() => {
    service = new LedgerService();
    initialWallet = {
      id: 'wallet-1',
      userId: 'user-1',
      availableBalanceMinor: 10_000n,
      heldBalanceMinor: 0n,
      currency: 'SLE',
    };
  });

  it('applies a DEPOSIT by increasing available balance', async () => {
    const { tx, wallet } = createFakeTx(initialWallet);

    const result = await service.applyEntry(tx, 'wallet-1', {
      type: 'DEPOSIT',
      availableDeltaMinor: 5_000n,
      heldDeltaMinor: 0n,
    });

    expect(wallet.availableBalanceMinor).toBe(15_000n);
    expect(result.entry).toMatchObject({
      type: 'DEPOSIT',
      availableBalanceAfterMinor: 15_000n,
      heldBalanceAfterMinor: 0n,
    });
  });

  it('applies a HOLD by moving funds from available to held in one entry', async () => {
    const { tx, wallet } = createFakeTx(initialWallet);

    await service.applyEntry(tx, 'wallet-1', {
      type: 'HOLD',
      availableDeltaMinor: -4_000n,
      heldDeltaMinor: 4_000n,
    });

    expect(wallet.availableBalanceMinor).toBe(6_000n);
    expect(wallet.heldBalanceMinor).toBe(4_000n);
  });

  it('rejects an operation that would drive available balance negative', async () => {
    const { tx, wallet } = createFakeTx(initialWallet);

    await expect(
      service.applyEntry(tx, 'wallet-1', {
        type: 'WITHDRAWAL',
        availableDeltaMinor: -20_000n,
        heldDeltaMinor: 0n,
      }),
    ).rejects.toThrow(UnprocessableEntityException);

    // Rejected operations must not have partially mutated state.
    expect(wallet.availableBalanceMinor).toBe(10_000n);
  });

  it('rejects an operation that would drive held balance negative', async () => {
    const { tx } = createFakeTx(initialWallet);

    await expect(
      service.applyEntry(tx, 'wallet-1', {
        type: 'RELEASE',
        availableDeltaMinor: 0n,
        heldDeltaMinor: -1n,
      }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('requires a reason for ADJUSTMENT entries', async () => {
    const { tx } = createFakeTx(initialWallet);

    await expect(
      service.applyEntry(tx, 'wallet-1', {
        type: 'ADJUSTMENT',
        availableDeltaMinor: 1_000n,
        heldDeltaMinor: 0n,
      }),
    ).rejects.toThrow(UnprocessableEntityException);

    await expect(
      service.applyEntry(tx, 'wallet-1', {
        type: 'ADJUSTMENT',
        availableDeltaMinor: 1_000n,
        heldDeltaMinor: 0n,
        reason: '   ',
      }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('accepts an ADJUSTMENT entry with a reason and records the admin', async () => {
    const { tx } = createFakeTx(initialWallet);

    const result = await service.applyEntry(tx, 'wallet-1', {
      type: 'ADJUSTMENT',
      availableDeltaMinor: 2_000n,
      heldDeltaMinor: 0n,
      reason: 'Manual correction for failed provider event #123',
      createdByAdminId: 'admin-1',
    });

    expect(result.entry).toMatchObject({
      reason: 'Manual correction for failed provider event #123',
      createdByAdminId: 'admin-1',
    });
  });

  it('throws NotFoundException when the wallet row does not exist', async () => {
    const tx = {
      $queryRaw: () => Promise.resolve([]),
    } as any;

    await expect(
      service.applyEntry(tx, 'missing-wallet', {
        type: 'DEPOSIT',
        availableDeltaMinor: 1n,
        heldDeltaMinor: 0n,
      }),
    ).rejects.toThrow(NotFoundException);
  });
});
