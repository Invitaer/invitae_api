import {
  AUTH_COOKIE_MAX_AGE_MS,
  AUTH_COOKIE_NAMES,
  authCookieName,
  authCookieOptions,
  clearAuthCookieOptions,
  jwtCookieExtractor,
} from './auth-cookie';

describe('authCookieOptions', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('is always httpOnly — the whole point of the migration is that JS cannot read it', () => {
    expect(authCookieOptions().httpOnly).toBe(true);
  });

  it('defaults to lax, which is correct whenever the dashboard and the API share a registrable domain', () => {
    delete process.env.AUTH_COOKIE_SAMESITE;
    expect(authCookieOptions().sameSite).toBe('lax');
  });

  it('forces secure when sameSite is none, because browsers drop None cookies without it', () => {
    process.env.AUTH_COOKIE_SAMESITE = 'none';
    process.env.AUTH_COOKIE_SECURE = 'false';

    const options = authCookieOptions();

    expect(options.sameSite).toBe('none');
    expect(options.secure).toBe(true);
  });

  it('marks the cookie secure in production even when sameSite stays lax', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AUTH_COOKIE_SAMESITE;
    delete process.env.AUTH_COOKIE_SECURE;

    expect(authCookieOptions().secure).toBe(true);
  });

  it('leaves the cookie host-only unless a domain is configured', () => {
    delete process.env.AUTH_COOKIE_DOMAIN;
    expect(authCookieOptions().domain).toBeUndefined();

    process.env.AUTH_COOKIE_DOMAIN = '.invitae.com';
    expect(authCookieOptions().domain).toBe('.invitae.com');
  });

  it('expires in step with the 7-day JWT lifetime', () => {
    expect(authCookieOptions().maxAge).toBe(AUTH_COOKIE_MAX_AGE_MS);
    expect(AUTH_COOKIE_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('clears with the same attributes minus maxAge — a mismatch leaves the cookie alive', () => {
    process.env.AUTH_COOKIE_DOMAIN = '.invitae.com';

    const set = authCookieOptions();
    const clear = clearAuthCookieOptions();

    expect(clear.domain).toBe(set.domain);
    expect(clear.sameSite).toBe(set.sameSite);
    expect(clear.secure).toBe(set.secure);
    expect(clear.path).toBe(set.path);
    expect(clear.maxAge).toBeUndefined();
  });
});

/**
 * The cookie NAME is the only thing keeping the two dashboards apart.
 *
 * Cookies are not scoped by port: `localhost:8090`, `localhost:8091` and
 * `localhost:3000` share one jar. Two apps writing the same name at the same
 * host and path are writing the SAME cookie, and the last login wins.
 */
describe('authCookieName', () => {
  it('gives each audience its own cookie so one session cannot overwrite the other', () => {
    expect(authCookieName('admin')).not.toBe(authCookieName('user'));
  });

  it('no longer uses the shared `auth_token` name that both dashboards collided on', () => {
    expect(Object.values(AUTH_COOKIE_NAMES)).not.toContain('auth_token');
  });
});

describe('jwtCookieExtractor', () => {
  it('reads only the cookie belonging to its own audience', () => {
    const jar = {
      cookies: {
        [authCookieName('admin')]: 'admin-jwt',
        [authCookieName('user')]: 'user-jwt',
      },
    };

    expect(jwtCookieExtractor('admin')(jar)).toBe('admin-jwt');
    expect(jwtCookieExtractor('user')(jar)).toBe('user-jwt');
  });

  it('ignores the other audience entirely — both cookies coexist once you use both apps', () => {
    // The exact situation that produced the bug: an admin session open in one
    // tab and a user session in another. Neither may answer for the other.
    const onlyUser = { cookies: { [authCookieName('user')]: 'user-jwt' } };

    expect(jwtCookieExtractor('admin')(onlyUser)).toBeNull();
  });

  it('returns null when the request has no cookies at all', () => {
    expect(jwtCookieExtractor('user')({})).toBeNull();
    expect(jwtCookieExtractor('user')({ cookies: {} })).toBeNull();
  });

  it('returns null for a non-string value instead of handing garbage to passport', () => {
    expect(
      jwtCookieExtractor('user')({
        cookies: { [authCookieName('user')]: 123 as never },
      }),
    ).toBeNull();
  });
});
