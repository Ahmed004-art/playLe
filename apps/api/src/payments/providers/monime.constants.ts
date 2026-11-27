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
 * delivers header names), valued `t=<unix seconds>,v1=<base64 signature>`.
 *
 * The signature is HMAC-SHA256, keyed with the webhook's own secret (not the
 * API token), over the bytes `<t>_<raw request body>` - an underscore, not a
 * period - and base64-encoded. Sources: docs.monime.io, "Webhooks > HMAC
 * verification" and "Testing locally" (Node/Python/Go examples), and
 * Monime's own open-source integration monimesl/MonimeGateway_odoo
 * (utils/webhook_validation.py), which compute it identically.
 */
export const MONIME_SIGNATURE_HEADER = 'monime-signature';

/** Reject a signature whose `t` is older than this (docs.monime.io: 300 s). */
export const MONIME_SIGNATURE_MAX_AGE_SECONDS = 300;

/** Reject a signature whose `t` is further ahead than this (docs: 60 s). */
export const MONIME_SIGNATURE_MAX_FUTURE_SECONDS = 60;

/**
 * A payment code collects exactly one payment. Sent explicitly (it is also the
 * documented default) because the amount validation that guards crediting
 * assumes a single payment per deposit: a `recurrent` code can take several.
 */
export const MONIME_PAYMENT_CODE_MODE = 'one_time' as const;
