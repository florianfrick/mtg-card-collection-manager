// Unit tests for the Scryfall wrapper (src/scryfall.js) with fetch stubbed out.
//
// These cover the two behaviours that are invisible until they break in the
// field: a set list that failed once must be retried (a sticky failure silently
// switches set-code validation off for the whole process), and the batch price
// call must stay inside Scryfall's 75-identifier limit.
import test from 'node:test';
import assert from 'node:assert/strict';

// The retry gate is time-based; the test drives it with a zero window so a
// "later" attempt happens immediately.
process.env.MTG_SETS_RETRY_MS = '0';

const sf = await import('../src/scryfall.js');

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Run `fn` with `fetch` replaced, restoring it afterwards. */
async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('a failed set list is retried instead of disabling set validation', async () => {
  let calls = 0;
  const stub = async () => {
    calls += 1;
    if (calls === 1) return new Response(null, { status: 404 });
    return json({
      data: [{ code: 'znr', name: 'Zendikar Rising', card_count: 391, printed_size: 280 }],
    });
  };

  await withFetch(stub, async () => {
    assert.equal(await sf.allSets(), null, 'the first attempt fails');
    const catalog = await sf.allSets();
    assert.ok(catalog, 'the second attempt must not be poisoned by the first');
    assert.equal(catalog.get('ZNR').name, 'Zendikar Rising');
    assert.equal(catalog.get('ZNR').printedSize, 280, 'completion uses the printed size');
    assert.equal((await sf.knownSets()).has('ZNR'), true);
  });
  assert.equal(calls, 2);
});

test('a catalog that is already loaded is never fetched again', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return json({ data: [{ code: 'woe', name: 'Wilds of Eldraine', printed_size: 276 }] });
  }, async () => {
    await sf.allSets();
    await sf.allSets();
    await sf.knownSets();
  });
  assert.equal(calls, 0, 'a loaded catalog must not be fetched again');
});

test('the batch price call stays inside 75 identifiers per request', async () => {
  const bodies = [];
  const ids = Array.from({ length: 80 }, (_, i) => `id-${i}`);
  await withFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return json({
      data: body.identifiers.map(({ id }) => ({
        id, rarity: 'rare', prices: { usd: '1.50', usd_foil: null },
      })),
    });
  }, () => sf.pricesForIds(ids));

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].identifiers.length, 75);
  assert.equal(bodies[1].identifiers.length, 5);
});

test('the batch price call carries rarity and keeps a missing foil price null', async () => {
  const prices = await withFetch(
    async () => json({ data: [{ id: 'abc', rarity: 'mythic', prices: { usd: '3.25', usd_foil: null } }] }),
    () => sf.pricesForIds(['abc'])
  );
  assert.deepEqual(prices.get('abc'), { usd: 3.25, usd_foil: null, rarity: 'mythic' });
});

test('a printing is normalised to the shape the app stores', () => {
  const p = sf.toPrinting({
    id: 'abc',
    name: 'Legion Angel',
    set: 'znr',
    set_name: 'Zendikar Rising',
    collector_number: '23',
    rarity: 'rare',
    image_uris: { normal: 'https://example.test/n.jpg', large: 'https://example.test/l.jpg' },
    prices: { usd: '0.30', eur: '0.25', usd_foil: '1.10' },
  });
  assert.equal(p.image_url, 'https://example.test/l.jpg');
  assert.deepEqual(p.prices, { usd: 0.3, eur: 0.25, usd_foil: 1.1, eur_foil: null });
});

test('a double-faced printing falls back to the front face image', () => {
  const p = sf.toPrinting({
    id: 'abc',
    name: 'Virtue of Loyalty // Ardenvale Fealty',
    set: 'woe',
    set_name: 'Wilds of Eldraine',
    collector_number: '38',
    card_faces: [{ image_uris: { normal: 'https://example.test/front.jpg' } }, {}],
    prices: {},
  });
  assert.equal(p.image_url, 'https://example.test/front.jpg');
});
