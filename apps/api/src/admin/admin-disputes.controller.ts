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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { DisputesService } from '../disputes/disputes.service.js';
import {
  DisputeResponseDto,
  toDisputeResponse,
} from '../disputes/dto/dispute-response.dto.js';
import { ResolveDisputeDto } from '../disputes/dto/resolve-dispute.dto.js';
import { AdminDisputesQueryDto } from './dto/admin-disputes-query.dto.js';

@ApiTags('admin-disputes')
@Controller({ path: 'admin/disputes', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@ApiBearerAuth()
export class AdminDisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  @Get()
  @ApiOperation({
    summary: 'List disputes, optionally filtered by status (admin).',
  })
  @ApiResponse({ status: 200, type: [DisputeResponseDto] })
  async list(
    @Query() query: AdminDisputesQueryDto,
  ): Promise<{ items: DisputeResponseDto[]; nextCursor: string | null }> {
    const page = await this.disputesService.listAdmin({
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.map(toDisputeResponse),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'A single dispute (admin).' })
  @ApiResponse({ status: 200, type: DisputeResponseDto })
  async findOne(@Param('id') id: string): Promise<DisputeResponseDto> {
    const dispute = await this.disputesService.findByIdAdmin(id);
    return toDisputeResponse(dispute);
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Status + audit only — never moves money. An upheld dispute's " +
      'actual correction (if any) is a separate, already-audited admin ' +
      'wallet adjustment (POST /admin/wallets/:userId/adjustments).',
  })
  @ApiResponse({ status: 200, type: DisputeResponseDto })
  async resolve(
    @CurrentUser() admin: User,
    @Param('id') id: string,
    @Body() dto: ResolveDisputeDto,
  ): Promise<DisputeResponseDto> {
    const dispute = await this.disputesService.resolve(
      admin.id,
      id,
      dto.status,
      dto.resolution,
    );
    return toDisputeResponse(dispute);
  }
}
