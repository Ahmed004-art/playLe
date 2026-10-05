import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { WalletService } from './wallet.service.js';
import {
  toWalletResponse,
  WalletResponseDto,
} from './dto/wallet-response.dto.js';
import {
  toLedgerEntryResponse,
  LedgerEntryResponseDto,
} from './dto/ledger-entry-response.dto.js';
import { PaginationQueryDto } from '../common/dto/pagination.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';

@ApiTags('wallet')
@Controller({ path: 'wallet', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  @ApiOperation({ summary: "The authenticated user's own wallet balances." })
  @ApiResponse({ status: 200, type: WalletResponseDto })
  async getWallet(@CurrentUser() user: User): Promise<WalletResponseDto> {
    const wallet = await this.walletService.getByUserId(user.id);
    return toWalletResponse(wallet);
  }

  @Get('transactions')
  @ApiOperation({
    summary: "The authenticated user's own ledger history, newest first.",
  })
  @ApiResponse({ status: 200, type: [LedgerEntryResponseDto] })
  async getTransactions(
    @CurrentUser() user: User,
    @Query() query: PaginationQueryDto,
  ): Promise<{ items: LedgerEntryResponseDto[]; nextCursor: string | null }> {
    const page = await this.walletService.listLedgerEntries(user.id, query);
    return {
      items: page.items.map(toLedgerEntryResponse),
      nextCursor: page.nextCursor,
    };
  }
}
