import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { WalletService } from '../wallet/wallet.service.js';
import { DepositsService } from '../deposits/deposits.service.js';
import { WithdrawalsService } from '../withdrawals/withdrawals.service.js';
import { AdminFinanceService } from './admin-finance.service.js';
import { AdjustWalletDto } from './dto/adjust-wallet.dto.js';
import { ReviewWithdrawalDto } from '../withdrawals/dto/review-withdrawal.dto.js';
import {
  toWalletResponse,
  WalletResponseDto,
} from '../wallet/dto/wallet-response.dto.js';
import {
  toLedgerEntryResponse,
  LedgerEntryResponseDto,
} from '../wallet/dto/ledger-entry-response.dto.js';
import {
  toDepositResponse,
  DepositResponseDto,
} from '../deposits/dto/deposit-response.dto.js';
import {
  toWithdrawalResponse,
  WithdrawalResponseDto,
} from '../withdrawals/dto/withdrawal-response.dto.js';
import {
  AdminLedgerQueryDto,
  AdminDepositsQueryDto,
  AdminWithdrawalsQueryDto,
} from './dto/admin-list-query.dto.js';

/**
 * Financial admin visibility + withdrawal approval. Reuses the exact
 * `JwtAuthGuard` + `RolesGuard` + `@Roles()` primitives from Phase 2 — no
 * second authentication/authorization mechanism. This is the narrow
 * financial slice of the future "Admin" module boundary, not a general
 * administration system (see CLAUDE.md "what not to build yet").
 */
@ApiTags('admin-finance')
@Controller({ path: 'admin', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@ApiBearerAuth()
export class AdminFinanceController {
  constructor(
    private readonly walletService: WalletService,
    private readonly depositsService: DepositsService,
    private readonly withdrawalsService: WithdrawalsService,
    private readonly adminFinanceService: AdminFinanceService,
  ) {}

  @Get('wallets/:userId')
  @ApiOperation({ summary: "A user's wallet balances (admin)." })
  @ApiResponse({ status: 200, type: WalletResponseDto })
  async getWallet(@Param('userId') userId: string): Promise<WalletResponseDto> {
    const wallet = await this.walletService.getByUserId(userId);
    return toWalletResponse(wallet);
  }

  @Post('wallets/:userId/adjustments')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Credit or debit a wallet with a mandatory, audited reason. The only balance-editing path besides deposits/withdrawals.',
  })
  @ApiResponse({ status: 200, type: WalletResponseDto })
  @ApiResponse({
    status: 422,
    description: 'A DEBIT exceeding available balance.',
  })
  async adjustWallet(
    @CurrentUser() admin: User,
    @Param('userId') userId: string,
    @Body() dto: AdjustWalletDto,
  ): Promise<WalletResponseDto> {
    const wallet = await this.adminFinanceService.adjustWallet(
      admin.id,
      userId,
      dto.direction,
      dto.amountMinor,
      dto.reason,
    );
    return toWalletResponse(wallet);
  }

  @Get('ledger')
  @ApiOperation({
    summary: 'Ledger entries, optionally filtered by userId (admin).',
  })
  @ApiResponse({ status: 200, type: [LedgerEntryResponseDto] })
  async listLedger(
    @Query() query: AdminLedgerQueryDto,
  ): Promise<{ items: LedgerEntryResponseDto[]; nextCursor: string | null }> {
    const page = await this.walletService.listLedgerEntriesAdmin({
      userId: query.userId,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.map(toLedgerEntryResponse),
      nextCursor: page.nextCursor,
    };
  }

  @Get('deposits')
  @ApiOperation({
    summary: 'List deposits, optionally filtered by userId (admin).',
  })
  @ApiResponse({ status: 200, type: [DepositResponseDto] })
  async listDeposits(
    @Query() query: AdminDepositsQueryDto,
  ): Promise<{ items: DepositResponseDto[]; nextCursor: string | null }> {
    const page = await this.depositsService.listAdmin({
      userId: query.userId,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.map(toDepositResponse),
      nextCursor: page.nextCursor,
    };
  }

  @Get('withdrawals')
  @ApiOperation({
    summary: 'List withdrawals, optionally filtered by userId/status (admin).',
  })
  @ApiResponse({ status: 200, type: [WithdrawalResponseDto] })
  async listWithdrawals(
    @Query() query: AdminWithdrawalsQueryDto,
  ): Promise<{ items: WithdrawalResponseDto[]; nextCursor: string | null }> {
    const page = await this.withdrawalsService.listAdmin({
      userId: query.userId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.map(toWithdrawalResponse),
      nextCursor: page.nextCursor,
    };
  }

  @Post('withdrawals/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a withdrawal awaiting review.' })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  async approve(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Body() dto: ReviewWithdrawalDto,
  ): Promise<WithdrawalResponseDto> {
    const withdrawal = await this.withdrawalsService.approve(
      admin.id,
      id,
      dto.reason,
    );
    return toWithdrawalResponse(withdrawal);
  }

  @Post('withdrawals/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a withdrawal awaiting review; releases the hold.',
  })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  async reject(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Body() dto: ReviewWithdrawalDto,
  ): Promise<WithdrawalResponseDto> {
    const withdrawal = await this.withdrawalsService.reject(
      admin.id,
      id,
      dto.reason,
    );
    return toWithdrawalResponse(withdrawal);
  }

  @Post('withdrawals/:id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm a payout was sent for an approved withdrawal.',
  })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  async complete(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Body() dto: ReviewWithdrawalDto,
  ): Promise<WithdrawalResponseDto> {
    const withdrawal = await this.withdrawalsService.complete(
      admin.id,
      id,
      dto.reason,
    );
    return toWithdrawalResponse(withdrawal);
  }

  @Post('withdrawals/:id/fail')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark an approved withdrawal as failed; releases the hold.',
  })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  async fail(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Body() dto: ReviewWithdrawalDto,
  ): Promise<WithdrawalResponseDto> {
    const withdrawal = await this.withdrawalsService.fail(
      admin.id,
      id,
      dto.reason,
    );
    return toWithdrawalResponse(withdrawal);
  }
}
