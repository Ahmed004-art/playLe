import { describe, expect, it, vi } from 'vitest';
import { RealtimeEmitterService } from './realtime-emitter.service.js';
import type { Server } from 'socket.io';

describe('RealtimeEmitterService', () => {
  it('drops an emit silently (no throw) when the server is not yet registered', () => {
    const service = new RealtimeEmitterService();
    expect(() => service.emitToUser('user-1', 'match:found', {})).not.toThrow();
  });

  it('emits to the per-user room once the server is registered', () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const server = { to } as unknown as Server;

    const service = new RealtimeEmitterService();
    service.setServer(server);
    service.emitToUser('user-1', 'match:found', { matchId: 'm1' });

    expect(to).toHaveBeenCalledWith('user:user-1');
    expect(emit).toHaveBeenCalledWith('match:found', { matchId: 'm1' });
  });

  it('emits to the per-match room', () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const server = { to } as unknown as Server;

    const service = new RealtimeEmitterService();
    service.setServer(server);
    service.emitToMatch('match-1', 'match:state', { stateVersion: 2 });

    expect(to).toHaveBeenCalledWith('match:match-1');
    expect(emit).toHaveBeenCalledWith('match:state', { stateVersion: 2 });
  });
});
