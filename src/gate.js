// Entry gate: 7 checks. A symbol is "qualified" (ranked) only when ALL checks pass.
// Missing data never passes — it stays PENDING.

export const COMMON_STOCK_TYPES = new Set(['CS']);
export const FUND_TYPES = new Set(['ETF', 'ETN', 'ETV', 'ETS', 'FUND']);
export const DROP_TYPES = new Set(['WARRANT', 'RIGHT', 'UNIT', 'PFD', 'SP', 'BOND']);

const SHORT = {
  catalyst: 'catalyst',
  spread: 'spread',
  breakout: 'breakout',
  vwap: 'VWAP',
  sharia: 'Sharia',
  etf: 'stock type',
  rr: 'reward/risk',
};

const fmtPx = (v) => (v == null ? '—' : v >= 1 ? v.toFixed(2) : v.toFixed(4));

export function rewardRisk(plan) {
  if (!plan) return null;
  const { entry, stop, target } = plan;
  if (!(entry > 0 && stop > 0 && target > 0)) return null;
  if (!(stop < entry && target > entry)) return 0;
  return (target - entry) / (entry - stop);
}

/**
 * @param {object} row       metrics + { symbol, type }
 * @param {object} ctx       { settings, halal, catalyst, plan }
 */
export function evaluateGate(row, ctx) {
  const { settings } = ctx;
  const checks = [];
  const add = (id, label, status, detail = '') => checks.push({ id, label, status, detail });

  // 1. Catalyst — confirmed by you (news is shown to help, but you verify it).
  const cat = ctx.catalyst?.status;
  add(
    'catalyst',
    'Verified catalyst',
    cat === 'verified' ? 'pass' : cat === 'none' ? 'fail' : 'pending',
    ctx.catalyst?.note || '',
  );

  // 2. Spread
  const sp = row.spreadPct;
  add(
    'spread',
    `Spread within limit (${settings.maxSpreadPct.toFixed(2)}%)`,
    sp == null ? 'pending' : sp <= settings.maxSpreadPct ? 'pass' : 'fail',
    sp == null ? 'No live bid/ask' : `${sp.toFixed(2)}%`,
  );

  // 3. Prior PM-high breakout on the last completed 1-min bar close
  add(
    'breakout',
    `Prior PM high breakout (${fmtPx(row.priorPmHigh)})`,
    row.breakout == null ? 'pending' : row.breakout ? 'pass' : 'fail',
    row.lastBar ? `1m close ${fmtPx(row.lastBar.c)}` : 'No completed bar',
  );

  // 4. Above PM VWAP
  add(
    'vwap',
    'Price above PM VWAP',
    row.distVwapPct == null ? 'pending' : row.distVwapPct > 0 ? 'pass' : 'fail',
    row.pmVwap ? `VWAP ${fmtPx(row.pmVwap)}` : '',
  );

  // 5. Sharia compliance — your own list
  const h = ctx.halal;
  add(
    'sharia',
    'Sharia compliance check',
    h === 'halal' ? 'pass' : h === 'not' ? 'fail' : 'pending',
    h === 'halal' ? 'Marked compliant' : h === 'not' ? 'Marked not compliant' : 'Not reviewed',
  );

  // 6. ETF rejection / US common stock only
  const t = row.type;
  add(
    'etf',
    'ETF rejection',
    !t ? 'pending' : COMMON_STOCK_TYPES.has(t) ? 'pass' : 'fail',
    !t ? 'Type unknown' : COMMON_STOCK_TYPES.has(t) ? 'Common stock' : `Type ${t}`,
  );

  // 7. Reward >= N x risk from your planned entry/stop/target
  const rr = rewardRisk(ctx.plan);
  add(
    'rr',
    `Reward ≥ ${settings.minRR}x risk`,
    rr == null ? 'na' : rr >= settings.minRR ? 'pass' : 'fail',
    rr == null ? 'Set entry, stop, target' : `${rr.toFixed(2)}x`,
  );

  const cleared = checks.filter((c) => c.status === 'pass').length;
  const qualified = cleared === checks.length;
  const isFund = t && !COMMON_STOCK_TYPES.has(t);
  const excluded =
    isFund ||
    checks.find((c) => c.id === 'sharia').status === 'fail' ||
    checks.find((c) => c.id === 'catalyst').status === 'fail';

  let action;
  let setup;
  let statusText;
  if (qualified) {
    action = 'REVIEW';
    setup = 'READY';
    statusText = `READY TO REVIEW — all ${checks.length} checks cleared. Not a buy signal: confirm the tape yourself.`;
  } else if (excluded) {
    action = 'EXCLUDE';
    setup = isFund ? (FUND_TYPES.has(t) ? 'ETF' : t) : 'NO';
    const why = [];
    if (isFund) why.push(FUND_TYPES.has(t) ? 'ETF / fund' : `not common stock (${t})`);
    if (checks.find((c) => c.id === 'sharia').status === 'fail') why.push('not Sharia compliant');
    if (checks.find((c) => c.id === 'catalyst').status === 'fail') why.push('no catalyst');
    statusText = `EXCLUDE — ${why.join(', ')}.`;
  } else {
    action = 'WAIT';
    setup = 'CHECK';
    const pending = checks.filter((c) => c.status === 'pending' || c.status === 'na').map((c) => SHORT[c.id]);
    const failed = checks.filter((c) => c.status === 'fail').map((c) => SHORT[c.id]);
    const parts = [];
    if (pending.length) parts.push(`${joinWords(pending)} pending`);
    if (failed.length) parts.push(`${joinWords(failed)} not met`);
    statusText = `WAIT — ${parts.join('; ')}.`;
  }

  return { checks, cleared, total: checks.length, qualified, excluded: !!excluded, action, setup, statusText, rr };
}

function joinWords(words) {
  const w = words.map((x, i) => (i === 0 ? x[0].toUpperCase() + x.slice(1) : x));
  if (w.length <= 1) return w.join('');
  return `${w.slice(0, -1).join(', ')} and ${w.at(-1)}`;
}

const desc = (a, b) => (b ?? -Infinity) - (a ?? -Infinity);
const asc = (a, b) => (a ?? Infinity) - (b ?? Infinity);

/** Sort: 1-min volume acceleration (high→low), then tighter spread %. */
export function rankCompare(a, b) {
  return desc(a.volAccel, b.volAccel) || asc(a.spreadPct, b.spreadPct) || a.symbol.localeCompare(b.symbol);
}

export function splitAndRank(rows) {
  const qualified = rows.filter((r) => r.gate.qualified).sort(rankCompare);
  qualified.forEach((r, i) => (r.rank = i + 1));
  const watchlist = rows
    .filter((r) => !r.gate.qualified)
    .sort((a, b) => Number(a.gate.excluded) - Number(b.gate.excluded) || rankCompare(a, b));
  watchlist.forEach((r) => (r.rank = null));
  return { qualified, watchlist };
}

/** Universe filters (who appears on screen at all). */
export function passesUniverse(row, s) {
  if (row.type && DROP_TYPES.has(row.type)) return false;
  if (row.price == null || row.price < s.minPrice || row.price > s.maxPrice) return false;
  if (row.changePct == null || row.changePct < s.minChangePct) return false;
  if (row.pmVol < s.minPmVol) return false;
  if (row.rvol != null && row.rvol < s.minRvol) return false;
  if (s.market !== 'all' && row.exchange !== s.market) return false;
  return true;
}
