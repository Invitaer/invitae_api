export interface CorsEnv {
  DASHBOARD_URL?: string;
  USER_DASHBOARD_URL?: string;
  INVITATION_URL?: string;
  CORS_EXTRA_ORIGINS?: string;
}

/**
 * Origins allowed to send credentials. `Access-Control-Allow-Origin: *` is
 * INVALID together with credentials, so once cookies are in play the allow-list
 * has to be explicit — a wildcard makes the browser reject every response.
 *
 * The frontend URLs stay single-valued because they double as OAuth and
 * email redirect targets; extra origins (e.g. the LAN IP used to open the
 * dashboards from another device) go in CORS_EXTRA_ORIGINS, comma-separated.
 */
export function corsOrigins(env: CorsEnv): string[] {
  const extra = (env.CORS_EXTRA_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return [
    env.DASHBOARD_URL ?? 'http://localhost:8090',
    env.USER_DASHBOARD_URL ?? 'http://localhost:8091',
    env.INVITATION_URL ?? 'http://localhost:8095',
    ...extra,
  ];
}
