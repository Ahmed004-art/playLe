import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AdminSessionController } from './admin-session.controller.js';
import { MfaModule } from '../mfa/mfa.module.js';

@Module({
  imports: [AuthModule, AuditModule, MfaModule],
  controllers: [AdminSessionController],
})
export class AdminAuthModule {}
