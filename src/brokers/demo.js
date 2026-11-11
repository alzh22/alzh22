// In-memory simulated broker. Fills limit buys immediately at the limit price.
export class DemoBroker {
  constructor() {
    this.name = 'demo';
    this.live = false;
    this.cash = 25_000;
    this.positions = new Map();
    this.orders = [];
  }

  async account() {
    let mv = 0;
    for (const p of this.positions.values()) mv += p.qty * p.lastPrice;
    return { cash: this.cash, equity: this.cash + mv, buyingPower: this.cash, mode: 'SIMULATED' };
  }

  async getPositions(priceOf = () => null) {
    return [...this.positions.values()].map((p) => {
      const last = priceOf(p.symbol) ?? p.lastPrice;
      p.lastPrice = last;
      return { symbol: p.symbol, qty: p.qty, avgPrice: p.avg, lastPrice: last, unrealizedPl: (last - p.avg) * p.qty };
    });
  }

  async getOrders() {
    return this.orders.slice(-20).reverse();
  }

  async placeEntry({ symbol, qty, limit, stop, target, extended, ask }) {
    // Marketable limit fills at the ask (never above the limit); otherwise it rests unfilled.
    if (ask > 0 && ask > limit) {
      const order = { id: `demo-${Date.now()}`, symbol, side: 'buy', qty, type: 'limit', limit, status: 'new (sim: ask above limit)', at: new Date().toISOString() };
      this.orders.push(order);
      return order;
    }
    const fillPx = ask > 0 ? Math.min(ask, limit) : limit;
    const cost = qty * fillPx;
    if (cost > this.cash) throw new Error('Insufficient simulated cash');
    this.cash -= cost;
    const pos = this.positions.get(symbol) || { symbol, qty: 0, avg: 0, lastPrice: fillPx };
    pos.avg = (pos.avg * pos.qty + cost) / (pos.qty + qty);
    pos.qty += qty;
    this.positions.set(symbol, pos);
    const order = {
      id: `demo-${Date.now()}`,
      symbol,
      side: 'buy',
      qty,
      type: extended ? 'limit (ext. hours)' : 'bracket limit',
      limit,
      stop,
      target,
      status: 'filled',
      at: new Date().toISOString(),
    };
    this.orders.push(order);
    return order;
  }

  async closePosition(symbol, price) {
    const pos = this.positions.get(symbol);
    if (!pos) throw new Error('No position');
    const px = price ?? pos.lastPrice;
    this.cash += pos.qty * px;
    this.positions.delete(symbol);
    const order = { id: `demo-${Date.now()}`, symbol, side: 'sell', qty: pos.qty, type: 'limit', limit: px, status: 'filled', at: new Date().toISOString() };
    this.orders.push(order);
    return order;
  }

  async cancelOrder() {
    throw new Error('Simulated orders fill instantly');
  }
}
