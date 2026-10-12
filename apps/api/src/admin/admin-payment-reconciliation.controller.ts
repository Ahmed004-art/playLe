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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PaymentReconciliationAnomaly, User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import {
  PaymentReconciliationReport,
  PaymentReconciliationService,
} from '../payments/payment-reconciliation.service.js';
import { AdminPaymentAnomaliesQueryDto } from './dto/admin-list-query.dto.js';
import { ResolveAnomalyDto } from './dto/resolve-anomaly.dto.js';

/**
 * On-demand payment-provider anomaly detection — distinct from
 * `/admin/reconciliation` (Phase 5's match-financial-engine
 * reconciliation, which never touches provider state). Read-only
 * detection; resolving an anomaly here only ever records that an admin
 * reviewed it (via the ordinary Deposit/Withdrawal/Ledger paths) — never
 * a money-mutating action itself.
 */
@ApiTags('admin-payment-reconciliation')
@Controller({ path: 'admin/payment-reconciliation', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@ApiBearerAuth()
export class AdminPaymentReconciliationController {
  constructor(
    private readonly reconciliationService: PaymentReconciliationService,
  ) {}

  @Get('run')
  @ApiOperation({
    summary:
      'Runs every payment anomaly check now, persists any newly-detected ' +
      'ones, and returns the report. Never modifies any financial record.',
  })
  async run(): Promise<PaymentReconciliationReport> {
    return this.reconciliationService.runOnce();
  }

  @Get('anomalies')
  @ApiOperation({ summary: 'List recorded payment anomalies.' })
  async list(@Query() query: AdminPaymentAnomaliesQueryDto): Promise<{
    items: PaymentReconciliationAnomaly[];
    nextCursor: string | null;
  }> {
    return this.reconciliationService.listAnomalies({
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post('anomalies/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Marks an anomaly resolved after the admin has reviewed/fixed the ' +
      'underlying issue through the ordinary financial service paths.',
  })
  async resolve(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Body() dto: ResolveAnomalyDto,
  ): Promise<PaymentReconciliationAnomaly> {
    return this.reconciliationService.resolveAnomaly(
      admin.id,
      id,
      dto.resolutionNote,
    );
  }
}
