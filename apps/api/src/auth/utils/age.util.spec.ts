import { describe, expect, it } from 'vitest';
import { calculateAge, isOldEnough } from './age.util.js';

describe('calculateAge', () => {
  it('computes a simple whole-years difference', () => {
    expect(calculateAge(new Date('2000-01-01'), new Date('2026-01-01'))).toBe(
      26,
    );
  });

  it('has not had this year’s birthday yet', () => {
    expect(calculateAge(new Date('2000-06-15'), new Date('2026-06-14'))).toBe(
      25,
    );
  });

  it('had this year’s birthday already', () => {
    expect(calculateAge(new Date('2000-06-15'), new Date('2026-06-16'))).toBe(
      26,
    );
  });

  it('is exactly the birthday', () => {
    expect(calculateAge(new Date('2000-06-15'), new Date('2026-06-15'))).toBe(
      26,
    );
  });
});

describe('isOldEnough', () => {
  it('accepts someone exactly at the minimum age', () => {
    expect(
      isOldEnough(new Date('2010-01-01'), 16, new Date('2026-01-01')),
    ).toBe(true);
  });

  it('rejects someone a day under the minimum age', () => {
    expect(
      isOldEnough(new Date('2010-01-02'), 16, new Date('2026-01-01')),
    ).toBe(false);
  });

  it('accepts someone well above the minimum age', () => {
    expect(
      isOldEnough(new Date('1990-01-01'), 16, new Date('2026-01-01')),
    ).toBe(true);
  });
});
