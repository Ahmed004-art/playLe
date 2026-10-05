/** Mirrors the API's `UserResponseDto` — never includes a password or token. */
export interface AdminUser {
  id: string;
  email: string;
  phoneNumber: string | null;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  createdAt: string;
}

export interface AuthResponse {
  user: AdminUser;
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}
