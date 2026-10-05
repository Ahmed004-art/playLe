'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { fetchWallet, fetchLedger, fetchDeposits, ApiRequestError } from '@/lib/api-client';
import type { AdminWallet, AdminLedgerEntry, AdminDeposit } from '@/lib/wallet-types';
import { formatMinorAmount } from '@/lib/money-format';

function WalletsContent() {
  const [userId, setUserId] = useState('');
  const [wallet, setWallet] = useState<AdminWallet | null>(null);
  const [ledger, setLedger] = useState<AdminLedgerEntry[]>([]);
  const [deposits, setDeposits] = useState<AdminDeposit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lookup() {
    if (!userId.trim()) return;
    setLoading(true);
    setError(null);
    setWallet(null);
    try {
      const [walletRes, ledgerRes, depositsRes] = await Promise.all([
        fetchWallet(userId.trim()),
        fetchLedger(userId.trim()),
        fetchDeposits(userId.trim()),
      ]);
      setWallet(walletRes);
      setLedger(ledgerRes.items);
      setDeposits(depositsRes.items);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Failed to load wallet');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="badge">Phase 3 — Wallet Lookup</span>
        <Link href="/">Back to dashboard</Link>
      </div>

      <div className="wideCard">
        <h1>Wallet Lookup</h1>
        <p className="statusLine">
          Inspect any user&apos;s balance, ledger, and deposit history by user ID. There is no
          search-by-email here yet — copy the user ID from Prisma Studio or a support ticket.
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

        {wallet && (
          <>
            <h2>Balance</h2>
            <p>
              Available:{' '}
              <strong>{formatMinorAmount(wallet.availableBalanceMinor, wallet.currency)}</strong>{' '}
              &middot; Held:{' '}
              <strong>{formatMinorAmount(wallet.heldBalanceMinor, wallet.currency)}</strong>{' '}
              &middot; Total:{' '}
              <strong>{formatMinorAmount(wallet.totalBalanceMinor, wallet.currency)}</strong>
            </p>

            <h2 style={{ marginTop: 24 }}>Deposits</h2>
            {deposits.length === 0 ? (
              <p className="statusLine">No deposits.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Provider</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {deposits.map((d) => (
                    <tr key={d.id}>
                      <td>{formatMinorAmount(d.amountMinor, d.currency)}</td>
                      <td>{d.status}</td>
                      <td>{d.provider}</td>
                      <td>{new Date(d.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h2 style={{ marginTop: 24 }}>Ledger</h2>
            {ledger.length === 0 ? (
              <p className="statusLine">No ledger entries.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Available Δ</th>
                    <th>Held Δ</th>
                    <th>Reason</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.type}</td>
                      <td>{formatMinorAmount(entry.availableDeltaMinor, entry.currency)}</td>
                      <td>{formatMinorAmount(entry.heldDeltaMinor, entry.currency)}</td>
                      <td>{entry.reason ?? '—'}</td>
                      <td>{new Date(entry.createdAt).toLocaleString()}</td>
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

export default function WalletsPage() {
  return (
    <AuthGuard>
      <WalletsContent />
    </AuthGuard>
  );
}
