import {
  Controller,
  Get,
  NotFoundException,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UsersService } from './users.service.js';
import { UserLookupResponseDto } from './dto/user-lookup-response.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';

@ApiTags('users')
@Controller({ path: 'users', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('lookup')
  @ApiOperation({
    summary:
      'Resolve an exact username to a user id — used to start a direct challenge. ' +
      'Not a user directory/search feature.',
  })
  @ApiResponse({ status: 200, type: UserLookupResponseDto })
  @ApiResponse({ status: 404, description: 'No account with that username.' })
  async lookup(
    @Query('username') username: string,
  ): Promise<UserLookupResponseDto> {
    const user = username
      ? await this.usersService.findByUsername(username)
      : null;
    if (!user || user.status !== 'ACTIVE') {
      throw new NotFoundException('No account with that username');
    }
    return { id: user.id, username: user.username };
  }
}
