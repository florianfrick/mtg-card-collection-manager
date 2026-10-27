// The parts every page repeats: a DOM shorthand, HTML escaping, the JSON fetch
// wrapper (with the sign-in redirect) and the account slot in the hero.
//
// Loaded as an ES module by index.html (directly) and by collection.html and
// login.html (for the same helpers), so the three pages no longer carry their
// own copy of each.

export const $ = (sel, root = document) => root.querySelector(sel);

/** Escape text for interpolation into innerHTML. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 0.8734 -> "87%" (or "n/a" when the number is unknown). */
export const pct = (v) => (v == null ? 'n/a' : Math.round(v * 100) + '%');

const signInUrl = () => '/login.html?next=' + encodeURIComponent(location.pathname);

/**
 * JSON in, JSON out. A 401 means the session died in another tab: every page
 * sends the visitor to the sign-in page rather than showing a broken view.
 */
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    location.replace(signInUrl());
    throw new Error('signed out');
  }
  if (!res.ok) {
    let msg = res.status;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return res.json();
}

/** Whoever owns this browser's collection right now, or null. */
export async function currentUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.status === 401) { location.replace(signInUrl()); return null; }
    if (res.ok) return (await res.json()).user ?? null;
  } catch { /* offline: the page still works, the slot stays empty */ }
  return null;
}

/** Fill the hero account slot: a sign-in link for guests, name + sign out otherwise. */
export function renderAccount(user) {
  const box = $('#who');
  if (!box) return;
  box.innerHTML = user.isGuest
    ? `<a class="who-btn" href="${signInUrl()}">Sign in</a>`
    : `<span class="who-account"><span class="who-name">${escapeHtml(user.username || user.name)}</span>`
      + '<a href="#" id="logout">Sign out</a></span>';
  const out = $('#logout');
  if (out) out.addEventListener('click', async (e) => {
    e.preventDefault();
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* still gone from here */ }
    location.replace(signInUrl());
  });
}

/**
 * Mint-or-reuse the guest collection this browser collects under, then paint the
 * account slot. Called on load by every page, so cards added below are already
 * owned by whoever is looking.
 */
export async function bootIdentity() {
  try { await api('/api/auth/guest', { method: 'POST' }); }
  catch (e) { if (String(e.message) === 'signed out') return null; }
  const user = await currentUser();
  if (user) renderAccount(user);
  return user;
}
