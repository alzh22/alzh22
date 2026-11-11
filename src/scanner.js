import { computeMetrics } from './metrics.js';
import { evaluateGate, passesUniverse, splitAndRank } from './gate.js';
import { etDateStr, etTimeStr, sessionOf, sessionTimes } from './time.js';

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Fetch data and compute raw metrics (expensive; cached by the server). */
export async function collect({ provider, settings }) {
  const now = await provider.now();
  const date = etDateStr(now);
  const { pmStart, open } = sessionTimes(date);
  const warnings = [];

  const all = await provider.getCandidates(now);
  const cands = all
    .filter(
      (c) =>
        c.price >= settings.minPrice &&
        c.price <= settings.maxPrice &&
        c.changePct >= settings.minChangePct &&
        (c.dayVol ?? 0) >= settings.minPmVol,
    )
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, settings.maxSymbols);

  const rows = await mapLimit(cands, 6, async (c) => {
    try {
      const [details, bars, hist] = await Promise.all([
        provider.getDetails(c.symbol),
        provider.getMinuteBars(c.symbol, pmStart, now),
        provider.getHistPmVolumes(c.symbol, now).catch(() => []),
      ]);
      const m = computeMetrics({
        bars,
        now,
        pmStart,
        open,
        lastPrice: c.price,
        prevClose: c.prevClose,
        bid: c.bid,
        ask: c.ask,
        histPmVols: hist,
      });
      return { symbol: c.symbol, name: details.name, type: details.type, exchange: details.exchange, ...m };
    } catch (e) {
      warnings.push(`${c.symbol}: ${e.message}`);
      return null;
    }
  });

  return { now, date, session: sessionOf(now), rows: rows.filter(Boolean), scanned: all.length, warnings };
}

/** Cheap: apply universe filters + entry gate with the user's current state. */
export function evaluate(raw, { store, settings }) {
  const rows = raw.rows
    .filter((r) => passesUniverse(r, settings))
    .map((r) => {
      const day = store.symbolDay(raw.date, r.symbol);
      const ctx = { settings, halal: store.getHalal(r.symbol), catalyst: day.catalyst, plan: day.plan };
      return { ...r, halal: ctx.halal, catalyst: day.catalyst || null, plan: day.plan || null, gate: evaluateGate(r, ctx) };
    });
  const { qualified, watchlist } = splitAndRank(rows);
  return {
    now: raw.now,
    date: raw.date,
    timeET: etTimeStr(raw.now),
    session: raw.session,
    scanned: raw.scanned,
    warnings: raw.warnings,
    settings,
    qualified,
    watchlist,
  };
}
