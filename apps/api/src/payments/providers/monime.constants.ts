/**
 * Monime API release selection, defined once.
 *
 * Every request PlayLe sends pins `Monime-Version` to a documented value
 * instead of inheriting whatever Monime's current default happens to be, and
 * the webhook registered in the same Space must target the SAME release -
 * `apiRelease` on `POST /v1/webhooks` - or the events PlayLe receives would be
 * shaped by a different schema than the one its parser was written against.
 *
 * The accepted versions are the documented `Monime-Version` enum for the
 * `caph` release (docs.monime.io, caph-2025-08-23, payment-code and webhook
 * operations). The docs do not say whether a webhook's `apiRelease` must equal
 * the request header's release; the safe reading is to keep them the same, which
 * `webhookApiReleaseFor` makes the single derivation.
 */
export const MONIME_SUPPORTED_API_VERSIONS = [
  'caph.2025-08-23',
  'caph.2025-06-20',
] as const;

export type MonimeApiVersion = (typeof MONIME_SUPPORTED_API_VERSIONS)[number];

/** Pinned when `MONIME_API_VERSION` is unset. */
export const MONIME_DEFAULT_API_VERSION: MonimeApiVersion = 'caph.2025-08-23';

/**
 * The release name to use as `apiRelease` when registering the Space's webhook
 * (`caph` for every supported version): the part of the version before the
 * date, e.g. `caph.2025-08-23` -> `caph`.
 */
export function webhookApiReleaseFor(version: string): string {
  return version.split('.')[0];
}

/**
 * The header Monime sends its webhook signature in (lower-cased, as Node
 * delivers header names). Documented on docs.monime.io's standard-headers page
 * as "Monime-Signature - Cryptographic signature with timestamp". Only the NAME
 * is documented: the value format and the signed bytes are not, which is why
 * verification stays fail-closed.
 */
export const MONIME_SIGNATURE_HEADER = 'monime-signature';

/**
 * A payment code collects exactly one payment. Sent explicitly (it is also the
 * documented default) because the amount validation that guards crediting
 * assumes a single payment per deposit: a `recurrent` code can take several.
 */
export const MONIME_PAYMENT_CODE_MODE = 'one_time' as const;
