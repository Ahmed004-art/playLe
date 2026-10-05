'use client';

import { HealthStatus } from '@/components/HealthStatus';
import { AuthGuard } from '@/components/AuthGuard';
import { useAuth } from '@/lib/auth-context';

function DashboardContent() {
  const { user, logout } = useAuth();

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="badge">Phase 2 — Identity &amp; Authentication</span>
        <button onClick={() => logout()}>Log out</button>
      </div>
      <div className="card">
        <h1>PlayLe Admin</h1>
        <p className="statusLine">Signed in as {user?.username} (ADMIN).</p>
        <p className="statusLine">
          Dashboard shell only. User, match, transaction, and dispute management are implemented in
          later phases.
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
