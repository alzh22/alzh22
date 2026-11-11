// Exit monitor for entries placed outside regular hours, where brokers reject bracket orders.
// When enabled, it watches each tracked position and sends a sell when price hits stop or target.
const STOP_BUFFER = 0.005; // stop exit: limit 0.5% under the bid so it fills fast

export class ExitManager {
  constructor({ store, provider, broker, sessionOf, intervalMs = 2000, log = console.log }) {
    Object.assign(this, { store, provider, broker, sessionOf, intervalMs, log });
    this.store.state.exits ||= {};
    this.timer = null;
    this.running = false;
  }

  get exits() {
    return this.store.state.exits;
  }

  list() {
    return Object.values(this.exits);
  }

  track({ symbol, stop, target }) {
    this.exits[symbol] = { symbol, stop, target, status: 'watching', at: Date.now(), last: null };
    this.store.save();
  }

  remove(symbol) {
    delete this.exits[symbol];
    this.store.save();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((e) => this.log(`[EXIT] ${e.message}`)), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One monitoring pass. Returns actions taken (for tests/logs). */
  async tick() {
    if (this.running) return [];
    this.running = true;
    const actions = [];
    try {
      if (!this.store.getSettings().autoExits) return actions;
      for (const ex of this.list()) {
        if (ex.status !== 'watching') continue;
        const pos = await this.broker.getPosition(ex.symbol);
        if (!pos || !(pos.qty > 0)) continue; // entry not filled yet (or already closed)
        const q = await this.provider.getQuote(ex.symbol);
        const price = q?.price;
        if (!(price > 0)) continue;
        ex.last = price;
        let reason = null;
        let limit = null;
        if (price <= ex.stop) {
          reason = 'stop';
          limit = (q.bid > 0 ? q.bid : price) * (1 - STOP_BUFFER);
        } else if (price >= ex.target) {
          reason = 'target';
          limit = q.bid > 0 ? q.bid : price;
        }
        if (!reason) continue;
        const extended = this.sessionOf(await this.provider.now()) !== 'regular';
        ex.status = `sending ${reason}`;
        try {
          await this.broker.closePosition(ex.symbol, limit, extended);
          ex.status = `${reason} sent @ ${limit >= 1 ? limit.toFixed(2) : limit.toFixed(4)}`;
          this.log(`[EXIT] ${reason.toUpperCase()} ${ex.symbol} qty ${pos.qty} limit ${limit}`);
          actions.push({ symbol: ex.symbol, reason, limit });
        } catch (e) {
          ex.status = 'watching'; // retry on next tick
          ex.error = e.message;
          this.log(`[EXIT] failed ${ex.symbol}: ${e.message}`);
        }
        this.store.save();
      }
    } finally {
      this.running = false;
    }
    return actions;
  }
}
