import { Injectable, NotFoundException } from '@nestjs/common';
import type { Game } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class GamesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Only enabled games are shown in the catalog — see `Game.enabled`. */
  listEnabled(): Promise<Game[]> {
    return this.prisma.game.findMany({
      where: { enabled: true },
      orderBy: { displayName: 'asc' },
    });
  }

  async findEnabledById(id: string): Promise<Game> {
    const game = await this.prisma.game.findUnique({ where: { id } });
    if (!game || !game.enabled) {
      throw new NotFoundException('Game not found');
    }
    return game;
  }
}
