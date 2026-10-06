'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AuthGuard } from '@/components/AuthGuard';
import { fetchMatch, fetchMatchFinancial, ApiRequestError } from '@/lib/api-client';
import type { AdminMatch, AdminMatchFinancial } from '@/lib/match-types';
import { formatMinorAmount } from '@/lib/money-format';

function MatchDetailContent() {
  const params = useParams<{ id: string }>();
  const matchId = params.id;
  const [match, setMatch] = useState<AdminMatch | null>(null);
  const [financial, setFinancial] = useState<AdminMatchFinancial | null>(null);
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
        // Financial detail is additive to the core match record. A
        // failure here (e.g. an older/free-play match the financial
        // endpoint can't resolve) should never block the match detail
        // above from rendering, so it's fetched and handled separately.
        try {
          const financialResult = await fetchMatchFinancial(matchId);
          if (!cancelled) setFinancial(financialResult);
        } catch {
          if (!cancelled) setFinancial(null);
        }
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

  const stake = financial?.stake ?? null;
  const settlement = financial?.settlement ?? null;

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

            {stake && (
              <>
                <h2 style={{ marginTop: 24 }}>Financial</h2>
                <p className="statusLine">
                  Read-only. Settlement is computed deterministically by the server — there is no
                  action here to set a winner or credit/debit a wallet directly.
                </p>
                <table className="table">
                  <tbody>
                    <tr>
                      <th>Stake status</th>
                      <td>{stake.status}</td>
                    </tr>
                    <tr>
                      <th>Currency</th>
                      <td>{stake.currency}</td>
                    </tr>
                    <tr>
                      <th>Stake amount</th>
                      <td>{formatMinorAmount(stake.stakeAmountMinor, stake.currency)}</td>
                    </tr>
                    <tr>
                      <th>Prize pool</th>
                      <td>{formatMinorAmount(stake.poolAmountMinor, stake.currency)}</td>
                    </tr>
                  </tbody>
                </table>

                <h3 style={{ marginTop: 16 }}>Stake holds</h3>
                <table className="table">
                  <thead>
                    <tr>
                      <th>User ID</th>
                      <th>Held at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stake.players.map((p) => (
                      <tr key={p.userId}>
                        <td>{p.userId}</td>
                        <td>{p.heldAt ? new Date(p.heldAt).toLocaleString() : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {settlement && (
                  <>
                    <h3 style={{ marginTop: 16 }}>Settlement</h3>
                    <table className="table">
                      <tbody>
                        <tr>
                          <th>Outcome</th>
                          <td>{settlement.outcome}</td>
                        </tr>
                        <tr>
                          <th>Status</th>
                          <td>{settlement.status}</td>
                        </tr>
                        <tr>
                          <th>Prize pool</th>
                          <td>
                            {formatMinorAmount(settlement.poolAmountMinor, settlement.currency)}
                          </td>
                        </tr>
                        <tr>
                          <th>Platform fee</th>
                          <td>
                            {formatMinorAmount(
                              settlement.platformFeeAmountMinor,
                              settlement.currency,
                            )}
                          </td>
                        </tr>
                        <tr>
                          <th>Completed</th>
                          <td>
                            {settlement.completedAt
                              ? new Date(settlement.completedAt).toLocaleString()
                              : '—'}
                          </td>
                        </tr>
                      </tbody>
                    </table>

                    <h3 style={{ marginTop: 16 }}>Settlement entries</h3>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>User ID</th>
                          <th>Role</th>
                          <th>Available delta</th>
                          <th>Held delta</th>
                        </tr>
                      </thead>
                      <tbody>
                        {settlement.entries.map((entry, i) => (
                          <tr key={`${entry.userId}-${entry.role}-${i}`}>
                            <td>{entry.userId}</td>
                            <td>{entry.role}</td>
                            <td>
                              {formatMinorAmount(entry.availableDeltaMinor, settlement.currency)}
                            </td>
                            <td>{formatMinorAmount(entry.heldDeltaMinor, settlement.currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </>
            )}
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
