'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { listMatches, ApiRequestError } from '@/lib/api-client';
import type { AdminMatch } from '@/lib/match-types';

const STATUS_FILTERS = [
  'ALL',
  'WAITING',
  'READY',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'ABANDONED',
] as const;

function MatchesContent() {
  const [status, setStatus] = useState<string>('ALL');
  const [matches, setMatches] = useState<AdminMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await listMatches(status === 'ALL' ? undefined : status);
      setMatches(page.items);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Failed to load matches');
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
        <span className="badge">Phase 4 — Matches</span>
        <Link href="/">Back to dashboard</Link>
      </div>

      <div className="wideCard">
        <h1>Matches</h1>
        <p className="statusLine">
          Read-only visibility into every match. Outcomes are decided by the server only — there is
          no action here to set or override a result.
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

        {!loading && !error && matches.length === 0 && (
          <p className="statusLine">No matches in this status.</p>
        )}

        {!loading && !error && matches.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Game</th>
                <th>Status</th>
                <th>Players</th>
                <th>Winner</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {matches.map((m) => (
                <tr key={m.id}>
                  <td title={m.id}>{m.id.slice(0, 8)}…</td>
                  <td>{m.gameId}</td>
                  <td>{m.status}</td>
                  <td>{m.players.length}</td>
                  <td>
                    {m.resultIsDraw
                      ? 'Draw'
                      : m.winnerUserId
                        ? `${m.winnerUserId.slice(0, 8)}…`
                        : '—'}
                  </td>
                  <td>{new Date(m.createdAt).toLocaleString()}</td>
                  <td>
                    <Link href={`/matches/${m.id}`}>View →</Link>
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

export default function MatchesPage() {
  return (
    <AuthGuard>
      <MatchesContent />
    </AuthGuard>
  );
}
