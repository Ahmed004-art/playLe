import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { BlocksService } from '../blocks/blocks.service.js';
import {
  isHiddenFromProfileAndLookup,
  isHiddenFromSummaries,
} from '../blocks/block-visibility.js';
import type { PlayerProfileResponseDto } from './dto/player-profile-response.dto.js';
import type { PlayerSummaryResponseDto } from './dto/player-summary-response.dto.js';

export interface MatchStats {
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
}

/**
 * Public player profiles, batch summaries and match statistics (Phase 12 PR 2
 * - ADR-026). Read-only: nothing here writes, and nothing touches wallets,
 * stakes, settlement or the ledger.
 */
@Injectable()
export class ProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocksService: BlocksService,
  ) {}

  /**
   * 404 for a player that does not exist, is not ACTIVE, or has blocked the
   * viewer - the same error body for all three, so a block never reveals
   * itself. A viewer can always open their own profile.
   */
  async getProfile(
    viewerId: string,
    playerId: string,
  ): Promise<PlayerProfileResponseDto> {
    const player = await this.prisma.user.findUnique({
      where: { id: playerId },
      select: { id: true, username: true, displayName: true, status: true },
    });
    if (!player || player.status !== 'ACTIVE') {
      throw new NotFoundException('Player not found');
    }
    if (player.id !== viewerId) {
      const relation = await this.blocksService.relationBetween(
        viewerId,
        player.id,
      );
      if (isHiddenFromProfileAndLookup(relation)) {
        throw new NotFoundException('Player not found');
      }
    }

    const stats = await this.getMatchStats(player.id);
    return {
      id: player.id,
      username: player.username,
      displayName: player.displayName,
      ...stats,
    };
  }

  /**
   * Labels for a list of players: id, username, display name and nothing
   * else. Two queries however many ids are asked for (one for the users, one
   * for every block between them and the viewer). A player who does not exist,
   * is not ACTIVE, or has a block against the viewer in either direction is
   * simply absent - there is no error and no marker, so the response cannot
   * be used to tell the three apart. Results keep the order of `ids`.
   */
  async getSummaries(
    viewerId: string,
    ids: string[],
  ): Promise<PlayerSummaryResponseDto[]> {
    if (ids.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, status: 'ACTIVE' },
      select: { id: true, username: true, displayName: true },
    });
    const relations = await this.blocksService.relationsBetween(
      viewerId,
      users.filter((u) => u.id !== viewerId).map((u) => u.id),
    );

    const visible = new Map(
      users
        .filter((u) => {
          if (u.id === viewerId) return true;
          const relation = relations.get(u.id);
          return relation !== undefined && !isHiddenFromSummaries(relation);
        })
        .map((u) => [u.id, u]),
    );
    return ids.flatMap((id) => {
      const user = visible.get(id);
      return user
        ? [
            {
              id: user.id,
              username: user.username,
              displayName: user.displayName,
            },
          ]
        : [];
    });
  }

  /**
   * Win/loss/draw counts, from the stored result of COMPLETED matches only,
   * in one aggregate query over `matches` filtered through `match_players`
   * (indexed on `userId`).
   *
   * A match counts for the player only if they are one of its players and its
   * stored result is internally consistent:
   * - **win**: `resultIsDraw` is false and `winnerUserId` is the player;
   * - **loss**: `resultIsDraw` is false, `winnerUserId` is someone else, and
   *   that winner is also one of the match's players (a winner with no
   *   `match_players` row is an inconsistent record and is not counted);
   * - **draw**: `resultIsDraw` is true and there is no `winnerUserId`.
   * Every other COMPLETED row (no winner and not a draw, or a draw that also
   * names a winner) is excluded rather than guessed at, so
   * `gamesPlayed = wins + losses + draws` always holds.
   *
   * ABANDONED, CANCELLED, EXPIRED and unfinished matches are never counted -
   * including a disconnect forfeit, which the timeout sweep stores as
   * ABANDONED with a winner. Wins and losses are never inferred from
   * disconnects, challenges, stakes, wallet entries or settlement.
   */
  async getMatchStats(userId: string): Promise<MatchStats> {
    const [row] = await this.prisma.$queryRaw<
      { wins: bigint; losses: bigint; draws: bigint }[]
    >`
      SELECT
        COUNT(*) FILTER (
          WHERE m."resultIsDraw" = false AND m."winnerUserId" = ${userId}
        ) AS wins,
        COUNT(*) FILTER (
          WHERE m."resultIsDraw" = false
            AND m."winnerUserId" IS NOT NULL
            AND m."winnerUserId" <> ${userId}
            AND EXISTS (
              SELECT 1 FROM match_players w
              WHERE w."matchId" = m.id AND w."userId" = m."winnerUserId"
            )
        ) AS losses,
        COUNT(*) FILTER (
          WHERE m."resultIsDraw" = true AND m."winnerUserId" IS NULL
        ) AS draws
      FROM matches m
      WHERE m.status = 'COMPLETED'
        AND EXISTS (
          SELECT 1 FROM match_players p
          WHERE p."matchId" = m.id AND p."userId" = ${userId}
        )
    `;

    const wins = Number(row?.wins ?? 0);
    const losses = Number(row?.losses ?? 0);
    const draws = Number(row?.draws ?? 0);
    return { gamesPlayed: wins + losses + draws, wins, losses, draws };
  }
}
