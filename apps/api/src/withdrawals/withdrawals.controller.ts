import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { User } from '@prisma/client';
import { WithdrawalsService } from './withdrawals.service.js';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto.js';
import {
  toWithdrawalResponse,
  WithdrawalResponseDto,
} from './dto/withdrawal-response.dto.js';
import { PaginationQueryDto } from '../common/dto/pagination.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';

const PAYMENTS_THROTTLE = { payments: {} };

@ApiTags('withdrawals')
@Controller({ path: 'withdrawals', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class WithdrawalsController {
  constructor(private readonly withdrawalsService: WithdrawalsService) {}

  @Post()
  @Throttle(PAYMENTS_THROTTLE)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Client-generated key. Retrying the same create with the same key returns the original withdrawal rather than creating a duplicate hold.',
  })
  @ApiOperation({
    summary:
      'Request a withdrawal. Holds the amount immediately; requires admin approval before funds leave the system.',
  })
  @ApiResponse({ status: 201, type: WithdrawalResponseDto })
  @ApiResponse({
    status: 422,
    description:
      'Amount below the minimum withdrawal, or insufficient available balance.',
  })
  async create(
    @CurrentUser() user: User,
    @Body() dto: CreateWithdrawalDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<WithdrawalResponseDto> {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    const withdrawal = await this.withdrawalsService.create(
      user.id,
      dto.amountMinor,
      dto.destinationDetails,
      idempotencyKey,
    );
    return toWithdrawalResponse(withdrawal);
  }

  @Get()
  @ApiOperation({ summary: "The authenticated user's own withdrawals." })
  @ApiResponse({ status: 200, type: [WithdrawalResponseDto] })
  async list(
    @CurrentUser() user: User,
    @Query() query: PaginationQueryDto,
  ): Promise<{ items: WithdrawalResponseDto[]; nextCursor: string | null }> {
    const page = await this.withdrawalsService.list(user.id, query);
    return {
      items: page.items.map(toWithdrawalResponse),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'A single withdrawal owned by the authenticated user.',
  })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  @ApiResponse({ status: 404, description: 'Not found, or not owned by you.' })
  async findOne(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<WithdrawalResponseDto> {
    const withdrawal = await this.withdrawalsService.findById(user.id, id);
    return toWithdrawalResponse(withdrawal);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel your own withdrawal while it is still awaiting review.',
  })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  @ApiResponse({
    status: 409,
    description: 'The withdrawal is no longer awaiting review.',
  })
  async cancel(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<WithdrawalResponseDto> {
    const withdrawal = await this.withdrawalsService.cancel(user.id, id);
    return toWithdrawalResponse(withdrawal);
  }
}
