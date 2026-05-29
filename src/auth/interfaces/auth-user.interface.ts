export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface OAuthProfile {
  email: string;
  name: string;
  accessToken?: string;
  refreshToken?: string;
}
