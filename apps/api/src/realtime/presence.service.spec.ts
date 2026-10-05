import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PresenceService } from './presence.service.js';
import { RedisService } from '../redis/redis.service.js';

describe('PresenceService', () => {
  let client: {
    set: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let service: PresenceService;

  beforeEach(() => {
    client = {
      set: vi.fn().mockResolvedValue('OK'),
      expire: vi.fn().mockResolvedValue(1),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
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
});
