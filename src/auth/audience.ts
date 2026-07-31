/**
 * Which application a session belongs to.
 *
 * This exists because a session is not just "who you are" but also "where you
 * signed in". The admin dashboard and the user dashboard are different
 * applications with different privileges, and a token minted for one must
 * never be accepted by the other.
 *
 * Deliberately a leaf module with no imports: the cookie layer, the JWT
 * strategies and the route decorator all need this type, and any of them
 * owning it would drag the others into a dependency it does not want.
 */
export const AUDIENCES = ['admin', 'user'] as const;

export type Audience = (typeof AUDIENCES)[number];
