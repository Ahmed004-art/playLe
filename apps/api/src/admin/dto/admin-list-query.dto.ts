import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { PaymentAnomalyStatus, WithdrawalStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

export class AdminLedgerQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;
}

export class AdminDepositsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;
}

export class AdminWithdrawalsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ enum: WithdrawalStatus })
  @IsOptional()
  @IsIn(Object.values(WithdrawalStatus))
  status?: WithdrawalStatus;
}

export class AdminPaymentAnomaliesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PaymentAnomalyStatus })
  @IsOptional()
  @IsIn(Object.values(PaymentAnomalyStatus))
  status?: PaymentAnomalyStatus;
}

export class AdminProviderOperationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;
}
