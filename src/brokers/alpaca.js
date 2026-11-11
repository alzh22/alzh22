// Alpaca Trading API. PAPER by default; real money only with ALPACA_LIVE=true.
// Note: Alpaca accepts only LIMIT + DAY + extended_hours orders outside 09:30–16:00 ET,
// so bracket (stop/target) orders are placed only in regular hours.
export class AlpacaBroker {
  constructor({ key, secret, live }) {
    if (!key || !secret) throw new Error('ALPACA_KEY_ID and ALPACA_SECRET_KEY are required for BROKER=alpaca');
    this.name = 'alpaca';
    this.live = !!live;
    this.base = live ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
    this.headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'Content-Type': 'application/json' };
  }

  async req(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`Alpaca ${res.status}: ${json?.message || text.slice(0, 160)}`);
    return json;
  }

  async account() {
    const a = await this.req('GET', '/v2/account');
    return {
      cash: Number(a.cash),
      equity: Number(a.equity),
      buyingPower: Number(a.buying_power),
      mode: this.live ? 'LIVE' : 'PAPER',
      blocked: a.trading_blocked || a.account_blocked,
    };
  }

  async getPositions() {
    const ps = await this.req('GET', '/v2/positions');
    return ps.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      avgPrice: Number(p.avg_entry_price),
      lastPrice: Number(p.current_price),
      unrealizedPl: Number(p.unrealized_pl),
    }));
  }

  async getOrders() {
    const os = await this.req('GET', '/v2/orders?status=all&limit=20&direction=desc&nested=true');
    return os.map((o) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      qty: Number(o.qty),
      type: `${o.order_class && o.order_class !== 'simple' ? `${o.order_class} ` : ''}${o.type}${o.extended_hours ? ' (ext.)' : ''}`,
      limit: o.limit_price ? Number(o.limit_price) : null,
      status: o.status,
      at: o.submitted_at,
    }));
  }

  async placeEntry({ symbol, qty, limit, stop, target, extended, clientId }) {
    const order = {
      symbol,
      qty: String(qty),
      side: 'buy',
      type: 'limit',
      time_in_force: 'day',
      limit_price: px(limit),
      client_order_id: clientId,
    };
    if (extended) {
      order.extended_hours = true;
    } else {
      order.order_class = 'bracket';
      order.take_profit = { limit_price: px(target) };
      order.stop_loss = { stop_price: px(stop) };
    }
    const o = await this.req('POST', '/v2/orders', order);
    return { id: o.id, symbol: o.symbol, status: o.status, type: o.order_class || o.type };
  }

  async closePosition(symbol, limitPrice, extended) {
    if (extended) {
      const pos = await this.req('GET', `/v2/positions/${encodeURIComponent(symbol)}`);
      if (!(limitPrice > 0)) throw new Error('A limit price is required to sell in extended hours');
      return this.req('POST', '/v2/orders', {
        symbol,
        qty: String(Math.abs(Number(pos.qty))),
        side: 'sell',
        type: 'limit',
        time_in_force: 'day',
        limit_price: px(limitPrice),
        extended_hours: true,
      });
    }
    return this.req('DELETE', `/v2/positions/${encodeURIComponent(symbol)}?cancel_orders=true`);
  }

  async cancelOrder(id) {
    return this.req('DELETE', `/v2/orders/${encodeURIComponent(id)}`);
  }
}

/** Alpaca price precision: 2 decimals ≥ $1, 4 decimals below. */
export function px(v) {
  return v >= 1 ? v.toFixed(2) : v.toFixed(4);
}
