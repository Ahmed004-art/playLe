'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import {
  listWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  completeWithdrawal,
  failWithdrawal,
  ApiRequestError,
} from '@/lib/api-client';
import type { AdminWithdrawal } from '@/lib/wallet-types';
import { formatMinorAmount } from '@/lib/money-format';

const STATUS_FILTERS = [
  'ALL',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

function WithdrawalsContent() {
  const [status, setStatus] = useState<string>('PENDING_REVIEW');
  const [withdrawals, setWithdrawals] = useState<AdminWithdrawal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await listWithdrawals(status === 'ALL' ? undefined : status);
      setWithdrawals(page.items);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Failed to load withdrawals');
    } finally {
      setLoading(false);
    }
  }, [status]);

  // Mirrors the cancelled-guard pattern in lib/auth-context.tsx: the
  // effect owns its own async wrapper rather than invoking `load`
  // (a memoized setState-starting callback) directly in the effect body.
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

  async function runAction(
    action: (id: string, reason: string) => Promise<AdminWithdrawal>,
    id: string,
  ) {
    const reason = window.prompt('Reason (at least 10 characters, required and audited):');
    if (!reason || reason.trim().length < 10) {
      if (reason !== null) window.alert('Reason must be at least 10 characters.');
      return;
    }

    setActioningId(id);
    try {
      await action(id, reason.trim());
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
        <span className="badge">Phase 3 — Withdrawals</span>
        <Link href="/">Back to dashboard</Link>
      </div>

      <div className="wideCard">
        <h1>Withdrawals</h1>
        <p className="statusLine">
          Every approve/reject/complete/fail action requires a reason and is recorded against your
          admin account.
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

        {!loading && !error && withdrawals.length === 0 && (
          <p className="statusLine">No withdrawals in this status.</p>
        )}

        {!loading && !error && withdrawals.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Destination</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {withdrawals.map((w) => (
                <tr key={w.id}>
                  <td title={w.id}>{w.id.slice(0, 8)}…</td>
                  <td>{formatMinorAmount(w.amountMinor, w.currency)}</td>
                  <td>{w.status}</td>
                  <td>{JSON.stringify(w.destinationDetails)}</td>
                  <td>{new Date(w.createdAt).toLocaleString()}</td>
                  <td>
                    {w.status === 'PENDING_REVIEW' && (
                      <>
                        <button
                          className="actionButton"
                          disabled={actioningId === w.id}
                          onClick={() => runAction(approveWithdrawal, w.id)}
                        >
                          Approve
                        </button>
                        <button
                          className="actionButton"
                          disabled={actioningId === w.id}
                          onClick={() => runAction(rejectWithdrawal, w.id)}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {w.status === 'APPROVED' && (
                      <>
                        <button
                          className="actionButton"
                          disabled={actioningId === w.id}
                          onClick={() => runAction(completeWithdrawal, w.id)}
                        >
                          Mark Completed
                        </button>
                        <button
                          className="actionButton"
                          disabled={actioningId === w.id}
                          onClick={() => runAction(failWithdrawal, w.id)}
                        >
                          Mark Failed
                        </button>
                      </>
                    )}
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

export default function WithdrawalsPage() {
  return (
    <AuthGuard>
      <WithdrawalsContent />
    </AuthGuard>
  );
}
