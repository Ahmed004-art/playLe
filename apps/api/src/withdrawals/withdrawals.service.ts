import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Withdrawal, type WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { parseAmountMinor } from '../common/money.js';
import type { CursorPage } from '../common/dto/pagination.dto.js';
import type { AppConfiguration } from '../config/configuration.js';

@Injectable()
export class WithdrawalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly walletService: WalletService,
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  async create(
    userId: string,
    amountMinorStr: string,
    destinationDetails: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<Withdrawal> {
    const amountMinor = parseAmountMinor(amountMinorStr);
    const minWithdrawal = this.configService.get(
      'payments.minWithdrawalMinor',
      { infer: true },
    );

    if (amountMinor < minWithdrawal) {
      throw new UnprocessableEntityException(
        `Minimum withdrawal is ${minWithdrawal} minor units`,
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const walletId = await this.walletService.getWalletIdForUser(
          tx,
          userId,
        );

        const withdrawal = await tx.withdrawal.create({
          data: {
            userId,
            walletId,
            amountMinor,
            destinationDetails: destinationDetails as Prisma.InputJsonValue,
            idempotencyKey,
          },
        });

        // Atomically move funds from available to held so they can never
        // be simultaneously withdrawn twice or spent elsewhere.
        await this.ledgerService.applyEntry(tx, walletId, {
          type: 'HOLD',
          availableDeltaMinor: -amountMinor,
          heldDeltaMinor: amountMinor,
          relatedWithdrawalId: withdrawal.id,
        });

        return withdrawal;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.withdrawal.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
        });
        if (existing) return existing;
      }
      throw error;
    }
  }

  async findById(userId: string, id: string): Promise<Withdrawal> {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
    });
    if (!withdrawal || withdrawal.userId !== userId) {
      throw new NotFoundException('Withdrawal not found');
    }
    return withdrawal;
  }

  async findByIdAdmin(id: string): Promise<Withdrawal> {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
    });
    if (!withdrawal) {
      throw new NotFoundException('Withdrawal not found');
    }
    return withdrawal;
  }

  async list(
    userId: string,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<Withdrawal>> {
    return this.listInternal({ userId }, { cursor, limit });
  }

  async listAdmin(params: {
    userId?: string;
    status?: WithdrawalStatus;
    cursor?: string;
    limit: number;
  }): Promise<CursorPage<Withdrawal>> {
    const { cursor, limit, ...where } = params;
    return this.listInternal(where, { cursor, limit });
  }

  private async listInternal(
    where: Prisma.WithdrawalWhereInput,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<Withdrawal>> {
    const withdrawals = await this.prisma.withdrawal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = withdrawals.length > limit;
    const items = hasMore ? withdrawals.slice(0, limit) : withdrawals;

    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /** A user may cancel their own request only while it's still awaiting review. */
  async cancel(userId: string, id: string): Promise<Withdrawal> {
    const withdrawal = await this.findById(userId, id);
    this.assertTransition(withdrawal.status, ['PENDING_REVIEW']);

    return this.prisma.$transaction(async (tx) => {
      await this.ledgerService.applyEntry(tx, withdrawal.walletId, {
        type: 'RELEASE',
        availableDeltaMinor: withdrawal.amountMinor,
        heldDeltaMinor: -withdrawal.amountMinor,
        relatedWithdrawalId: withdrawal.id,
      });

      return tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
    });
  }

  async approve(
    adminId: string,
    id: string,
    reason: string,
  ): Promise<Withdrawal> {
    const withdrawal = await this.findByIdAdmin(id);
    this.assertTransition(withdrawal.status, ['PENDING_REVIEW']);

    return this.prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        reviewedByAdminId: adminId,
        reviewedAt: new Date(),
        reviewReason: reason,
      },
    });
  }

  async reject(
    adminId: string,
    id: string,
    reason: string,
  ): Promise<Withdrawal> {
    const withdrawal = await this.findByIdAdmin(id);
    this.assertTransition(withdrawal.status, ['PENDING_REVIEW']);

    return this.prisma.$transaction(async (tx) => {
      await this.ledgerService.applyEntry(tx, withdrawal.walletId, {
        type: 'RELEASE',
        availableDeltaMinor: withdrawal.amountMinor,
        heldDeltaMinor: -withdrawal.amountMinor,
        relatedWithdrawalId: withdrawal.id,
      });

      return tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: 'REJECTED',
          rejectedAt: new Date(),
          reviewedByAdminId: adminId,
          reviewedAt: new Date(),
          reviewReason: reason,
        },
      });
    });
  }

  /** Funds permanently leave the system — the admin confirms the payout was sent. */
  async complete(
    adminId: string,
    id: string,
    reason: string,
    providerReference?: string,
  ): Promise<Withdrawal> {
    const withdrawal = await this.findByIdAdmin(id);
    this.assertTransition(withdrawal.status, ['APPROVED']);

    return this.prisma.$transaction(async (tx) => {
      await this.ledgerService.applyEntry(tx, withdrawal.walletId, {
        type: 'WITHDRAWAL',
        availableDeltaMinor: 0n,
        heldDeltaMinor: -withdrawal.amountMinor,
        relatedWithdrawalId: withdrawal.id,
        providerReference,
      });

      return tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          reviewedByAdminId: adminId,
          reviewedAt: new Date(),
          reviewReason: reason,
          providerReference,
        },
      });
    });
  }

  async fail(adminId: string, id: string, reason: string): Promise<Withdrawal> {
    const withdrawal = await this.findByIdAdmin(id);
    this.assertTransition(withdrawal.status, ['APPROVED']);

    return this.prisma.$transaction(async (tx) => {
      await this.ledgerService.applyEntry(tx, withdrawal.walletId, {
        type: 'RELEASE',
        availableDeltaMinor: withdrawal.amountMinor,
        heldDeltaMinor: -withdrawal.amountMinor,
        relatedWithdrawalId: withdrawal.id,
      });

      return tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: 'FAILED',
          failedAt: new Date(),
          failureReason: reason,
          reviewedByAdminId: adminId,
          reviewedAt: new Date(),
          reviewReason: reason,
        },
      });
    });
  }

  private assertTransition(
    current: WithdrawalStatus,
    allowedFrom: WithdrawalStatus[],
  ): void {
    if (!allowedFrom.includes(current)) {
      throw new ConflictException(
        `Cannot perform this action on a withdrawal in status ${current}`,
      );
    }
  }
}
