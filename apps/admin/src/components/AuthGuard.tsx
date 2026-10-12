'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

/**
 * Wraps a page that requires an authenticated admin. Route protection is
 * client-side (the session lives in httpOnly cookies that Next.js
 * middleware could read, but there is no middleware-based gate yet — see
 * `auth-context.tsx`, which asks the API via `GET /admin/session/me`
 * whether a valid session cookie is present). The actual authorization
 * boundary is the API itself: this only controls what the admin UI
 * shows, not what the backend allows.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login');
    }
  }, [status, router]);

  if (status !== 'authenticated') {
    return (
      <div className="page">
        <p className="statusLine">Loading…</p>
      </div>
    );
  }

  return <>{children}</>;
}
