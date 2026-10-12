import { Module } from '@nestjs/common';
import { AdminAuditService } from './admin-audit.service.js';

/**
 * Standalone (no dependency on `AuthModule` or anything else) so both
 * `AdminAuthModule` and `MfaModule` can depend on it without creating a
 * module import cycle between them.
 */
@Module({
  providers: [AdminAuditService],
  exports: [AdminAuditService],
})
export class AuditModule {}
