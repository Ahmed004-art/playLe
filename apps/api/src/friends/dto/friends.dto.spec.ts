import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateFriendRequestDto,
  FriendRequestsQueryDto,
} from './friends.dto.js';

const opts = { whitelist: true, forbidNonWhitelisted: true };
const uuid = '00000000-0000-4000-8000-000000000001';

describe('CreateFriendRequestDto', () => {
  it('accepts a uuid and nothing else', async () => {
    const ok = await validate(
      plainToInstance(CreateFriendRequestDto, { userId: uuid }),
      opts,
    );
    expect(ok).toEqual([]);

    for (const body of [
      {},
      { userId: 'nope' },
      { userId: 123 },
      { userId: uuid, extra: 1 },
    ]) {
      const errors = await validate(
        plainToInstance(CreateFriendRequestDto, body),
        opts,
      );
      expect(errors.length).toBeGreaterThan(0);
    }
  });
});

describe('FriendRequestsQueryDto', () => {
  it('defaults to incoming, accepts outgoing, rejects anything else', async () => {
    const none = plainToInstance(FriendRequestsQueryDto, {});
    expect(await validate(none, opts)).toEqual([]);
    expect(none.direction).toBe('incoming');

    const out = plainToInstance(FriendRequestsQueryDto, {
      direction: 'outgoing',
    });
    expect(await validate(out, opts)).toEqual([]);

    const bad = plainToInstance(FriendRequestsQueryDto, {
      direction: 'sideways',
    });
    expect((await validate(bad, opts))[0].constraints).toHaveProperty('isIn');
  });

  it('keeps the shared pagination rules and has no way to ask about specific users', async () => {
    const tooBig = plainToInstance(FriendRequestsQueryDto, { limit: '500' });
    expect((await validate(tooBig, opts)).length).toBeGreaterThan(0);

    const extra = plainToInstance(FriendRequestsQueryDto, { userId: uuid });
    expect((await validate(extra, opts))[0].property).toBe('userId');
  });
});
