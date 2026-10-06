import { ApiProperty } from '@nestjs/swagger';
import { DisputeStatus } from '@prisma/client';
import type { Dispute } from '@prisma/client';

export class DisputeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() matchId!: string;
  @ApiProperty() raisedByUserId!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: DisputeStatus }) status!: DisputeStatus;
  @ApiProperty({ nullable: true, type: String }) resolution!: string | null;
  @ApiProperty({ nullable: true, type: String })
  resolvedByAdminId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) resolvedAt!: Date | null;
}

export function toDisputeResponse(dispute: Dispute): DisputeResponseDto {
  return {
    id: dispute.id,
    matchId: dispute.matchId,
    raisedByUserId: dispute.raisedByUserId,
    reason: dispute.reason,
    status: dispute.status,
    resolution: dispute.resolution,
    resolvedByAdminId: dispute.resolvedByAdminId,
    createdAt: dispute.createdAt,
    resolvedAt: dispute.resolvedAt,
  };
}
