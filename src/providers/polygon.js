// Real market data from Polygon.io (massive.com). Real-time premarket data and NBBO quotes
// require a plan with real-time stocks + quotes; on delayed plans the app will be ~15 min late.
import { etDateStr, prevWeekdays, sessionTimes } from '../time.js';
import { cumulativeVolume } from '../metrics.js';

const BASE = 'https://api.polygon.io';
const EXCHANGES = { XNAS: 'nasdaq', XNYS: 'nyse', XASE: 'amex', ARCX: 'nyse', BATS: 'nasdaq' };

export class PolygonProvider {
  constructor({ apiKey, store }) {
    if (!apiKey) throw new Error('POLYGON_API_KEY is required for DATA_PROVIDER=polygon');
    this.apiKey = apiKey;
    this.store = store;
    this.name = 'polygon';
    this.isDemo = false;
    this.histCache = new Map(); // `${sym}|${date}` -> Map(date -> bars)
  }

  now() {
    return Date.now();
  }

  async get(pathname, params = {}) {
    const url = new URL(BASE + pathname);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Polygon ${res.status} on ${pathname}: ${body.slice(0, 160)}`);
    }
    return res.json();
  }

  /** Whole-market snapshot → candidate list. */
  async getCandidates() {
    const j = await this.get('/v2/snapshot/locale/us/markets/stocks/tickers', { include_otc: false });
    return (j.tickers || []).map((t) => {
      const price = t.lastTrade?.p || t.min?.c || t.day?.c || null;
      const prevClose = t.prevDay?.c || null;
      return {
        symbol: t.ticker,
        price,
        prevClose,
        changePct: price && prevClose ? (price / prevClose - 1) * 100 : (t.todaysChangePerc ?? null),
        dayVol: Math.max(t.day?.v || 0, t.min?.av || 0),
        bid: t.lastQuote?.p || null,
        ask: t.lastQuote?.P || null,
      };
    });
  }

  async getDetails(sym) {
    const cached = this.store.getTicker(sym);
    if (cached) return cached;
    const j = await this.get(`/v3/reference/tickers/${encodeURIComponent(sym)}`);
    const r = j.results || {};
    const info = {
      name: r.name || '',
      type: r.type || null,
      exchange: EXCHANGES[r.primary_exchange] || (r.primary_exchange || '').toLowerCase() || null,
    };
    if (info.type) this.store.setTicker(sym, info);
    return info;
  }

  async aggs(sym, from, to) {
    const j = await this.get(`/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/minute/${from}/${to}`, {
      adjusted: true,
      sort: 'asc',
      limit: 50000,
    });
    return (j.results || []).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw }));
  }

  getMinuteBars(sym, from, to) {
    return this.aggs(sym, from, to);
  }

  /** Cumulative premarket volume of the prior `days` sessions, up to the same clock time as `now`. */
  async getHistPmVolumes(sym, now, days = 5) {
    const today = etDateStr(now);
    const key = `${sym}|${today}`;
    let byDate = this.histCache.get(key);
    if (!byDate) {
      const dates = prevWeekdays(today, days);
      const first = sessionTimes(dates.at(-1)).pmStart;
      const last = sessionTimes(dates[0]).open;
      const bars = await this.aggs(sym, first, last);
      byDate = new Map(dates.map((d) => [d, []]));
      for (const b of bars) byDate.get(etDateStr(b.t))?.push(b);
      if (this.histCache.size > 500) this.histCache.clear();
      this.histCache.set(key, byDate);
    }
    const elapsed = Math.min(now, sessionTimes(today).open) - sessionTimes(today).pmStart;
    return [...byDate.entries()]
      .filter(([, bars]) => bars.length)
      .map(([d, bars]) => cumulativeVolume(bars, sessionTimes(d).pmStart, elapsed));
  }

  async getNews(sym) {
    const j = await this.get('/v2/reference/news', { ticker: sym, limit: 8, order: 'desc', sort: 'published_utc' });
    return (j.results || []).map((n) => ({
      title: n.title,
      publisher: n.publisher?.name || '',
      at: n.published_utc,
      url: n.article_url,
    }));
  }
}
