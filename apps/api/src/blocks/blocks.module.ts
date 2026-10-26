import { Module, forwardRef } from '@nestjs/common';
import { BlocksService } from './blocks.service.js';
import { BlocksController } from './blocks.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';

@Module({
  // forwardRef: UsersModule imports this module (profiles and lookup consult
  // BlocksService) and AuthModule imports UsersModule, so this is part of the
  // same Users <-> Auth cycle - see users.module.ts. RealtimeModule imports
  // AuthModule too, so the *file-level* import cycle is
  // Realtime -> Auth -> Users -> Blocks -> Realtime: whichever module file
  // loads first sees the others as undefined, hence both are forward
  // references.
  imports: [forwardRef(() => AuthModule), forwardRef(() => RealtimeModule)],
  controllers: [BlocksController],
  providers: [BlocksService],
  exports: [BlocksService],
})
export class BlocksModule {}
