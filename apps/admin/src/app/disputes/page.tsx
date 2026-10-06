'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { listDisputes, ApiRequestError } from '@/lib/api-client';
import type { AdminDispute } from '@/lib/dispute-types';

const STATUS_FILTERS = ['ALL', 'OPEN', 'UNDER_REVIEW', 'UPHELD', 'REFUNDED', 'RESOLVED'] as const;

function DisputesContent() {
  const [status, setStatus] = useState<string>('OPEN');
  const [disputes, setDisputes] = useState<AdminDispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await listDisputes(status === 'ALL' ? undefined : status);
      setDisputes(page.items);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Failed to load disputes');
    } finally {
      setLoading(false);
    }
  }, [status]);

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

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="badge">Phase 5 — Disputes</span>
        <Link href="/">Back to dashboard</Link>
      </div>

      <div className="wideCard">
        <h1>Disputes</h1>
        <p className="statusLine">
          Resolving a dispute only records a status and an audited resolution note — it never moves
          money. Any balance correction, if one is warranted, is a separate wallet adjustment.
        </p>

        <div className="inlineForm" style={{ margin: '16px 0' }}>
          <label htmlFor="status-filter">Status:</label>
          <select id="status-filter" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        {loading && <p className="statusLine">Loading…</p>}
        {error && <p className="statusDown">{error}</p>}

        {!loading && !error && disputes.length === 0 && (
          <p className="statusLine">No disputes in this status.</p>
        )}

        {!loading && !error && disputes.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Match</th>
                <th>Raised by</th>
                <th>Status</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {disputes.map((d) => (
                <tr key={d.id}>
                  <td title={d.id}>{d.id.slice(0, 8)}…</td>
                  <td title={d.matchId}>{d.matchId.slice(0, 8)}…</td>
                  <td title={d.raisedByUserId}>{d.raisedByUserId.slice(0, 8)}…</td>
                  <td>{d.status}</td>
                  <td>{new Date(d.createdAt).toLocaleString()}</td>
                  <td>
                    <Link href={`/disputes/${d.id}`}>View →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function DisputesPage() {
  return (
    <AuthGuard>
      <DisputesContent />
    </AuthGuard>
  );
}
