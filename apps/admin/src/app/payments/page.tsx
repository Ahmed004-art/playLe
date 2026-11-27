'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import {
  listPaymentAnomalies,
  resolvePaymentAnomaly,
  runPaymentReconciliation,
  ApiRequestError,
} from '@/lib/api-client';
import type { PaymentAnomaly } from '@/lib/payment-types';

const STATUS_FILTERS = ['OPEN', 'RESOLVED', 'ALL'] as const;

function PaymentsContent() {
  const [status, setStatus] = useState<string>('OPEN');
  const [anomalies, setAnomalies] = useState<PaymentAnomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await listPaymentAnomalies(status === 'ALL' ? undefined : status);
      setAnomalies(page.items);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Failed to load payment problems');
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

  async function runNow() {
    setRunning(true);
    try {
      await runPaymentReconciliation();
      await load();
    } catch (e) {
      window.alert(e instanceof ApiRequestError ? e.message : 'Reconciliation failed');
    } finally {
      setRunning(false);
    }
  }

  async function resolve(id: string) {
    const note = window.prompt(
      'What did you check or fix? (at least 10 characters, required and audited)',
    );
    if (!note || note.trim().length < 10) {
      if (note !== null) window.alert('The note must be at least 10 characters.');
      return;
    }
    setActioningId(id);
    try {
      await resolvePaymentAnomaly(id, note.trim());
      await load();
    } catch (e) {
      window.alert(e instanceof ApiRequestError ? e.message : 'Action failed');
    } finally {
      setActioningId(null);
    }
  }

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="badge">Payments — problems needing review</span>
        <Link href="/">Back to dashboard</Link>
      </div>

      <div className="wideCard">
        <h1>Payment problems</h1>
        <p className="statusLine">
          Deposits and payouts the payment checks flagged: unknown payout outcomes, provider events
          that were not processed, completions the provider contradicts, and more. Checks also run
          on a schedule. Marking one resolved records your note; it never moves money — fix the
          underlying record through the withdrawal or wallet tools first.
        </p>

        <div className="inlineForm" style={{ margin: '16px 0' }}>
          <label htmlFor="anomaly-status">Status:</label>
          <select id="anomaly-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button className="actionButton" disabled={running} onClick={() => runNow()}>
            {running ? 'Checking…' : 'Run checks now'}
          </button>
        </div>

        {loading && <p className="statusLine">Loading…</p>}
        {error && <p className="statusDown">{error}</p>}
        {!loading && !error && anomalies.length === 0 && (
          <p className="statusLine">No payment problems in this status.</p>
        )}

        {!loading && !error && anomalies.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Deposit / withdrawal</th>
                <th>Detail</th>
                <th>Detected</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {anomalies.map((a) => (
                <tr key={a.id}>
                  <td>{a.type}</td>
                  <td>
                    {a.relatedDepositId
                      ? `deposit ${a.relatedDepositId.slice(0, 8)}…`
                      : a.relatedWithdrawalId
                        ? `withdrawal ${a.relatedWithdrawalId.slice(0, 8)}…`
                        : '—'}
                  </td>
                  <td>{a.details?.detail ?? ''}</td>
                  <td>{new Date(a.detectedAt).toLocaleString()}</td>
                  <td>{a.status}</td>
                  <td>
                    {a.status === 'OPEN' && (
                      <button
                        className="actionButton"
                        disabled={actioningId === a.id}
                        onClick={() => resolve(a.id)}
                      >
                        Mark resolved
                      </button>
                    )}
                    {a.status === 'RESOLVED' && a.resolutionNote}
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

export default function PaymentsPage() {
  return (
    <AuthGuard>
      <PaymentsContent />
    </AuthGuard>
  );
}
