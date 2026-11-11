import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './src/config.js';
import { Store, HttpError, normSymbol } from './src/store.js';
import { collect, evaluate } from './src/scanner.js';
import { DemoProvider } from './src/providers/demo.js';
import { PolygonProvider } from './src/providers/polygon.js';
import { DemoBroker } from './src/brokers/demo.js';
import { AlpacaBroker } from './src/brokers/alpaca.js';
import { ExitManager } from './src/exits.js';
import { sessionOf } from './src/time.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
if (!LOOPBACK.has(config.host) && !config.password) {
  console.error('Refusing to start: set APP_PASSWORD when HOST is not 127.0.0.1 (this app can place orders).');
  process.exit(1);
}

const store = new Store(config.dataDir);
const provider =
  config.dataProvider === 'polygon' ? new PolygonProvider({ apiKey: config.polygonKey, store }) : new DemoProvider();
const broker =
  config.broker === 'alpaca'
    ? new AlpacaBroker({ key: config.alpacaKey, secret: config.alpacaSecret, live: config.alpacaLive })
    : new DemoBroker();

if (provider.isDemo && broker.live) {
  console.error('Refusing to start: live trading with DEMO market data is not allowed.');
  process.exit(1);
}

const exits = new ExitManager({ store, provider, broker, sessionOf });
exits.start();

// ---------- scan cache ----------
let raw = null;
let rawAt = 0;
let inflight = null;
const MIN_SCAN_GAP = 1500;

async function getRaw(force = false) {
  if (!force && raw && Date.now() - rawAt < MIN_SCAN_GAP) return raw;
  if (!inflight) {
    inflight = collect({ provider, settings: store.getSettings() })
      .then((r) => {
        raw = r;
        rawAt = Date.now();
        return r;
      })
      .finally(() => (inflight = null));
  }
  return inflight;
}

const evaluated = (r) => evaluate(r, { store, settings: store.getSettings() });

async function findRow(sym, fresh = false) {
  const r = await getRaw(fresh);
  const e = evaluated(r);
  return { row: [...e.qualified, ...e.watchlist].find((x) => x.symbol === sym), scan: e };
}

// ---------- order safety ----------
const lastOrderAt = new Map();

function sizePosition(plan, s) {
  const risk = plan.entry - plan.stop;
  const byRisk = Math.floor(s.riskPerTrade / risk);
  const byValue = Math.floor(s.maxPositionValue / plan.entry);
  return Math.max(0, Math.min(byRisk, byValue));
}

// ---------- routes ----------
const routes = {
  'GET /api/status': async () => ({
    provider: provider.name,
    demoData: provider.isDemo,
    broker: broker.name,
    live: broker.live,
  }),

  'GET /api/scan': async (_req, url) => evaluated(await getRaw(url.searchParams.get('force') === '1')),

  'GET /api/settings': async () => store.getSettings(),
  'POST /api/settings': async (_req, _url, body) => {
    const s = store.updateSettings(body);
    raw = null; // filters changed → next scan refetches
    return s;
  },

  'POST /api/catalyst': async (_req, _url, body) => {
    const sym = normSymbol(body.symbol);
    store.setCatalyst((await getRaw()).date, sym, body.status, body.note);
    return evaluated(await getRaw());
  },
  'POST /api/halal': async (_req, _url, body) => {
    store.setHalal(normSymbol(body.symbol), body.status);
    return evaluated(await getRaw());
  },
  'POST /api/plan': async (_req, _url, body) => {
    const sym = normSymbol(body.symbol);
    store.setPlan((await getRaw()).date, sym, body);
    return evaluated(await getRaw());
  },

  'GET /api/news': async (_req, url) => provider.getNews(normSymbol(url.searchParams.get('symbol'))),

  'GET /api/broker': async () => {
    const priceOf = (sym) => {
      const rows = raw?.rows || [];
      return rows.find((r) => r.symbol === sym)?.price ?? null;
    };
    const [positions, orders] = await Promise.all([broker.getPositions(priceOf), broker.getOrders()]);
    const account = await broker.account();
    return { name: broker.name, live: broker.live, account, positions, orders, exits: exits.list(), autoExits: store.getSettings().autoExits };
  },

  'POST /api/order/preview': async (_req, _url, body) => orderTicket(normSymbol(body.symbol)),

  'POST /api/order': async (_req, _url, body) => {
    const sym = normSymbol(body.symbol);
    if (body.confirm !== true) throw new HttpError(400, 'Order must be confirmed');
    const t = await orderTicket(sym, true);
    if (body.qty !== t.qty || body.limit !== t.limit) {
      throw new HttpError(409, 'Ticket changed since preview — review it again');
    }
    const last = lastOrderAt.get(sym) || 0;
    if (Date.now() - last < 15_000) throw new HttpError(429, 'Duplicate guard: wait 15s before another order on this symbol');
    lastOrderAt.set(sym, Date.now());
    const order = await broker.placeEntry({
      symbol: sym,
      qty: t.qty,
      limit: t.limit,
      stop: t.stop,
      target: t.target,
      extended: t.extended,
      ask: t.ask,
      clientId: `ms-${sym}-${crypto.randomUUID().slice(0, 8)}`,
    });
    if (t.extended) exits.track({ symbol: sym, stop: t.stop, target: t.target });
    console.log(`[ORDER] ${broker.name}${broker.live ? ' LIVE' : ''} BUY ${t.qty} ${sym} @ ${t.limit}`);
    return { order, ticket: t };
  },

  'POST /api/close': async (_req, _url, body) => {
    const sym = normSymbol(body.symbol);
    const r = await getRaw(true);
    const row = r.rows.find((x) => x.symbol === sym);
    const extended = r.session !== 'regular';
    const limit = body.limit > 0 ? Number(body.limit) : (row?.bid ?? row?.price ?? null);
    return broker.closePosition(sym, limit, extended);
  },

  'POST /api/exit/remove': async (_req, _url, body) => {
    exits.remove(normSymbol(body.symbol));
    return { ok: true };
  },

  'POST /api/cancel': async (_req, _url, body) => broker.cancelOrder(String(body.id || '')),
};

