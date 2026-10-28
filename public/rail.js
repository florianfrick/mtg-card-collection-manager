// The right-hand rail: one small card per page you are not on.
//
// Each card repeats a number or two from the page it points at, because
// "List individually $385.67" is a more useful link than "Sell plan". The
// markup for the heading and the call to action is static in each page; these
// helpers only fill the numbers in, so a failed request degrades to a sentence
// instead of an empty card.

const usd = (v) => (v == null ? '—' : '$' + Number(v).toFixed(2));

/** Two-or-three label/value rows — the shape every rail teaser uses. */
function rows(pairs) {
  return '<dl class="teaser">'
    + pairs.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')
    + '</dl>';
}

/**
 * Fill a rail card with the sell plan's two piles. `el` is the container only:
 * the card's heading and its "Open the sell plan" link stay in the page.
 */
export async function mountSellTeaser(el) {
  try {
    const res = await fetch('/api/economics');
    if (!res.ok) throw new Error('the server returned ' + res.status);
    const econ = await res.json();
    const b = econ.plan?.buckets;
    if (!b) throw new Error('the response carried no plan');
    el.innerHTML = rows([
      ['List individually', usd(b.list.net)],
      ['One box to a buylist', usd(b.box.net)],
    ]) + `<p class="teaser-foot">${usd(econ.plan.totals.net)} if you sell both piles</p>`;
  } catch {
    el.innerHTML = '<p class="like-label">No figures yet — open the plan to see why.</p>';
  }
}

/**
 * Fill a rail card with the collection's size. `totals` is the economics
 * payload's `plan.totals`, which the sell page has already loaded, so this
 * costs no extra request — and keeps one definition of "market value".
 */
export function renderCollectionTeaser(el, totals) {
  if (!totals?.rows) {
    el.innerHTML = '<p class="like-label">Nothing in the collection yet.</p>';
    return;
  }
  el.innerHTML = rows([
    ['Cards', String(totals.copies)],
    ['Printings', String(totals.rows)],
    ['Market value', usd(totals.market)],
  ]);
}
