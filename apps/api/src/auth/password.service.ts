import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Password hashing/verification, isolated behind its own service so the
 * rest of the codebase never imports `argon2` directly and the algorithm
 * can be swapped in one place if ever needed (see ADR-011).
 */
@Injectable()
export class PasswordService {
  async hash(plainPassword: string): Promise<string> {
    return argon2.hash(plainPassword, { type: argon2.argon2id });
  }

  async verify(hash: string, plainPassword: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plainPassword);
    } catch {
      // argon2.verify throws on a malformed/foreign hash rather than
      // returning false — treat that the same as a failed verification.
      return false;
    }
  }
}
