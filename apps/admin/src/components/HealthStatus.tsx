'use client';

import { useEffect, useState } from 'react';
import { ApiRequestError, getHealth, type HealthCheckResponse } from '@/lib/api-client';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; data: HealthCheckResponse };

export function HealthStatus() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    getHealth()
      .then((data) => {
        if (!cancelled) setState({ kind: 'success', data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof ApiRequestError ? error.message : 'Unable to reach the API';
        setState({ kind: 'error', message });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return <p className="statusLine">Checking API health…</p>;
  }

  if (state.kind === 'error') {
    return <p className="statusLine statusDown">API unreachable: {state.message}</p>;
  }

  const { checks } = state.data;
  return (
    <ul className="statusList">
      <li className={checks.postgres === 'up' ? 'statusUp' : 'statusDown'}>
        PostgreSQL: {checks.postgres}
      </li>
      <li className={checks.redis === 'up' ? 'statusUp' : 'statusDown'}>Redis: {checks.redis}</li>
    </ul>
  );
}
