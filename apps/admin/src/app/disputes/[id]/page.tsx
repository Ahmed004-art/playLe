'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AuthGuard } from '@/components/AuthGuard';
import { fetchDispute, resolveDispute, ApiRequestError } from '@/lib/api-client';
import type { AdminDispute, DisputeResolutionStatus } from '@/lib/dispute-types';

const RESOLUTION_STATUSES: DisputeResolutionStatus[] = [
  'UNDER_REVIEW',
  'UPHELD',
  'REFUNDED',
  'RESOLVED',
];

function DisputeDetailContent() {
  const params = useParams<{ id: string }>();
  const disputeId = params.id;
  const [dispute, setDispute] = useState<AdminDispute | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolutionStatus, setResolutionStatus] = useState<DisputeResolutionStatus>(
    RESOLUTION_STATUSES[0],
  );
  const [resolution, setResolution] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDispute(disputeId);
      setDispute(result);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Failed to load dispute');
    } finally {
      setLoading(false);
    }
  }, [disputeId]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!cancelled) await load();
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function submitResolution() {
    setFormError(null);
    if (resolution.trim().length < 10) {
      setFormError('Resolution must be at least 10 characters.');
      return;
    }

    setSubmitting(true);
    try {
      await resolveDispute(disputeId, resolutionStatus, resolution.trim());
      setResolution('');
      await load();
    } catch (e) {
      setFormError(e instanceof ApiRequestError ? e.message : 'Failed to resolve dispute');
    } finally {
      setSubmitting(false);
    }
  }

  const isFinal =
    dispute !== null && dispute.status !== 'OPEN' && dispute.status !== 'UNDER_REVIEW';

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="badge">Phase 5 — Dispute Detail</span>
        <Link href="/disputes">Back to disputes</Link>
      </div>

      <div className="wideCard">
        <h1>Dispute {disputeId.slice(0, 8)}…</h1>

        {loading && <p className="statusLine">Loading…</p>}
        {error && <p className="statusDown">{error}</p>}

        {!loading && !error && dispute && (
          <>
            <table className="table">
              <tbody>
                <tr>
                  <th>ID</th>
                  <td>{dispute.id}</td>
                </tr>
                <tr>
                  <th>Match</th>
                  <td>
                    <Link href={`/matches/${dispute.matchId}`}>{dispute.matchId}</Link>
                  </td>
                </tr>
                <tr>
                  <th>Raised by</th>
                  <td>{dispute.raisedByUserId}</td>
                </tr>
                <tr>
                  <th>Reason</th>
                  <td>{dispute.reason}</td>
                </tr>
                <tr>
                  <th>Status</th>
                  <td>{dispute.status}</td>
                </tr>
                <tr>
                  <th>Resolution</th>
                  <td>{dispute.resolution ?? '—'}</td>
                </tr>
                <tr>
                  <th>Resolved by</th>
                  <td>{dispute.resolvedByAdminId ?? '—'}</td>
                </tr>
                <tr>
                  <th>Created</th>
                  <td>{new Date(dispute.createdAt).toLocaleString()}</td>
                </tr>
                <tr>
                  <th>Resolved</th>
                  <td>
                    {dispute.resolvedAt ? new Date(dispute.resolvedAt).toLocaleString() : '—'}
                  </td>
                </tr>
              </tbody>
            </table>

            <h2 style={{ marginTop: 24 }}>Resolve dispute</h2>
            <p className="statusLine">
              Resolving only records a new status and an audited resolution note against your admin
              account — it never moves money. If a balance correction is warranted, make it
              separately through the existing wallet adjustment mechanism.
            </p>

            {isFinal ? (
              <p className="statusLine">This dispute is already in a final state.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
                <div className="inlineForm">
                  <label htmlFor="resolution-status">New status:</label>
                  <select
                    id="resolution-status"
                    value={resolutionStatus}
                    onChange={(e) => setResolutionStatus(e.target.value as DisputeResolutionStatus)}
                  >
                    {RESOLUTION_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <textarea
                  aria-label="Resolution note"
                  placeholder="Resolution note (at least 10 characters, required and audited)"
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  rows={4}
                />
                {formError && <p className="statusDown">{formError}</p>}
                <div>
                  <button
                    className="actionButton"
                    disabled={submitting}
                    onClick={() => submitResolution()}
                  >
                    Submit resolution
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function DisputeDetailPage() {
  return (
    <AuthGuard>
      <DisputeDetailContent />
    </AuthGuard>
  );
}
