// Pure metric calculations from 1-minute bars + quote. No I/O here.
// Bar shape: { t (bar start, ms), o, h, l, c, v, vw? }

const MIN = 60_000;

const sum = (arr) => arr.reduce((a, b) => a + b, 0);

export function spreadPct(bid, ask) {
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  return ((ask - bid) / ((ask + bid) / 2)) * 100;
}

export function vwap(bars) {
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    if (!(b.v > 0)) continue;
    const px = b.vw > 0 ? b.vw : (b.h + b.l + b.c) / 3;
    pv += px * b.v;
    vol += b.v;
  }
  return vol > 0 ? pv / vol : null;
}

/**
 * @param {object} p
 * @param {Array}  p.bars        1-minute bars from 04:00 ET (may include the bar still forming)
 * @param {number} p.now
 * @param {number} p.pmStart     04:00 ET
 * @param {number} p.open        09:30 ET
 * @param {number} [p.lastPrice] latest trade
 * @param {number} [p.prevClose]
 * @param {number} [p.bid]
 * @param {number} [p.ask]
 * @param {number[]} [p.histPmVols] cumulative premarket volume of prior days up to the same clock time
 * @param {number} [p.accelLookback=5]
 * @param {number} [p.minRvolDays=3]
 */
export function computeMetrics(p) {
  const { now, pmStart, open, accelLookback = 5, minRvolDays = 3 } = p;
  const bars = (p.bars || []).filter((b) => b.t >= pmStart && b.t <= now).sort((a, b) => a.t - b.t);
  const completed = bars.filter((b) => b.t + MIN <= now);
  const pmBars = bars.filter((b) => b.t < open);
  const pmCompleted = completed.filter((b) => b.t < open);

  const last = completed.at(-1) ?? null;
  const prevBar = completed.at(-2) ?? null;
  const prior = completed.slice(-(accelLookback + 1), -1);

  const price = p.lastPrice > 0 ? p.lastPrice : (bars.at(-1)?.c ?? null);
  const prevClose = p.prevClose > 0 ? p.prevClose : null;

  const changePct = price != null && prevClose ? (price / prevClose - 1) * 100 : null;

  let bar1mChangePct = null;
  if (last) {
    const ref = prevBar?.c ?? last.o;
    if (ref > 0) bar1mChangePct = (last.c / ref - 1) * 100;
  }

  const vol1m = last ? last.v : null;
  let volAccel = null;
  if (last && prior.length === accelLookback) {
    const avg = sum(prior.map((b) => b.v)) / prior.length;
    if (avg > 0) volAccel = last.v / avg;
  }

  const pmVol = sum(pmBars.map((b) => b.v));
  const pmVolCompleted = sum(pmCompleted.map((b) => b.v));

  // Prior PM high = highest high of completed PM bars BEFORE the last completed bar.
  const priorPm = last ? pmCompleted.filter((b) => b.t < last.t) : pmCompleted;
  const priorPmHigh = priorPm.length ? Math.max(...priorPm.map((b) => b.h)) : null;
  const pmHigh = pmBars.length ? Math.max(...pmBars.map((b) => b.h)) : null;
  const breakout = last && priorPmHigh != null ? last.c > priorPmHigh : null;

  const pmVwap = vwap(pmBars);
  const distVwapPct = price != null && pmVwap ? (price / pmVwap - 1) * 100 : null;

  const hist = (p.histPmVols || []).filter((v) => v > 0);
  let rvol = null;
  if (hist.length >= minRvolDays && pmCompleted.length) {
    const avg = sum(hist) / hist.length;
    if (avg > 0) rvol = pmVolCompleted / avg;
  }

  return {
    price,
    prevClose,
    changePct,
    lastBar: last,
    bar1mChangePct,
    vol1m,
    volAccel,
    pmVol,
    rvol,
    rvolDays: hist.length,
    bid: p.bid > 0 ? p.bid : null,
    ask: p.ask > 0 ? p.ask : null,
    spreadPct: spreadPct(p.bid, p.ask),
    pmVwap,
    distVwapPct,
    pmHigh,
    priorPmHigh,
    breakout,
    barsCount: completed.length,
  };
}

/** Sum of volume for bars from dayStart up to (not including) dayStart + elapsed. */
export function cumulativeVolume(bars, dayStart, elapsedMs) {
  const end = dayStart + elapsedMs;
  return sum(bars.filter((b) => b.t >= dayStart && b.t + MIN <= end).map((b) => b.v));
}
