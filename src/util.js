export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Convert a possibly-null/empty string to a number, else null. */
export function numOrNull(v) {
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return null;
  return Number(v);
}

/**
 * Refuse a mutating request that came from another origin.
 *
 * There is no session cookie to steal any more, but the app still answers on a
 * port, and a page on any other site can POST to it: without this, a stray tab
 * could add or delete cards in the collection. Browsers send `Origin` on POST and
 * PUT, so comparing it to `Host` is enough — and a request with no `Origin`
 * (curl, a native client) has nothing to forge.
 */
export function sameOriginOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.headers.host) return next();
  } catch { /* not a URL: fall through to the refusal */ }
  res.status(403).json({ error: 'cross-origin request refused' });
}