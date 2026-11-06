import { corsOrigins } from './cors';

describe('corsOrigins', () => {
  it('falls back to the localhost frontends when nothing is configured', () => {
    expect(corsOrigins({})).toEqual([
      'http://localhost:8090',
      'http://localhost:8091',
      'http://localhost:8095',
    ]);
  });

  it('uses the configured frontend URLs', () => {
    expect(
      corsOrigins({
        DASHBOARD_URL: 'https://admin.invitae.com',
        USER_DASHBOARD_URL: 'https://app.invitae.com',
        INVITATION_URL: 'https://invitae.com',
      }),
    ).toEqual(['https://admin.invitae.com', 'https://app.invitae.com', 'https://invitae.com']);
  });

  it('appends every comma-separated CORS_EXTRA_ORIGINS entry, trimmed', () => {
    expect(
      corsOrigins({
        CORS_EXTRA_ORIGINS: ' http://192.168.68.73:8091 , http://192.168.68.73:8095,',
      }),
    ).toEqual([
      'http://localhost:8090',
      'http://localhost:8091',
      'http://localhost:8095',
      'http://192.168.68.73:8091',
      'http://192.168.68.73:8095',
    ]);
  });

  it('ignores an empty CORS_EXTRA_ORIGINS', () => {
    expect(corsOrigins({ CORS_EXTRA_ORIGINS: '' })).toHaveLength(3);
  });
});