/** Build the buy ticket. Throws unless every gate check passes on fresh data. */
async function orderTicket(sym, fresh = false) {
  const { row, scan } = await findRow(sym, fresh);
  if (!row) throw new HttpError(404, `${sym} is not on the scanner right now`);
  if (!row.gate.qualified) throw new HttpError(409, `Entry gate not cleared: ${row.gate.statusText}`);
  const s = scan.settings;
  const plan = row.plan;
  const qty = sizePosition(plan, s);
  if (qty < 1) throw new HttpError(409, 'Position size is 0 — raise risk per trade or widen max position value');
  const extended = scan.session !== 'regular';
  const round = (v) => (v >= 1 ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000);
  return {
    symbol: sym,
    qty,
    limit: round(plan.entry),
    stop: round(plan.stop),
    target: round(plan.target),
    rr: row.gate.rr,
    riskDollars: +(qty * (plan.entry - plan.stop)).toFixed(2),
    value: +(qty * plan.entry).toFixed(2),
    ask: row.ask,
    extended,
    session: scan.session,
    broker: broker.name,
    live: broker.live,
    note: extended
      ? store.getSettings().autoExits
        ? 'Extended hours: a LIMIT DAY entry is sent. Brokers reject brackets now, so this app will WATCH stop/target and send the sell itself — keep this app running.'
        : 'Extended hours: only a LIMIT DAY entry is sent. Stop and target are NOT placed (Auto exits is OFF in ⚙️) — manage them yourself.'
      : 'Regular hours: bracket order (limit entry + take-profit + stop-loss).',
  };
}

// ---------- http plumbing ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function authorized(req) {
  if (!config.password) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass);
  const b = Buffer.from(config.password);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) reject(new HttpError(413, 'Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="scanner"' });
    return res.end('Auth required');
  }
  const url = new URL(req.url, 'http://x');
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      // Same-origin guard for state-changing calls.
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
        throw new HttpError(415, 'JSON required');
      }
      const body = req.method === 'POST' ? await readBody(req) : null;
      return send(res, 200, await handler(req, url, body));
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      return send(res, status, { error: e.message });
    }
  }
  if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(config.publicDir, rel);
  if (!file.startsWith(config.publicDir + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

server.listen(config.port, config.host, () => {
  console.log(`Momentum scanner → http://${config.host}:${config.port}`);
  console.log(`  data: ${provider.name}${provider.isDemo ? ' (SIMULATED)' : ''} | broker: ${broker.name}${broker.live ? ' (LIVE MONEY)' : broker.name === 'alpaca' ? ' (paper)' : ' (simulated)'}`);
});
