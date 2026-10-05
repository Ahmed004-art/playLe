'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AuthGuard } from '@/components/AuthGuard';
import { fetchMatch, ApiRequestError } from '@/lib/api-client';
import type { AdminMatch } from '@/lib/match-types';

function MatchDetailContent() {
  const params = useParams<{ id: string }>();
  const matchId = params.id;
  const [match, setMatch] = useState<AdminMatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchMatch(matchId);
        if (!cancelled) setMatch(result);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiRequestError ? e.message : 'Failed to load match');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="badge">Phase 4 — Match Detail</span>
        <Link href="/matches">Back to matches</Link>
      </div>

      <div className="wideCard">
        <h1>Match {matchId.slice(0, 8)}…</h1>

        {loading && <p className="statusLine">Loading…</p>}
        {error && <p className="statusDown">{error}</p>}

        {!loading && !error && match && (
          <>
            <table className="table">
              <tbody>
                <tr>
                  <th>ID</th>
                  <td>{match.id}</td>
                </tr>
                <tr>
                  <th>Game</th>
                  <td>
                    {match.gameId} (v{match.gameVersion})
                  </td>
                </tr>
                <tr>
                  <th>Status</th>
                  <td>{match.status}</td>
                </tr>
                <tr>
                  <th>Result</th>
                  <td>
                    {match.resultIsDraw
                      ? 'Draw'
                      : match.winnerUserId
                        ? `Winner: ${match.winnerUserId}`
                        : '—'}
                  </td>
                </tr>
                <tr>
                  <th>Termination reason</th>
                  <td>{match.terminationReason ?? '—'}</td>
                </tr>
                <tr>
                  <th>State version</th>
                  <td>{match.stateVersion}</td>
                </tr>
                <tr>
                  <th>Created</th>
                  <td>{new Date(match.createdAt).toLocaleString()}</td>
                </tr>
                <tr>
                  <th>Started</th>
                  <td>{match.startedAt ? new Date(match.startedAt).toLocaleString() : '—'}</td>
                </tr>
                <tr>
                  <th>Completed</th>
                  <td>{match.completedAt ? new Date(match.completedAt).toLocaleString() : '—'}</td>
                </tr>
              </tbody>
            </table>

            <h2 style={{ marginTop: 24 }}>Players</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>User ID</th>
                  <th>Seat</th>
                  <th>Connected</th>
                </tr>
              </thead>
              <tbody>
                {match.players.map((p) => (
                  <tr key={p.userId}>
                    <td>{p.userId}</td>
                    <td>{p.seat}</td>
                    <td>{p.connected ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h2 style={{ marginTop: 24 }}>Game state (opaque to the platform)</h2>
            <pre className="statusLine" style={{ whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(match.state, null, 2)}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}

export default function MatchDetailPage() {
  return (
    <AuthGuard>
      <MatchDetailContent />
    </AuthGuard>
  );
}
