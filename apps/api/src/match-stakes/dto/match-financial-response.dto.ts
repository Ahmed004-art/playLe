import { ApiProperty } from '@nestjs/swagger';
import {
  MatchStakeStatus,
  SettlementEntryRole,
  SettlementOutcome,
  SettlementStatus,
} from '@prisma/client';
import type {
  MatchStake,
  MatchStakePlayer,
  Settlement,
  SettlementEntry,
} from '@prisma/client';

export class MatchStakePlayerResponseDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ nullable: true, type: Date }) heldAt!: Date | null;
}

export class MatchStakeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: MatchStakeStatus }) status!: MatchStakeStatus;
  @ApiProperty() currency!: string;
  @ApiProperty({ description: 'Decimal string of integer minor units.' })
  stakeAmountMinor!: string;
  @ApiProperty({ description: 'stakeAmountMinor * number of players.' })
  poolAmountMinor!: string;
  @ApiProperty({ type: [MatchStakePlayerResponseDto] })
  players!: MatchStakePlayerResponseDto[];
}

export class SettlementEntryResponseDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ enum: SettlementEntryRole }) role!: SettlementEntryRole;
  @ApiProperty() availableDeltaMinor!: string;
  @ApiProperty() heldDeltaMinor!: string;
}

export class SettlementResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: SettlementOutcome }) outcome!: SettlementOutcome;
  @ApiProperty({ enum: SettlementStatus }) status!: SettlementStatus;
  @ApiProperty() currency!: string;
  @ApiProperty() poolAmountMinor!: string;
  @ApiProperty() platformFeeAmountMinor!: string;
  @ApiProperty({ type: [SettlementEntryResponseDto] })
  entries!: SettlementEntryResponseDto[];
  @ApiProperty({ nullable: true, type: Date }) completedAt!: Date | null;
}

export class MatchFinancialResponseDto {
  @ApiProperty({ nullable: true, type: MatchStakeResponseDto })
  stake!: MatchStakeResponseDto | null;
  @ApiProperty({ nullable: true, type: SettlementResponseDto })
  settlement!: SettlementResponseDto | null;
}

export function toMatchStakeResponse(
  stake: MatchStake & { players: MatchStakePlayer[] },
): MatchStakeResponseDto {
  return {
    id: stake.id,
    status: stake.status,
    currency: stake.currency,
    stakeAmountMinor: stake.stakeAmountMinor.toString(),
    poolAmountMinor: (
      stake.stakeAmountMinor * BigInt(stake.players.length)
    ).toString(),
    players: stake.players.map((p) => ({
      userId: p.userId,
      heldAt: p.heldAt,
    })),
  };
}

export function toSettlementResponse(
  settlement: Settlement & { entries: SettlementEntry[] },
): SettlementResponseDto {
  return {
    id: settlement.id,
    outcome: settlement.outcome,
    status: settlement.status,
    currency: settlement.currency,
    poolAmountMinor: settlement.poolAmountMinor.toString(),
    platformFeeAmountMinor: settlement.platformFeeAmountMinor.toString(),
    entries: settlement.entries.map((e) => ({
      userId: e.userId,
      role: e.role,
      availableDeltaMinor: e.availableDeltaMinor.toString(),
      heldDeltaMinor: e.heldDeltaMinor.toString(),
    })),
    completedAt: settlement.completedAt,
  };
}
