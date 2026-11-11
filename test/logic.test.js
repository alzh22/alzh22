import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, spreadPct } from '../src/metrics.js';
import { evaluateGate, splitAndRank, rewardRisk, passesUniverse } from '../src/gate.js';
import { DEFAULT_SETTINGS } from '../src/store.js';
import { etToMs, sessionTimes, sessionOf, prevWeekdays, etTimeStr } from '../src/time.js';

const MIN = 60_000;
const S = { ...DEFAULT_SETTINGS };

function makeBars(pmStart, specs) {
  return specs.map(([o, h, l, c, v], i) => ({ t: pmStart + i * MIN, o, h, l, c, v }));
}

test('ET conversion handles DST', () => {
  // 2026-07-01 04:00 EDT = 08:00 UTC; 2026-12-01 04:00 EST = 09:00 UTC
  assert.equal(new Date(etToMs(2026, 7, 1, 4, 0)).toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(new Date(etToMs(2026, 12, 1, 4, 0)).toISOString(), '2026-12-01T09:00:00.000Z');
  assert.equal(etTimeStr(etToMs(2026, 12, 1, 9, 24)), '09:24:00');
});

test('session classification and weekdays', () => {
  const { pmStart, open } = sessionTimes('2026-11-11');
  assert.equal(sessionOf(pmStart + 1), 'premarket');
  assert.equal(sessionOf(open + 1), 'regular');
  assert.equal(sessionOf(pmStart - 1), 'closed');
  assert.deepEqual(prevWeekdays('2026-11-09', 2), ['2026-11-06', '2026-11-05']); // Monday → Fri, Thu
});

test('spread %', () => {
  assert.equal(spreadPct(null, 1), null);
  assert.ok(Math.abs(spreadPct(9.99, 10.01) - 0.2) < 1e-9);
});

test('metrics: last COMPLETED bar, accel vs prior 5, prior PM high breakout', () => {
  const { pmStart, open } = sessionTimes('2026-11-11');
  const bars = makeBars(pmStart, [
    [1.0, 1.02, 0.99, 1.01, 100],
    [1.01, 1.03, 1.0, 1.02, 100],
    [1.02, 1.05, 1.01, 1.03, 100],
    [1.03, 1.04, 1.02, 1.03, 100],
    [1.03, 1.04, 1.02, 1.04, 100],
    [1.04, 1.1, 1.04, 1.09, 500], // last completed: breaks prior high 1.05 on close
    [1.09, 1.2, 1.08, 1.15, 9999], // still forming — must be ignored for 1M stats
  ]);
  const now = pmStart + 6 * MIN + 20_000;
  const m = computeMetrics({ bars, now, pmStart, open, lastPrice: 1.15, prevClose: 1.0, bid: 1.14, ask: 1.16, histPmVols: [400, 600, 500] });
  assert.equal(m.vol1m, 500);
  assert.equal(m.volAccel, 5);
  assert.equal(m.priorPmHigh, 1.05);
  assert.equal(m.breakout, true);
  assert.ok(Math.abs(m.changePct - 15) < 1e-9);
  assert.ok(Math.abs(m.bar1mChangePct - (1.09 / 1.04 - 1) * 100) < 1e-9);
  assert.equal(m.pmVol, 500 + 500 + 9999);
  assert.equal(m.rvol, 1000 / 500); // completed PM volume vs avg history
  assert.ok(m.distVwapPct > 0);
});

test('metrics: accel N/A without 5 prior bars; RVOL N/A with <3 history days', () => {
  const { pmStart, open } = sessionTimes('2026-11-11');
  const bars = makeBars(pmStart, [[1, 1, 1, 1, 10], [1, 1, 1, 1, 20]]);
  const m = computeMetrics({ bars, now: pmStart + 3 * MIN, pmStart, open, histPmVols: [5, 5] });
  assert.equal(m.volAccel, null);
  assert.equal(m.rvol, null);
});

test('reward/risk', () => {
  assert.equal(rewardRisk({ entry: 10, stop: 9, target: 12 }), 2);
  assert.equal(rewardRisk({ entry: 10, stop: 11, target: 12 }), 0);
  assert.equal(rewardRisk({ entry: 10 }), null);
});

const goodRow = {
  symbol: 'AAA',
  type: 'CS',
  spreadPct: 0.1,
  breakout: true,
  priorPmHigh: 1.3,
  lastBar: { c: 1.35 },
  distVwapPct: 2,
  pmVwap: 1.3,
  volAccel: 3,
};
const goodCtx = { settings: S, halal: 'halal', catalyst: { status: 'verified' }, plan: { entry: 1.35, stop: 1.3, target: 1.5 } };

test('gate: all 7 pass → qualified REVIEW', () => {
  const g = evaluateGate(goodRow, goodCtx);
  assert.equal(g.cleared, 7);
  assert.equal(g.qualified, true);
  assert.equal(g.action, 'REVIEW');
});

test('gate: missing data stays pending, never passes', () => {
  const g = evaluateGate({ ...goodRow, spreadPct: null, distVwapPct: null }, { ...goodCtx, halal: 'pending' });
  assert.equal(g.qualified, false);
  assert.equal(g.action, 'WAIT');
  assert.match(g.statusText, /Spread, VWAP and Sharia pending/);
});

test('gate: ETF and non-compliant are excluded', () => {
  assert.equal(evaluateGate({ ...goodRow, type: 'ETF' }, goodCtx).action, 'EXCLUDE');
  assert.equal(evaluateGate(goodRow, { ...goodCtx, halal: 'not' }).action, 'EXCLUDE');
});

test('gate: wide spread / poor R:R block qualification', () => {
  assert.equal(evaluateGate({ ...goodRow, spreadPct: 0.9 }, goodCtx).qualified, false);
  assert.equal(evaluateGate(goodRow, { ...goodCtx, plan: { entry: 1.35, stop: 1.3, target: 1.4 } }).qualified, false);
});

test('ranking: qualified only, by 1m vol accel desc then tighter spread', () => {
  const mk = (symbol, volAccel, spreadPct, qualified) => ({ symbol, volAccel, spreadPct, gate: { qualified, excluded: false } });
  const { qualified, watchlist } = splitAndRank([
    mk('A', 2, 0.3, true),
    mk('B', 5, 0.2, true),
    mk('C', 2, 0.1, true),
    mk('D', 9, 0.1, false),
  ]);
  assert.deepEqual(qualified.map((r) => [r.symbol, r.rank]), [['B', 1], ['C', 2], ['A', 3]]);
  assert.deepEqual(watchlist.map((r) => [r.symbol, r.rank]), [['D', null]]);
});

test('universe filters', () => {
  const row = { type: 'CS', price: 5, changePct: 20, pmVol: 2e6, rvol: null, exchange: 'nasdaq' };
  assert.equal(passesUniverse(row, S), true);
  assert.equal(passesUniverse({ ...row, type: 'WARRANT' }, S), false);
  assert.equal(passesUniverse({ ...row, pmVol: 1 }, S), false);
  assert.equal(passesUniverse({ ...row, rvol: 0.5 }, S), false);
  assert.equal(passesUniverse(row, { ...S, market: 'nyse' }), false);
});
