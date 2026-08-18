/**
 * Authentication.
 *
 * Opaque bearer tokens against a user table, with rotating refresh tokens —
 * enough to make "who says so" answerable, which is the point. An inspection is
 * evidence; evidence needs an author.
 *
 * Deliberately NOT production auth: passwords are plain text, tokens are random
 * strings rather than signed JWTs, and there is no rate limiting, lockout or
 * password reset. Those are called out in the README rather than half-built,
 * because a hand-rolled approximation of security is worse than an obvious gap.
 */

import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { store } from './store.ts';
import type { Role, Session, User } from './store.ts';

/** Short-lived, per contract §2 — the refresh token is what keeps a shift going. */
const ACCESS_TTL_MS = 30 * 60_000;
const REFRESH_TTL_MS = 60 * 86_400_000;

const token = () => randomBytes(24).toString('hex');

/**
 * Express 5 widens route params to `string | string[]` to allow repeats. None of
 * our routes take repeated params, so pin them to strings here rather than
 * casting at every call site.
 */
export interface AuthedRequest extends Request<Record<string, string>> {
  user?: User;
}

export function issue(user: User, deviceId?: string): Session & { expires_in: number } {
  const session: Session = {
    access_token: token(),
    refresh_token: token(),
    user_id: user.id,
    expires_at: Date.now() + ACCESS_TTL_MS,
    device_id: deviceId,
    issued_at: new Date().toISOString(),
  };
  store.addSession(session);
  return { ...session, expires_in: Math.floor(ACCESS_TTL_MS / 1000) };
}

export function rotate(refreshToken: string): (Session & { expires_in: number }) | null {
  const existing = store.sessionByRefresh(refreshToken);
  if (!existing) return null;
  if (Date.now() - Date.parse(existing.issued_at) > REFRESH_TTL_MS) return null;

  const user = store.user(existing.user_id);
  if (!user) return null;

  // Rotate rather than reissue: a refresh token used twice is a stolen one.
  store.removeSession(refreshToken);
  return issue(user, existing.device_id);
}

export function resolve(req: Request): User | null {
  const header = req.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const session = store.session(header.slice(7).trim());
  if (!session || session.expires_at < Date.now()) return null;
  return store.user(session.user_id) ?? null;
}

function deny(res: Response, status: number, title: string, detail: string) {
  res.status(status).type('application/problem+json').json({
    type: `https://frcde.local/errors/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
  });
}

/**
 * Require a signed-in user, optionally of a given role.
 *
 * 401 means "your token is stale, refresh and retry" — the CFPI outbox treats it
 * as transient. 403 means "this account may not do this", which retrying will
 * never fix, so it dead-letters instead.
 */
export function requireAuth(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const user = resolve(req);
    if (!user) {
      return deny(res, 401, 'Not authenticated', 'Sign in, or refresh your token.');
    }
    if (roles.length > 0 && !roles.includes(user.role)) {
      return deny(
        res,
        403,
        'Not permitted',
        `This action needs the ${roles.join(' or ')} role; you are ${user.role}.`,
      );
    }
    req.user = user;
    next();
  };
}

export const publicUser = (u: User) => ({
  id: u.id,
  name: u.name,
  username: u.username,
  role: u.role,
  depot: u.depot,
});
