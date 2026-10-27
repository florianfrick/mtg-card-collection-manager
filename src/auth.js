// ---------------------------------------------------------------------------
// Accounts, guest identities and sessions.
//
// Shape of this file: passwords are hashed with node's own scrypt (no
// dependency), a session is an opaque random token whose SHA-256 is all the
// database stores (a leaked mtg.db therefore holds no usable cookie), and the
// browser carries that token in an HttpOnly cookie. A *guest* is a plain `user`
// row with no credentials — which is why every collection route works for an
// anonymous visitor exactly as it does for an account: it answers for whoever
// the cookie points at.
// ---------------------------------------------------------------------------
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  countGuests, createSession, createUser, deleteSession, getSessionUser, touchSession,
} from './db.js';

const COOKIE = 'mtg_session';
const KEYLEN = 64;
const SCRYPT_ITERS = 16384; // ~16 MB per hash: quick to log in, slow to grind
const DAY_MS = 864e5;

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const on = (v, d) => (v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

/**
 * Every knob lives here, so the routes below read as policy-free plumbing. The
 * defaults are the local-first case: guests on and sign-up open.
 */
export const AUTH = {
  accountTtlDays: num(process.env.MTG_SESSION_DAYS, 30),
  guestTtlDays: num(process.env.MTG_GUEST_SESSION_DAYS, 14),
  allowGuests: on(process.env.MTG_ALLOW_GUESTS, true),
  allowSignup: on(process.env.MTG_ALLOW_SIGNUP, true),
  secureCookies: on(process.env.MTG_SECURE_COOKIES, false),
  maxGuests: num(process.env.MTG_MAX_GUESTS, 500),
  guestMintsPerDay: num(process.env.MTG_GUEST_MINTS_PER_DAY, 20),
  signupsPerHour: num(process.env.MTG_SIGNUPS_PER_HOUR, 5),
};

// ---- Passwords -------------------------------------------------------------

export const MIN_PASSWORD = 8;

/** scrypt with a per-user salt; the cost travels with the row so it can move. */
export function hashPassword(password, salt = randomBytes(16).toString('hex'), iters = SCRYPT_ITERS) {
  return {
    passwordHash: scryptSync(String(password), salt, KEYLEN, { N: iters }).toString('hex'),
    passwordSalt: salt,
    passwordIters: iters,
  };
}

/** Constant-time check. A row without credentials (a guest) can never log in. */
export function verifyPassword(password, user) {
  if (!user?.password_hash || !user?.password_salt) return false;
  const given = Buffer.from(
    hashPassword(password, user.password_salt, user.password_iters || SCRYPT_ITERS).passwordHash,
    'hex'
  );
  const stored = Buffer.from(user.password_hash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}

/** Usernames are lower-cased, so `Ada` and `ada` are the same account. */
export function cleanUsername(value) {
  const username = String(value ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username) ? username : null;
}

// ---- Tokens & cookies ------------------------------------------------------

export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

/** How long this identity's session lives (guests expire sooner). */
export const sessionTtlDays = (user) =>
  (Number(user?.is_guest) === 1 ? AUTH.guestTtlDays : AUTH.accountTtlDays);

/** Create a session for `userId` and hand the browser the cookie. */
export function startSession(res, userId, ttlDays) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  createSession({ tokenHash, userId, ttlDays });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: AUTH.secureCookies,
    maxAge: ttlDays * DAY_MS,
  });
  return { token, tokenHash };
}

/** Drop one session and clear the cookie. */
export function endSession(res, tokenHash) {
  if (tokenHash) deleteSession(tokenHash);
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure: AUTH.secureCookies });
}

function readCookie(req) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

// ---- Throttling ------------------------------------------------------------

// In-memory and process-local on purpose: this app is one process, and a
// dependency-free counter is enough to turn a brute-force loop into a slow one.
const failures = new Map(); // key -> { fails, until, seen }
const windows = new Map(); // key -> { count, resetAt }
const MAX_FAILS = 5;
const BASE_BLOCK_MS = 30_000;
const MAX_BLOCK_MS = 15 * 60_000;

