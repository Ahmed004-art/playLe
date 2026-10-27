import type { Logger } from '@nestjs/common';
import { Prisma, type ProviderEventStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Recording and finishing a verified provider webhook delivery (Phase 13).
 *
 * Each delivery is stored as a `ProviderEvent` (status `RECEIVED`) before any
 * money moves, and the unique `(provider, providerEventId)` index makes a
 * repeat of the same event a database-level duplicate. Before Phase 13 every
 * duplicate was simply ignored - including one whose first attempt had thrown
 * after the row was stored, so a transient failure in the money step left the
 * event `RECEIVED` forever and the provider's retry was answered 200 and
 * dropped. Now a duplicate is ignored only once the event reached a final
 * status; a `RECEIVED` one is processed again.
 *
 * That is safe because every money step it can reach is an idempotent
 * conditional claim (a deposit is credited only by the transaction that moves
 * it off `PENDING`; a withdrawal is finalized only by the transaction that
 * moves it off `APPROVED`/`PROCESSING`), so a re-run - or a run concurrent
 * with a slow first attempt - can never apply a money effect twice. It also
 * covers a failure *after* the money transaction committed: the re-run finds
 * the deposit/withdrawal already settled, applies nothing, and finishes the
 * event.
 */

/** Something the caller can process: a freshly stored event or a recovered one. */
export interface RecordedProviderEvent {
  id: string;
  recovered: boolean;
}

export async function recordProviderEvent(
  prisma: PrismaService,
  logger: Logger,
  provider: string,
  providerEventId: string,
  eventType: string,
  payload: unknown,
): Promise<RecordedProviderEvent | null> {
  try {
    const created = await prisma.providerEvent.create({
      data: {
        provider,
        providerEventId,
        eventType,
        payload: payload as Prisma.InputJsonValue,
        status: 'RECEIVED',
      },
    });
    return { id: created.id, recovered: false };
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      throw error;
    }
  }

  const existing = await prisma.providerEvent.findUnique({
    where: { provider_providerEventId: { provider, providerEventId } },
  });
  if (!existing || existing.status !== 'RECEIVED') {
    // Already finished (processed, ignored or rejected): a plain duplicate.
    return null;
  }
  if (
    existing.eventType !== eventType ||
    !sameJson(existing.payload, asStoredJson(payload))
  ) {
    // Same provider event id, different content: never act on it. The stored
    // event stays RECEIVED for an operator; this delivery is acknowledged
    // without effect.
    logger.warn(
      `Provider event ${provider}/${providerEventId} was redelivered with a different type or payload than the stored, unfinished one; not processed.`,
    );
    return null;
  }
  logger.log(
    `Recovering unfinished provider event ${provider}/${providerEventId}`,
  );
  return { id: existing.id, recovered: true };
}

/**
 * Moves an event to its final status, but only from `RECEIVED`: a concurrent
 * delivery that already finished it is never overwritten.
 */
export async function finishProviderEvent(
  prisma: PrismaService,
  id: string,
  data: {
    status: Exclude<ProviderEventStatus, 'RECEIVED'>;
    relatedDepositId?: string;
    relatedWithdrawalId?: string;
  },
): Promise<void> {
  await prisma.providerEvent.updateMany({
    where: { id, status: 'RECEIVED' },
    data: { ...data, processedAt: new Date() },
  });
}

/**
 * The value as it reads back from a JSON column: keys whose value is
 * `undefined` are dropped on the way in, so a redelivered payload must be
 * compared in that form, not as parsed.
 */
function asStoredJson(value: unknown): unknown {
  return value === undefined
    ? undefined
    : (JSON.parse(JSON.stringify(value)) as unknown);
}

/**
 * Structural JSON equality that ignores object key order (Postgres `jsonb`
 * does not keep it, so a stored payload comes back reordered).
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => sameJson(item, b[i]));
  }
  if (typeof a === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        sameJson(left[key], right[key]),
    );
  }
  return false;
}
