import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { MfaService } from './mfa.service.js';
import { MfaController } from './mfa.controller.js';

@Module({
  // forwardRef: `AuthService.login` needs `MfaService.isEnrolled`, and
  // `MfaService` needs `TokenService` from `AuthModule` — a genuine,
  // mutual dependency between the two modules (same pattern already
  // used between AuthModule/UsersModule — see the comment there).
  imports: [forwardRef(() => AuthModule), AuditModule],
  controllers: [MfaController],
  providers: [MfaService],
  exports: [MfaService],
})
export class MfaModule {}
