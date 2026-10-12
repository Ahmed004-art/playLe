import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module.js';
import { MfaModule } from '../mfa/mfa.module.js';
import { AuthController } from './auth.controller.js';
import { SessionsController } from './sessions.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';

@Module({
  // forwardRef: see the matching comment in users.module.ts (UsersModule)
  // and mfa.module.ts (MfaModule) — both are genuine mutual dependencies.
  imports: [
    forwardRef(() => UsersModule),
    forwardRef(() => MfaModule),
    JwtModule.register({}),
  ],
  controllers: [AuthController, SessionsController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    JwtAuthGuard,
    RolesGuard,
  ],
  // Re-export UsersModule too: JwtAuthGuard depends on UsersService, so any
  // module that imports AuthModule to use the guard needs it transitively
  // available, not just TokenService.
  exports: [
    UsersModule,
    AuthService,
    PasswordService,
    TokenService,
    JwtAuthGuard,
    RolesGuard,
  ],
})
export class AuthModule {}
