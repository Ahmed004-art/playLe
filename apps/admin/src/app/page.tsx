'use client';

import Link from 'next/link';
import { HealthStatus } from '@/components/HealthStatus';
import { AuthGuard } from '@/components/AuthGuard';
import { useAuth } from '@/lib/auth-context';

function DashboardContent() {
  const { user, logout } = useAuth();

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="badge">Phase 3 — Wallet, Ledger &amp; Financial Foundation</span>
        <button onClick={() => logout()}>Log out</button>
      </div>
      <div className="card">
        <h1>PlayLe Admin</h1>
        <p className="statusLine">Signed in as {user?.username} (ADMIN).</p>
        <p className="statusLine">
          Match, social, and dispute management are implemented in later phases.
        </p>
        <p style={{ marginTop: 16 }}>
          <Link href="/withdrawals">Withdrawals →</Link>
        </p>
        <p style={{ marginTop: 8 }}>
          <Link href="/wallets">Wallet lookup →</Link>
        </p>
      </div>
      <div className="card">
        <h2>API Connectivity</h2>
        <HealthStatus />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <AuthGuard>
      <DashboardContent />
    </AuthGuard>
  );
}
