import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { UsersController } from './users.controller.js';

/**
 * Phase 12 PR 2 - the block-aware username lookup, and the controller wiring
 * for profile and summaries. Services are fakes; the policy itself is in
 * block-visibility.ts and is unit-tested there.
 */

const viewer = { id: 'viewer' } as User;

type Relation = { blockedByViewer: boolean; blockedViewer: boolean };
const NONE: Relation = { blockedByViewer: false, blockedViewer: false };

function build(
  options: {
    found?: { id: string; username: string; status: string } | null;
    relation?: Relation;
  } = {},
) {
  const { found = null, relation = NONE } = options;
  const usersService = {
    findByUsername: vi.fn(() => Promise.resolve(found)),
  };
  const profilesService = {
    getProfile: vi.fn(() => Promise.resolve({ id: 'p' })),
    getSummaries: vi.fn(() => Promise.resolve([{ id: 'a' }])),
  };
  const blocksService = {
    relationBetween: vi.fn(() => Promise.resolve(relation)),
  };
  const controller = new UsersController(
    usersService as never,
    profilesService as never,
    blocksService as never,
  );
  return { controller, usersService, profilesService, blocksService };
}

const target = { id: 'target', username: 'tee', status: 'ACTIVE' };

describe('UsersController.lookup', () => {
  it('resolves an exact username for a player nobody has blocked, unchanged', async () => {
    const { controller, blocksService } = build({ found: target });

    expect(await controller.lookup(viewer, 'tee')).toEqual({
      id: 'target',
      username: 'tee',
    });
    expect(blocksService.relationBetween).toHaveBeenCalledWith(
      'viewer',
      'target',
    );
  });

  it('returns only id and username', async () => {
    const { controller } = build({
      found: { ...target, email: 'x@example.com' } as never,
    });

    expect(Object.keys(await controller.lookup(viewer, 'tee')).sort()).toEqual([
      'id',
      'username',
    ]);
  });

  it('hides a player who has blocked the viewer, with the same error as an unknown username', async () => {
    const hidden = build({
      found: target,
      relation: { blockedByViewer: false, blockedViewer: true },
    });
    const missing = build({ found: null });

    const hiddenError = await hidden.controller
      .lookup(viewer, 'tee')
      .catch((e: NotFoundException) => e);
    const missingError = await missing.controller
      .lookup(viewer, 'ghost')
      .catch((e: NotFoundException) => e);

    expect(hiddenError).toBeInstanceOf(NotFoundException);
    expect((hiddenError as NotFoundException).getStatus()).toBe(404);
    expect((hiddenError as NotFoundException).getResponse()).toEqual(
      (missingError as NotFoundException).getResponse(),
    );
  });

  it('still resolves a player the viewer themselves blocked', async () => {
    const { controller } = build({
      found: target,
      relation: { blockedByViewer: true, blockedViewer: false },
    });

    expect((await controller.lookup(viewer, 'tee')).id).toBe('target');
  });

  it('hides a player when both have blocked each other', async () => {
    const { controller } = build({
      found: target,
      relation: { blockedByViewer: true, blockedViewer: true },
    });

    await expect(controller.lookup(viewer, 'tee')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s for an unknown username without a block lookup', async () => {
    const { controller, blocksService } = build({ found: null });

    await expect(controller.lookup(viewer, 'ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(blocksService.relationBetween).not.toHaveBeenCalled();
  });

  it('404s for a missing username parameter without touching the database', async () => {
    const { controller, usersService } = build();

    await expect(controller.lookup(viewer, '')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(usersService.findByUsername).not.toHaveBeenCalled();
  });

  it('404s for a player who is not ACTIVE', async () => {
    const { controller } = build({ found: { ...target, status: 'SUSPENDED' } });

    await expect(controller.lookup(viewer, 'tee')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lets a player look themselves up, with no block lookup', async () => {
    const { controller, blocksService } = build({
      found: { id: 'viewer', username: 'me', status: 'ACTIVE' },
    });

    expect((await controller.lookup(viewer, 'me')).id).toBe('viewer');
    expect(blocksService.relationBetween).not.toHaveBeenCalled();
  });
});

describe('UsersController profile and summaries', () => {
  it('profile passes the authenticated viewer and the requested id', async () => {
    const { controller, profilesService } = build();

    await controller.profile(viewer, 'p');

    expect(profilesService.getProfile).toHaveBeenCalledWith('viewer', 'p');
  });

  it('summaries wraps the visible players in { items } for the authenticated viewer', async () => {
    const { controller, profilesService } = build();

    const result = await controller.summaries(viewer, { ids: ['a', 'b'] });

    expect(profilesService.getSummaries).toHaveBeenCalledWith('viewer', [
      'a',
      'b',
    ]);
    expect(result).toEqual({ items: [{ id: 'a' }] });
  });
});
