import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Cursor-based pagination query params, shared by every list endpoint. */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: "Opaque cursor from a previous page's `nextCursor`.",
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
