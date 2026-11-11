import test from 'node:test';
import assert from 'node:assert/strict';
import { ExitManager } from '../src/exits.js';

function setup({ autoExits = true, price = 10, bid = 9.99, qty = 100 } = {}) {
  const store = { state: {}, save() {}, getSettings: () => ({ autoExits }) };
  const quote = { price, bid };
  const closed = [];
  const broker = {
    getPosition: async (s) => (qty ? { symbol: s, qty } : null),
    closePosition: async (s, limit, ext) => closed.push({ s, limit, ext }),
  };
  const provider = { getQuote: async () => quote, now: () => 0 };
  const m = new ExitManager({ store, provider, broker, sessionOf: () => 'premarket', log: () => {} });
  m.track({ symbol: 'AAA', stop: 9.5, target: 11 });
  return { m, quote, closed };
}

test('no action between stop and target', async () => {
  const { m, closed } = setup();
  await m.tick();
  assert.equal(closed.length, 0);
  assert.equal(m.list()[0].status, 'watching');
});

test('stop hit → marketable extended-hours limit sell, only once', async () => {
  const { m, quote, closed } = setup();
  quote.price = 9.4;
  quote.bid = 9.39;
  await m.tick();
  await m.tick();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].ext, true);
  assert.ok(closed[0].limit < 9.39);
  assert.match(m.list()[0].status, /^stop sent/);
});

test('target hit → sell at bid', async () => {
  const { m, quote, closed } = setup();
  quote.price = 11.2;
  quote.bid = 11.18;
  await m.tick();
  assert.deepEqual(closed[0], { s: 'AAA', limit: 11.18, ext: true });
});

test('disabled setting or unfilled entry → nothing sent', async () => {
  const a = setup({ autoExits: false, price: 5 });
  await a.m.tick();
  assert.equal(a.closed.length, 0);
  const b = setup({ qty: 0, price: 5 });
  await b.m.tick();
  assert.equal(b.closed.length, 0);
});
