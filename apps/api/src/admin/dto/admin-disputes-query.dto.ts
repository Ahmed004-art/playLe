import { ApiPropertyOptional } from '@nestjs/swagger';
import { DisputeStatus } from '@prisma/client';
import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

export class AdminDisputesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DisputeStatus })
  @IsOptional()
  @IsIn(Object.values(DisputeStatus))
  status?: DisputeStatus;
}
