import { Module, forwardRef } from '@nestjs/common';
import { UsersService } from './users.service.js';
import { ProfilesService } from './profiles.service.js';
import { UsersController } from './users.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { BlocksModule } from '../blocks/blocks.module.js';

@Module({
  // forwardRef: AuthModule already imports+exports UsersModule (for
  // UsersService, which JwtAuthGuard depends on); UsersController here
  // needs JwtAuthGuard right back, so the two modules depend on each
  // other — the standard, documented NestJS fix for a genuine circular
  // module dependency, not a workaround. BlocksModule (Phase 12) imports
  // AuthModule for the same guard, so UsersModule -> BlocksModule ->
  // AuthModule -> UsersModule is the same cycle one hop longer, and both
  // of its edges here and in BlocksModule are forward references too.
  imports: [forwardRef(() => AuthModule), forwardRef(() => BlocksModule)],
  controllers: [UsersController],
  providers: [UsersService, ProfilesService],
  exports: [UsersService],
})
export class UsersModule {}
