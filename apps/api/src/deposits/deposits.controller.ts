import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
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
import { DepositsService } from './deposits.service.js';
import { CreateDepositDto } from './dto/create-deposit.dto.js';
import {
  toDepositResponse,
  DepositResponseDto,
} from './dto/deposit-response.dto.js';
import { PaginationQueryDto } from '../common/dto/pagination.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';

/**
 * Uses the separately-configurable 'payments' throttler profile registered
 * in AppModule, distinct from the global default and from 'auth'.
 */
const PAYMENTS_THROTTLE = { payments: {} };

@ApiTags('deposits')
@Controller({ path: 'deposits', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DepositsController {
  constructor(private readonly depositsService: DepositsService) {}

  @Post()
  @Throttle(PAYMENTS_THROTTLE)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Client-generated key. Retrying the same create with the same key returns the original deposit rather than creating a duplicate.',
  })
  @ApiOperation({ summary: 'Create a deposit request.' })
  @ApiResponse({ status: 201, type: DepositResponseDto })
  @ApiResponse({
    status: 422,
    description: 'Amount below the minimum deposit.',
  })
  async create(
    @CurrentUser() user: User,
    @Body() dto: CreateDepositDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<DepositResponseDto> {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    const deposit = await this.depositsService.create(
      user.id,
      dto.amountMinor,
      idempotencyKey,
    );
    return toDepositResponse(deposit);
  }

  @Get()
  @ApiOperation({ summary: "The authenticated user's own deposits." })
  @ApiResponse({ status: 200, type: [DepositResponseDto] })
  async list(
    @CurrentUser() user: User,
    @Query() query: PaginationQueryDto,
  ): Promise<{ items: DepositResponseDto[]; nextCursor: string | null }> {
    const page = await this.depositsService.list(user.id, query);
    return {
      items: page.items.map(toDepositResponse),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'A single deposit owned by the authenticated user.',
  })
  @ApiResponse({ status: 200, type: DepositResponseDto })
  @ApiResponse({ status: 404, description: 'Not found, or not owned by you.' })
  async findOne(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<DepositResponseDto> {
    const deposit = await this.depositsService.findById(user.id, id);
    return toDepositResponse(deposit);
  }
}
