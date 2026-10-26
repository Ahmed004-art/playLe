import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PresenceService } from './presence.service.js';
import { RedisService } from '../redis/redis.service.js';

describe('PresenceService', () => {
  let client: {
    set: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    mget: ReturnType<typeof vi.fn>;
  };
  let service: PresenceService;

  beforeEach(() => {
    client = {
      set: vi.fn().mockResolvedValue('OK'),
      expire: vi.fn().mockResolvedValue(1),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
      mget: vi.fn().mockResolvedValue([]),
    };
    const redisService = {
      getClient: () => client,
    } as unknown as RedisService;
    service = new PresenceService(redisService);
  });

  it('sets a presence key with a 30s TTL', async () => {
    await service.set('user-1', 'ONLINE');
    expect(client.set).toHaveBeenCalledWith(
      'presence:user-1',
      'ONLINE',
      'EX',
      30,
    );
  });

  it('touch refreshes the TTL without changing the value', async () => {
    await service.touch('user-1');
    expect(client.expire).toHaveBeenCalledWith('presence:user-1', 30);
  });

  it('get returns the stored status', async () => {
    client.get.mockResolvedValue('IN_MATCH');
    await expect(service.get('user-1')).resolves.toBe('IN_MATCH');
  });

  it('get returns null when no presence key exists', async () => {
    await expect(service.get('user-1')).resolves.toBeNull();
  });

  it('clear deletes the presence key', async () => {
    await service.clear('user-1');
    expect(client.del).toHaveBeenCalledWith('presence:user-1');
  });

  describe('getMany (Phase 12 PR 3)', () => {
    it('reads every key in ONE MGET, never one GET per user', async () => {
      client.mget.mockResolvedValue(['ONLINE', null, 'IN_MATCH']);

      const result = await service.getMany(['u1', 'u2', 'u3']);

      expect(client.mget).toHaveBeenCalledTimes(1);
      expect(client.mget).toHaveBeenCalledWith(
        'presence:u1',
        'presence:u2',
        'presence:u3',
      );
      expect(client.get).not.toHaveBeenCalled();
      expect([...result]).toEqual([
        ['u1', 'ONLINE'],
        ['u2', null],
        ['u3', 'IN_MATCH'],
      ]);
    });

    it('treats an unknown stored value as offline rather than passing it through', async () => {
      client.mget.mockResolvedValue(['SOMETHING_ELSE', 'SEARCHING']);

      const result = await service.getMany(['u1', 'u2']);

      expect(result.get('u1')).toBeNull();
      expect(result.get('u2')).toBe('SEARCHING');
    });

    it('does not touch Redis for an empty list', async () => {
      expect((await service.getMany([])).size).toBe(0);
      expect(client.mget).not.toHaveBeenCalled();
    });

    it('lets a Redis failure propagate so the caller decides (friends show OFFLINE)', async () => {
      client.mget.mockRejectedValue(new Error('Redis is down'));

      await expect(service.getMany(['u1'])).rejects.toThrow('Redis is down');
    });
  });
});
