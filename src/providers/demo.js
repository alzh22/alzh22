// Simulated premarket tape so you can learn the screen without API keys.
// Outside real premarket hours a virtual clock runs from 08:40 ET and loops every 50 minutes.
import { etDateStr, etParts, etToMs, sessionOf, sessionTimes } from '../time.js';

const MIN = 60_000;

// Fictional tickers — NOT real companies.
const UNIVERSE = [
  { s: 'DMQA', name: 'Demo Quantum A', prev: 1.0, gap: 0.34, base: 30e3, bps: 25, type: 'CS', ex: 'nasdaq', period: 14, burst: 4, off: 3 },
  { s: 'DMRB', name: 'Demo Robotics B', prev: 16.6, gap: 0.66, base: 7e3, bps: 12, type: 'CS', ex: 'nasdaq', period: 18, burst: 5, off: 9 },
  { s: 'DMCW', name: 'Demo Cloudworks', prev: 48.7, gap: 0.14, base: 15e3, bps: 9, type: 'CS', ex: 'nasdaq', period: 22, burst: 6, off: 1 },
  { s: 'DMX3', name: 'Demo 3x Semis ETF', prev: 56.0, gap: 0.145, base: 60e3, bps: 2, type: 'ETF', ex: 'nyse', period: 30, burst: 5, off: 12 },
  { s: 'DMBT', name: 'Demo Biotech', prev: 3.1, gap: 0.42, base: 45e3, bps: 60, type: 'CS', ex: 'nasdaq', period: 12, burst: 3, off: 5 },
  { s: 'DMEV', name: 'Demo EV Motors', prev: 8.4, gap: 0.21, base: 20e3, bps: 18, type: 'CS', ex: 'nyse', period: 16, burst: 4, off: 7 },
  { s: 'DMAI', name: 'Demo AI Labs', prev: 22.5, gap: 0.28, base: 12e3, bps: 10, type: 'CS', ex: 'nasdaq', period: 20, burst: 5, off: 15 },
  { s: 'DMSL', name: 'Demo Solar', prev: 5.2, gap: 0.12, base: 9e3, bps: 35, type: 'CS', ex: 'nasdaq', period: 25, burst: 4, off: 0, noQuote: true },
  { s: 'DMWT', name: 'Demo Water Wt', prev: 0.9, gap: 0.5, base: 80e3, bps: 120, type: 'WARRANT', ex: 'nasdaq', period: 10, burst: 3, off: 2 },
  { s: 'DMHC', name: 'Demo Health', prev: 12.0, gap: 0.04, base: 5e3, bps: 15, type: 'CS', ex: 'nyse', period: 24, burst: 3, off: 4 },
];

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class DemoProvider {
  constructor() {
    this.name = 'demo';
    this.isDemo = true;
    this.startReal = Date.now();
    this.cache = new Map();
  }

  now() {
    const real = Date.now();
    if (sessionOf(real) === 'premarket') return real;
    const p = etParts(real);
    const base = etToMs(p.y, p.mo, p.d, 8, 40);
    return base + ((real - this.startReal) % (50 * MIN));
  }

  /** Deterministic bars for a symbol from 04:00 up to `now` (last bar may be forming). */
  bars(u, now) {
    const date = etDateStr(now);
    const { pmStart } = sessionTimes(date);
    const minuteKey = Math.floor(now / 5000); // re-generate every 5s for the forming bar
    const key = `${u.s}|${date}|${minuteKey}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const r = rng(hash(`${u.s}|${date}`));
    const n = Math.max(0, Math.floor((now - pmStart) / MIN));
    const totalPm = 330;
    const out = [];
    let price = u.prev * (1 + u.gap * 0.35);
    const target = u.prev * (1 + u.gap);
    for (let i = 0; i <= n; i++) {
      const inBurst = (i + u.off) % u.period < u.burst;
      const afterBurst = (i + u.off) % u.period >= u.burst && (i + u.off) % u.period < u.burst + 3;
      const pull = ((target - price) / price) * 0.02;
      const drift = inBurst ? 0.004 + r() * 0.004 : afterBurst ? -0.002 : pull;
      const noise = (r() - 0.5) * 0.006;
      const o = price;
      const c = Math.max(0.05, o * (1 + drift + noise));
      const h = Math.max(o, c) * (1 + r() * 0.002);
      const l = Math.min(o, c) * (1 - r() * 0.002);
      const ramp = 0.3 + (1.4 * i) / totalPm;
      let v = u.base * ramp * (0.5 + r()) * (inBurst ? 3 + r() * 3 : 1);
      const t = pmStart + i * MIN;
      if (i === n) {
        const frac = Math.min(1, (now - t) / MIN);
        v *= frac;
      }
      out.push({ t, o: +o.toFixed(4), h: +h.toFixed(4), l: +l.toFixed(4), c: +c.toFixed(4), v: Math.round(v) });
      price = c;
    }
    if (this.cache.size > 200) this.cache.clear();
    this.cache.set(key, out);
    return out;
  }

  async getCandidates(now) {
    return UNIVERSE.map((u) => {
      const bars = this.bars(u, now);
      const price = bars.at(-1)?.c ?? u.prev;
      const half = (price * u.bps) / 20000;
      return {
        symbol: u.s,
        price,
        prevClose: u.prev,
        changePct: (price / u.prev - 1) * 100,
        dayVol: bars.reduce((a, b) => a + b.v, 0),
        bid: u.noQuote ? null : +(price - half).toFixed(4),
        ask: u.noQuote ? null : +(price + half).toFixed(4),
      };
    });
  }

  async getQuote(sym) {
    const c = (await this.getCandidates(this.now())).find((x) => x.symbol === sym);
    return c ? { price: c.price, bid: c.bid, ask: c.ask } : null;
  }

  async getDetails(sym) {
    const u = UNIVERSE.find((x) => x.s === sym);
    return u ? { name: u.name, type: u.type, exchange: u.ex } : { name: '', type: null, exchange: null };
  }

  async getMinuteBars(sym, from, to) {
    const u = UNIVERSE.find((x) => x.s === sym);
    return u ? this.bars(u, to).filter((b) => b.t >= from) : [];
  }

  async getHistPmVolumes(sym, now) {
    const u = UNIVERSE.find((x) => x.s === sym);
    if (!u || u.s === 'DMHC') return []; // one symbol without history → RVOL N/A
    const { pmStart, open } = sessionTimes(etDateStr(now));
    const mins = (Math.min(now, open) - pmStart) / MIN;
    const r = rng(hash(`${u.s}|hist`));
    return Array.from({ length: 5 }, () => u.base * 1.1 * mins * (0.5 + r() * 0.9));
  }

  async getNews(sym) {
    return [
      { title: `[DEMO] ${sym} announces contract award (fictional headline)`, publisher: 'Demo Wire', at: new Date().toISOString(), url: '' },
      { title: `[DEMO] ${sym} prices offering (fictional — check dilution)`, publisher: 'Demo Wire', at: new Date(Date.now() - 864e5).toISOString(), url: '' },
    ];
  }
}
