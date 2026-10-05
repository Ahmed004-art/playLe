'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

/**
 * Wraps a page that requires an authenticated admin. Route protection is
 * client-side (tokens live in localStorage, which Next.js middleware
 * can't read during server rendering) — see token-storage.ts for the
 * tradeoff. The actual authorization boundary is the API itself: this
 * only controls what the admin UI shows, not what the backend allows.
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
