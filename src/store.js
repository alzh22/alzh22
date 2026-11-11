import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  market: 'all', // all | nasdaq | nyse | amex
  minPmVol: 1_000_000,
  minRvol: 1,
  minChangePct: 10,
  minPrice: 1,
  maxPrice: 100,
  maxSpreadPct: 0.5,
  minRR: 2,
  refreshSec: 5,
  maxSymbols: 30,
  riskPerTrade: 50, // $ risked between entry and stop
  maxPositionValue: 2000, // $ cap per position
  alertSound: true,
  autoExits: false, // auto stop/target sells for extended-hours entries
});

const NUM_LIMITS = {
  minPmVol: [0, 1e10],
  minRvol: [0, 100],
  minChangePct: [-100, 10000],
  minPrice: [0, 1e6],
  maxPrice: [0, 1e6],
  maxSpreadPct: [0.01, 20],
  minRR: [0.5, 20],
  refreshSec: [2, 300],
  maxSymbols: [1, 100],
  riskPerTrade: [1, 1e6],
  maxPositionValue: [1, 1e8],
};
const MARKETS = new Set(['all', 'nasdaq', 'nyse', 'amex']);
const HALAL = new Set(['halal', 'not', 'pending']);
const CATALYST = new Set(['verified', 'none', 'pending']);
const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

export function normSymbol(s) {
  const sym = String(s || '').trim().toUpperCase();
  if (!SYMBOL_RE.test(sym)) throw new HttpError(400, 'Invalid symbol');
  return sym;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
    let s = {};
    try {
      s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* first run */
    }
    this.state = { settings: s.settings || {}, halal: s.halal || {}, days: s.days || {}, tickers: s.tickers || {} };
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  getSettings() {
    return { ...DEFAULT_SETTINGS, ...this.state.settings };
  }

  updateSettings(patch = {}) {
    const next = { ...this.state.settings };
    for (const [k, v] of Object.entries(patch)) {
      if (k in NUM_LIMITS) {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new HttpError(400, `Invalid ${k}`);
        const [lo, hi] = NUM_LIMITS[k];
        next[k] = Math.min(hi, Math.max(lo, n));
      } else if (k === 'market') {
        if (!MARKETS.has(v)) throw new HttpError(400, 'Invalid market');
        next.market = v;
      } else if (k === 'alertSound' || k === 'autoExits') {
        next[k] = !!v;
      }
    }
    this.state.settings = next;
    this.save();
    return this.getSettings();
  }

  getHalal(sym) {
    return this.state.halal[sym] || 'pending';
  }

  setHalal(sym, status) {
    if (!HALAL.has(status)) throw new HttpError(400, 'Invalid halal status');
    if (status === 'pending') delete this.state.halal[sym];
    else this.state.halal[sym] = status;
    this.save();
  }

  symbolDay(date, sym) {
    return this.state.days[date]?.[sym] || {};
  }

  #mutDay(date, sym) {
    this.state.days[date] ||= {};
    this.state.days[date][sym] ||= {};
    // keep only the 10 most recent days
    const keys = Object.keys(this.state.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 10))) delete this.state.days[k];
    return this.state.days[date][sym];
  }

  setCatalyst(date, sym, status, note = '') {
    if (!CATALYST.has(status)) throw new HttpError(400, 'Invalid catalyst status');
    const d = this.#mutDay(date, sym);
    d.catalyst = { status, note: String(note).slice(0, 300), at: Date.now() };
    this.save();
  }

  setPlan(date, sym, plan) {
    const clean = {};
    for (const k of ['entry', 'stop', 'target']) {
      const v = plan?.[k];
      if (v === '' || v == null) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `Invalid ${k}`);
      clean[k] = n;
    }
    const d = this.#mutDay(date, sym);
    d.plan = clean;
    this.save();
  }

  getTicker(sym) {
    return this.state.tickers[sym];
  }

  setTicker(sym, info) {
    this.state.tickers[sym] = info;
    this.save();
  }
}
