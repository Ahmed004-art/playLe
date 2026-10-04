import { HealthStatus } from '@/components/HealthStatus';

export default function DashboardPage() {
  return (
    <div className="page">
      <div>
        <span className="badge">Phase 1 — Foundation</span>
      </div>
      <div className="card">
        <h1>PlayLe Admin</h1>
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
