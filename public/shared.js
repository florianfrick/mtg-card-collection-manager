// The parts every page repeats: a DOM shorthand, HTML escaping, and the JSON
// fetch wrapper.
//
// Loaded as an ES module by index.html (directly) and by collection.html, so the
// two pages do not carry their own copy of each.

export const $ = (sel, root = document) => root.querySelector(sel);

/** Escape text for interpolation into innerHTML. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 0.8734 -> "87%" (or "n/a" when the number is unknown). */
export const pct = (v) => (v == null ? 'n/a' : Math.round(v * 100) + '%');

/** JSON in, JSON out. The server answers errors as `{ error }`. */
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.status;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return res.json();
}
