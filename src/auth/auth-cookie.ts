import type { CookieOptions } from 'express';
import type { Audience } from './audience';

/**
 * One cookie name per application — and they MUST differ.
 *
 * Cookies are not scoped by port: `localhost:8090` (admin), `localhost:8091`
 * (user) and `localhost:3000` (API) all share a single cookie jar, because a
 * cookie is identified by name + domain + path and the port is not part of
 * that. Both dashboards previously wrote `auth_token`, which made them the
 * same cookie: whoever logged in last silently replaced the other session.
 *
 * The names are also prefixed so they cannot collide with anything else living
 * on `localhost` during development.
 */
export const AUTH_COOKIE_NAMES: Record<Audience, string> = {
  admin: 'invitae_admin_session',
  user: 'invitae_user_session',
};

export function authCookieName(audience: Audience): string {
  return AUTH_COOKIE_NAMES[audience];
}

/** Kept in step with the JWT's own lifetime so both expire together. */
export const AUTH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Attributes for the session cookie.
 *
 * `sameSite` and `domain` are env-driven because the right value depends on
 * how the dashboard and the API are deployed relative to each other:
 *
 *  - Same registrable domain — `localhost:8091` → `localhost:3000`, or
 *    `app.invitae.com` → `api.invitae.com`. `lax` is enough: a "site" is the
 *    registrable domain, and PORTS ARE NOT PART OF IT, so these count as
 *    same-site requests. A cookie set by the dashboard host only reaches the
 *    API host if `AUTH_COOKIE_DOMAIN` widens it (e.g. `.invitae.com`).
 *  - Genuinely different sites — `none`, which browsers only honour together
 *    with `Secure`, so HTTPS stops being optional.
 *
 * Getting this wrong fails SILENTLY: the browser simply never sends the
 * cookie and every request looks unauthenticated, which reads like a broken
 * login rather than a misconfigured cookie.
 */
export function authCookieOptions(): CookieOptions {
  const sameSite = readSameSite();

  return {
    httpOnly: true,
    sameSite,
    // `SameSite=None` is dropped outright by browsers unless Secure is set, so
    // the env flag cannot be trusted to lower it.
    secure: sameSite === 'none' || readSecure(),
    domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
    path: '/',
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
  };
}

/**
 * Clearing a cookie only works when domain/path/sameSite/secure match the
 * ones it was set with — otherwise the browser treats it as a DIFFERENT
 * cookie, writes an empty one alongside, and the original stays valid.
 */
export function clearAuthCookieOptions(): CookieOptions {
  const { maxAge: _maxAge, ...rest } = authCookieOptions();
  return rest;
}

/**
 * Builds the passport-jwt extractor for ONE audience.
 *
 * Reading only its own cookie is what makes the isolation real: once you have
 * used both dashboards, the browser holds both cookies and sends both on every
 * request. An extractor that accepted "whichever token is present" would
 * happily authenticate an admin route with a user session.
 *
 * Shaped as a passport-jwt extractor, which must return `null` (never
 * `undefined`) when absent.
 */
export function jwtCookieExtractor(audience: Audience) {
  const name = authCookieName(audience);

  return (req: { cookies?: Record<string, unknown> }): string | null => {
    const raw = req?.cookies?.[name];
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };
}

function readSameSite(): 'lax' | 'strict' | 'none' {
  const configured = (process.env.AUTH_COOKIE_SAMESITE ?? '').toLowerCase();
  return configured === 'none' || configured === 'strict' || configured === 'lax'
    ? configured
    : 'lax';
}

function readSecure(): boolean {
  const configured = process.env.AUTH_COOKIE_SECURE;
  if (configured != null && configured !== '') return configured === 'true';
  return (process.env.NODE_ENV ?? 'development') === 'production';
}
