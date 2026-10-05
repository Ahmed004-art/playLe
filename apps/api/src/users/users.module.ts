import { Module, forwardRef } from '@nestjs/common';
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  // forwardRef: AuthModule already imports+exports UsersModule (for
  // UsersService, which JwtAuthGuard depends on); UsersController here
  // needs JwtAuthGuard right back, so the two modules depend on each
  // other — the standard, documented NestJS fix for a genuine circular
  // module dependency, not a workaround.
  imports: [forwardRef(() => AuthModule)],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
