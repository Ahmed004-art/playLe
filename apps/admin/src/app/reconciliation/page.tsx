'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { runReconciliation, ApiRequestError } from '@/lib/api-client';
import type { ReconciliationReport } from '@/lib/reconciliation-types';

function ReconciliationContent() {
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const result = await runReconciliation();
      setReport(result);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Failed to run reconciliation');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="badge">Phase 5 — Reconciliation</span>
        <Link href="/">Back to dashboard</Link>
      </div>

      <div className="wideCard">
        <h1>Reconciliation</h1>
        <p className="statusLine">
          Runs every anomaly check (orphaned holds, missing/duplicate/unbalanced settlements,
          wallet/ledger mismatches) on demand. This is entirely read-only — running it never
          modifies any record.
        </p>

        <div className="inlineForm" style={{ margin: '16px 0' }}>
          <button className="actionButton" disabled={loading} onClick={() => run()}>
            {loading ? 'Running…' : 'Run reconciliation'}
          </button>
        </div>

        {error && <p className="statusDown">{error}</p>}

        {report && (
          <>
            <p className="statusLine">
              Generated at {new Date(report.generatedAt).toLocaleString()}
            </p>

            {report.anomalies.length === 0 ? (
              <p className="statusLine">No anomalies found.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>ID</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {report.anomalies.map((a, i) => (
                    <tr key={i}>
                      <td>{a.type}</td>
                      <td>{a.matchId ?? a.matchStakeId ?? a.settlementId ?? a.walletId ?? '—'}</td>
                      <td>{a.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function ReconciliationPage() {
  return (
    <AuthGuard>
      <ReconciliationContent />
    </AuthGuard>
  );
}
