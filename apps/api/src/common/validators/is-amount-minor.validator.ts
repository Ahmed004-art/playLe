import { registerDecorator, type ValidationOptions } from 'class-validator';
import { isAmountMinorString } from '../money.js';

/**
 * Validates that a DTO field is a decimal string of non-negative integer
 * minor units (e.g. `"50000"`). Amounts travel over the wire as strings,
 * never numbers — see `src/common/money.ts`.
 */
export function IsAmountMinorString(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isAmountMinorString',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return isAmountMinorString(value);
        },
        defaultMessage(): string {
          return `${String(propertyName)} must be a string of non-negative integer minor units (e.g. "50000")`;
        },
      },
    });
  };
}
