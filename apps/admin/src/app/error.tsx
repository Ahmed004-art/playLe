'use client';

import { useEffect } from 'react';

/**
 * Error handling foundation. Next.js renders this boundary for any
 * unhandled error thrown while rendering a route. Errors are logged
 * client-side for now; server-side structured logging/reporting is added
 * alongside real administrative features in a later phase.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="page">
      <div className="card">
        <h1>Something went wrong</h1>
        <p className="statusLine">{error.message}</p>
        <button onClick={reset}>Try again</button>
      </div>
    </div>
  );
}
