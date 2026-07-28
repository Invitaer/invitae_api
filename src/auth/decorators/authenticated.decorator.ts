import { SetMetadata, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Audience } from '../audience';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Guards a route for ONE application.
 *
 * The audience is required, with no default on purpose. It used to be
 * `@Auth()` meaning nothing but "someone is signed in", which is how
 * `/admin/users` ended up reachable by any logged-in user. Forcing the choice
 * at every call site makes "which app is this for?" impossible to skip.
 *
 * `@Auth('admin')` additionally requires the role to still be ADMIN — see
 * `JwtAdminStrategy`.
 */
export function Auth(audience: Audience) {
  return UseGuards(AuthGuard(`jwt-${audience}`));
}
