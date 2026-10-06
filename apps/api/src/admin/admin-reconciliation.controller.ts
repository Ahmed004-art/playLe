import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import {
  ReconciliationReport,
  ReconciliationService,
} from '../settlement/reconciliation.service.js';

/**
 * On-demand financial anomaly detection (Phase 5 spec section 28).
 * Read-only — running this never modifies any financial record.
 */
@ApiTags('admin-reconciliation')
@Controller({ path: 'admin/reconciliation', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@ApiBearerAuth()
export class AdminReconciliationController {
  constructor(private readonly reconciliationService: ReconciliationService) {}

  @Get('run')
  @ApiOperation({
    summary:
      'Runs every anomaly check now and returns the report. Never ' +
      'modifies any financial record.',
  })
  async run(): Promise<ReconciliationReport> {
    return this.reconciliationService.runOnce();
  }
}