function prune(map, now) {
  if (map.size <= 1000) return;
  for (const [key, value] of map) {
    if (now - (value.seen ?? value.resetAt) > 3600_000) map.delete(key);
  }
}

/** Milliseconds left on a lockout for `key` (0 = not locked out). */
export function lockoutMs(key) {
  const left = (failures.get(key)?.until ?? 0) - Date.now();
  return left > 0 ? left : 0;
}

/** Count a failed attempt; after MAX_FAILS the key backs off exponentially. */
export function noteFailure(key) {
  const now = Date.now();
  const entry = failures.get(key) ?? { fails: 0, until: 0 };
  entry.fails += 1;
  entry.seen = now;
  if (entry.fails >= MAX_FAILS) {
    entry.until = now + Math.min(MAX_BLOCK_MS, BASE_BLOCK_MS * 2 ** (entry.fails - MAX_FAILS));
  }
  failures.set(key, entry);
  prune(failures, now);
}

export const clearFailures = (key) => failures.delete(key);

/** Simple fixed-window counter: at most `max` hits per `windowMs`. */
export function withinLimit(key, max, windowMs) {
  const now = Date.now();
  const window = windows.get(key);
  if (!window || window.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  window.count += 1;
  prune(windows, now);
  return window.count <= max;
}

// ---- Request identity ------------------------------------------------------

/** Resolve the session cookie into req.user / req.userId. Creates nothing. */
export function attachUser(req, _res, next) {
  const token = readCookie(req);
  if (token) {
    const tokenHash = hashToken(token);
    const found = getSessionUser(tokenHash);
    if (found) {
      req.user = found.user;
      req.userId = found.user.id;
      req.sessionTokenHash = tokenHash;
      // Sliding expiry, written at most once an hour instead of per request.
      if (Date.now() - new Date(found.session.last_seen_at).getTime() > 3600_000) {
        touchSession(tokenHash, sessionTtlDays(found.user));
      }
    }
  }
  next();
}

/**
 * Give an anonymous caller a collection of their own: a guest identity.
 * Returns `{ user }`, or `{ status, error }` when guests are off or the caller
 * has had plenty.
 */
export function mintIdentity(req, res) {
  if (!AUTH.allowGuests) return { status: 401, error: 'sign in to continue' };
  if (countGuests() >= AUTH.maxGuests) {
    return { status: 503, error: 'too many guest collections right now — try again later' };
  }
  if (!withinLimit(`guest:${req.ip || ''}`, AUTH.guestMintsPerDay, DAY_MS)) {
    return { status: 429, error: 'too many guest collections from this address today' };
  }
  const user = createUser({ name: `Guest ${randomBytes(2).toString('hex')}`, isGuest: true });
  startSession(res, user.id, AUTH.guestTtlDays);
  return { user };
}

/**
 * The route needs an owner. An account or a guest passes; an anonymous visitor
 * gets a guest identity on the spot, so the pages work before anyone signs up.
 */
export function requireIdentity(req, res, next) {
  if (req.user) return next();
  const minted = mintIdentity(req, res);
  if (!minted.user) return res.status(minted.status).json({ error: minted.error });
  req.user = minted.user;
  req.userId = minted.user.id;
  next();
}

/** Account management: a guest is not enough. */
export function requireUser(req, res, next) {
  if (req.user && Number(req.user.is_guest) !== 1) return next();
  res.status(403).json({ error: 'sign in with an account to do that' });
}

/**
 * CSRF guard. The session rides in a cookie, so a mutating request must come
 * from the same origin: `SameSite=Lax` already stops modern browsers from
 * cross-site POSTs and this closes the gap for anything older (and for
 * hand-written clients) without a token dance.
 */
export function sameOriginOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // curl and same-origin requests send none — nothing to forge
  try {
    if (new URL(origin).host === req.headers.host) return next();
  } catch { /* not a URL: fall through to the refusal */ }
  res.status(403).json({ error: 'cross-origin request refused' });
}
