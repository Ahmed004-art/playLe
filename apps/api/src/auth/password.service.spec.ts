import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes a password into an argon2id-encoded string', async () => {
    const hash = await service.hash('CorrectHorse1');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('produces a different hash for the same password each time (random salt)', async () => {
    const [a, b] = await Promise.all([
      service.hash('CorrectHorse1'),
      service.hash('CorrectHorse1'),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifies a correct password against its hash', async () => {
    const hash = await service.hash('CorrectHorse1');
    await expect(service.verify(hash, 'CorrectHorse1')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await service.hash('CorrectHorse1');
    await expect(service.verify(hash, 'WrongPassword1')).resolves.toBe(false);
  });

  it('returns false (not throw) for a malformed hash', async () => {
    await expect(service.verify('not-a-real-hash', 'anything')).resolves.toBe(
      false,
    );
  });
});
