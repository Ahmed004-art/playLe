'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import {
  listResponsibleGamingHistory,
  fetchResponsibleGamingUsage,
  ApiRequestError,
} from '@/lib/api-client';
import type {
  AdminResponsibleGamingRestriction,
  AdminResponsibleGamingUsage,
} from '@/lib/responsible-gaming-types';
import { formatMinorAmount } from '@/lib/money-format';

function limitMinorOf(restriction: AdminResponsibleGamingRestriction): string | null {
  const value = restriction.config?.limitMinor;
  return typeof value === 'string' ? value : null;
}

function ResponsibleGamingContent() {
  const [userId, setUserId] = useState('');
  const [history, setHistory] = useState<AdminResponsibleGamingRestriction[]>([]);
  const [usage, setUsage] = useState<AdminResponsibleGamingUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [looked, setLooked] = useState(false);

  async function lookup() {
    if (!userId.trim()) return;
    setLoading(true);
    setError(null);
    setUsage(null);
    setHistory([]);
    try {
      const [historyRes, usageRes] = await Promise.all([
        listResponsibleGamingHistory(userId.trim()),
        fetchResponsibleGamingUsage(userId.trim()),
      ]);
      setHistory(historyRes);
      setUsage(usageRes);
      setLooked(true);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Failed to load responsible-gaming data');
      setLooked(true);
    } finally {
      setLoading(false);
    }
  }

  const isSelfExcluded = history.some((r) => r.type === 'SELF_EXCLUSION' && r.status === 'ACTIVE');

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="badge">Phase 8 — Responsible Gaming</span>
        <Link href="/">Back to dashboard</Link>
      </div>

      <div className="wideCard">
        <h1>Responsible Gaming</h1>
        <p className="statusLine">
          Inspect any user&apos;s restriction history and current rolling-window usage by user ID —
          the same figures and restrictions <code>EligibilityService</code> actually enforces.
          Read-only: there is no action here that lifts self-exclusion or any other restriction (see
          ADR-021/ADR-023).
        </p>

        <div className="inlineForm" style={{ margin: '16px 0' }}>
          <input
            placeholder="User ID"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && lookup()}
            style={{ minWidth: 320 }}
          />
          <button onClick={lookup} disabled={loading || !userId.trim()}>
            {loading ? 'Loading…' : 'Look up'}
          </button>
        </div>

        {error && <p className="statusDown">{error}</p>}

        {!loading && !error && looked && (
          <>
            {isSelfExcluded && (
              <p className="statusDown" style={{ fontWeight: 600 }}>
                This user is permanently self-excluded. There is no lift path.
              </p>
            )}

            {usage && (
              <>
                <h2>Current rolling-window usage ({usage.windowHours}h)</h2>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Stake held</th>
                      <th>Realized losses</th>
                      <th>Deposited</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{formatMinorAmount(usage.stakeHeldMinor)}</td>
                      <td>{formatMinorAmount(usage.lossMinor)}</td>
                      <td>{formatMinorAmount(usage.depositedMinor)}</td>
                    </tr>
                  </tbody>
                </table>
              </>
            )}

            <h2 style={{ marginTop: 24 }}>Restriction history</h2>
            {history.length === 0 ? (
              <p className="statusLine">No restrictions on record for this user.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Limit</th>
                    <th>Starts</th>
                    <th>Ends</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => {
                    const limitMinor = limitMinorOf(r);
                    return (
                      <tr key={r.id}>
                        <td>{r.type}</td>
                        <td>{r.status}</td>
                        <td>{limitMinor ? formatMinorAmount(limitMinor) : '—'}</td>
                        <td>{new Date(r.startsAt).toLocaleString()}</td>
                        <td>{r.endsAt ? new Date(r.endsAt).toLocaleString() : '—'}</td>
                        <td>{new Date(r.createdAt).toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function ResponsibleGamingPage() {
  return (
    <AuthGuard>
      <ResponsibleGamingContent />
    </AuthGuard>
  );
}
