import { UserRole } from '../../database/schema/users.schema';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface OAuthProfile {
  email: string;
  name: string;
  accessToken?: string;
  refreshToken?: string;
}
