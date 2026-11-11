const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  status: null,
  scan: null,
  selected: null,
  running: true,
  timer: null,
  busy: false,
  knownQualified: new Set(),
  firstScan: true,
  news: {},
  ticket: null,
};

// ---------- formatting ----------
const fPx = (v) => (v == null ? 'N/A' : v >= 1 ? v.toFixed(2) : v.toFixed(4));
const fPct = (v, d = 1) => (v == null ? 'N/A' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);
const fVol = (v) =>
  v == null ? 'N/A' : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v));
const fX = (v) => (v == null ? 'N/A' : `${v.toFixed(1)}×`);
const cls = (v) => (v == null ? 'muted' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const usd = (v) => (v == null ? '—' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD' }));

// ---------- api ----------
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function showError(msg) {
  const el = $('#errorBar');
  el.hidden = !msg;
  el.textContent = msg || '';
}

// ---------- scan loop ----------
async function refresh(force = false) {
  if (state.busy) return;
  state.busy = true;
  $('#refreshBtn').classList.add('spin');
  try {
    const scan = await api(`/api/scan${force ? '?force=1' : ''}`);
    applyScan(scan);
    showError(scan.warnings?.length ? `Data warnings: ${scan.warnings.slice(0, 3).join(' · ')}` : '');
  } catch (e) {
    showError(`Scan failed: ${e.message}`);
  } finally {
    state.busy = false;
    $('#refreshBtn').classList.remove('spin');
  }
}

function schedule() {
  clearTimeout(state.timer);
  if (!state.running) return;
  const sec = state.scan?.settings?.refreshSec || 5;
  state.timer = setTimeout(async () => {
    await refresh();
    schedule();
  }, sec * 1000);
}

function setRunning(on) {
  state.running = on;
  const b = $('#runBtn');
  b.textContent = on ? 'RUNNING' : 'RUN';
  b.classList.toggle('on', on);
  if (on) refresh().then(schedule);
  else clearTimeout(state.timer);
}

function applyScan(scan) {
  state.scan = scan;
  const all = allRows();
  if (!state.selected || !all.some((r) => r.symbol === state.selected)) state.selected = all[0]?.symbol || null;

  // alerts for newly qualified symbols
  const nowQ = new Set(scan.qualified.map((r) => r.symbol));
  const fresh = [...nowQ].filter((s) => !state.knownQualified.has(s));
  state.knownQualified = nowQ;
  if (!state.firstScan && fresh.length) alertQualified(fresh);
  state.firstScan = false;

  syncControls(scan.settings);
  $('#updatedAt').textContent = scan.timeET;
  const pill = $('#sessionPill');
  pill.textContent = scan.session.toUpperCase();
  pill.className = `pill ${scan.session}`;
  renderTable(fresh);
  renderGate();
}

const allRows = () => (state.scan ? [...state.scan.qualified, ...state.scan.watchlist] : []);
const selRow = () => allRows().find((r) => r.symbol === state.selected);

// ---------- alerts ----------
let audioCtx;
function beep() {
  try {
    audioCtx ||= new AudioContext();
    [880, 1320].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.15, audioCtx.currentTime + i * 0.15);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + i * 0.15 + 0.14);
      o.connect(g).connect(audioCtx.destination);
      o.start(audioCtx.currentTime + i * 0.15);
      o.stop(audioCtx.currentTime + i * 0.15 + 0.15);
    });
  } catch {
    /* audio blocked */
  }
}

function alertQualified(symbols) {
  if (!state.scan.settings.alertSound) return;
  beep();
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Ready to review', { body: `${symbols.join(', ')} cleared all entry-gate checks` });
  }
  document.title = `● ${symbols[0]} ready — Momentum Scanner`;
  setTimeout(() => (document.title = 'Momentum Scanner'), 8000);
}

// ---------- table ----------
function renderTable(fresh = []) {
  const { qualified, watchlist } = state.scan;
  const rows = [];
  rows.push(`<tr class="section"><td colspan="15">QUALIFIED SETUPS <span class="count">${qualified.length}</span></td></tr>`);
  if (!qualified.length) {
    rows.push(`<tr class="empty"><td><span class="r1">1</span></td><td class="l">—</td><td colspan="13" class="l">No qualified setups — Rank 1 left empty. No symbol cleared all entry-gate checks.</td></tr>`);
  }
  qualified.forEach((r) => rows.push(rowHtml(r, fresh.includes(r.symbol))));
  rows.push(`<tr class="divider"><td colspan="15"></td></tr>`);
  rows.push(`<tr class="section"><td colspan="15">WATCHLIST <span class="count">${watchlist.length} · UNRANKED</span></td></tr>`);
  if (!watchlist.length) {
    const why = state.scan.session === 'closed' ? 'Market closed — premarket starts 04:00 ET.' : 'No symbol passes the scan filters right now.';
    rows.push(`<tr class="empty"><td></td><td colspan="14" class="l">${why}</td></tr>`);
  }
  watchlist.forEach((r) => rows.push(rowHtml(r, false)));
  $('#tbody').innerHTML = rows.join('');
}

function rowHtml(r, flash) {
  const g = r.gate;
  const halalBadge = r.type && r.type !== 'CS' ? 'na' : r.halal === 'halal' ? 'pass' : r.halal === 'not' ? 'fail' : 'pending';
  const halalText = { na: 'N/A', pass: 'YES', fail: 'NO', pending: 'PENDING' }[halalBadge];
  const isEtf = r.type && r.type !== 'CS';
  return `<tr class="row${r.symbol === state.selected ? ' selected' : ''}${flash ? ' flash' : ''}" data-sym="${esc(r.symbol)}">
    <td>${r.rank ?? '—'}</td>
    <td class="sym">${esc(r.symbol)}${isEtf ? `<span class="tag-etf">${esc(r.type)}</span>` : ''}</td>
    <td>${fPx(r.price)}</td>
    <td class="${cls(r.changePct)}">${fPct(r.changePct)}</td>
    <td class="${cls(r.bar1mChangePct)}">${fPct(r.bar1mChangePct)}</td>
    <td>${fVol(r.vol1m)}</td>
    <td>${fX(r.volAccel)}</td>
    <td>${fVol(r.pmVol)}</td>
    <td>${r.rvol == null ? 'N/A' : r.rvol.toFixed(2)}</td>
    <td>${r.spreadPct == null ? 'N/A' : `${r.spreadPct.toFixed(2)}%`}</td>
    <td class="${cls(r.distVwapPct)}">${fPct(r.distVwapPct)}</td>
    <td class="${r.breakout ? 'up' : ''}">${fPx(r.priorPmHigh)}</td>
    <td><span class="badge b-${halalBadge}">${halalText}</span></td>
    <td>${esc(g.setup)}</td>
    <td><span class="badge action a-${g.action}">${g.action}</span></td>
  </tr>`;
}

$('#tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-sym]');
  if (!tr) return;
  select(tr.dataset.sym);
});

function select(sym) {
  state.selected = sym;
  document.querySelectorAll('#tbody tr.row').forEach((tr) => tr.classList.toggle('selected', tr.dataset.sym === sym));
  renderGate();
}

// ---------- entry gate panel ----------
function renderGate() {
  const r = selRow();
  const el = $('#gate');
  if (!r) {
    el.innerHTML = '<h3>ENTRY GATE</h3><p class="muted">No symbol selected.</p>';
    return;
  }
  // keep focus/values of plan inputs while typing
  const active = document.activeElement;
  if (active && el.contains(active) && active.tagName === 'INPUT' && el.dataset.sym === r.symbol) {
    updateGateLive(r);
    return;
  }
  el.dataset.sym = r.symbol;
  const g = r.gate;
  const sub = g.qualified ? `QUALIFIED · RANK ${r.rank}` : 'WATCHLIST · UNRANKED';
  const plan = r.plan || {};
  const news = state.news[r.symbol];
  const checksHtml = g.checks
    .map((c) => {
      let tools = '';
      if (c.id === 'catalyst') {
        tools = `<div class="tools">
          <button class="btn sm ${r.catalyst?.status === 'verified' ? 'sel' : ''}" data-act="catalyst" data-v="verified">✓ Verified (V)</button>
          <button class="btn sm ${r.catalyst?.status === 'none' ? 'sel' : ''}" data-act="catalyst" data-v="none">✗ No catalyst</button>
          <button class="btn sm" data-act="catalyst" data-v="pending">Reset</button>
          <button class="btn sm" data-act="news">${news ? 'Reload news' : 'Show news'}</button>
        </div>${news ? newsHtml(news) : ''}`;
      } else if (c.id === 'sharia') {
        tools = `<div class="tools">
          <button class="btn sm ${r.halal === 'halal' ? 'sel' : ''}" data-act="halal" data-v="halal">✓ Compliant (H)</button>
          <button class="btn sm ${r.halal === 'not' ? 'sel' : ''}" data-act="halal" data-v="not">✗ Not compliant</button>
          <button class="btn sm" data-act="halal" data-v="pending">Reset</button>
        </div>`;
      } else if (c.id === 'rr') {
        tools = `<div class="plan">
          <label>Entry<input data-plan="entry" type="number" step="0.01" value="${plan.entry ?? ''}" /></label>
          <label>Stop<input data-plan="stop" type="number" step="0.01" value="${plan.stop ?? ''}" /></label>
          <label>Target<input data-plan="target" type="number" step="0.01" value="${plan.target ?? ''}" /></label>
        </div>
        <div class="tools">
          <button class="btn sm" data-act="suggest" title="Entry = ask (or PM high +1¢); Stop = below last bar low / VWAP">Suggest entry & stop</button>
          <button class="btn sm primary" data-act="plan">Save plan</button>
        </div>`;
      }
      return `<li data-check="${c.id}">
        <div class="row1"><span>${esc(c.label)}</span><span class="badge b-${c.status}">${badgeText(c)}</span></div>
        ${c.detail ? `<div class="detail">${esc(c.detail)}</div>` : ''}${tools}</li>`;
    })
    .join('');

  const boxCls = g.qualified ? 'ok' : g.excluded ? 'bad' : '';
  el.innerHTML = `
    <h3>ENTRY GATE</h3>
    <div class="sym-big">${esc(r.symbol)}</div>
    <div class="sub">${esc(sub)}${r.name ? ` · ${esc(r.name)}` : ''}</div>
    <div class="px">$${fPx(r.price)}<span class="${cls(r.changePct)}">${fPct(r.changePct)}</span></div>
    <div class="sub" id="gCount">${g.cleared} OF ${g.total} CHECKS CLEARED</div>
    <div class="progress"><div id="gBar" style="width:${(g.cleared / g.total) * 100}%"></div></div>
    <ul class="checks">${checksHtml}</ul>
    <div class="status-box ${boxCls}" id="gStatus"><small>STATUS</small><p>${esc(g.statusText)}</p></div>
    <div class="ticket">
      <button class="btn buy" data-act="ticket" ${g.qualified ? '' : 'disabled'} title="${g.qualified ? 'Open buy ticket (B)' : 'Locked until all checks pass'}">
        ${g.qualified ? 'BUY TICKET (B)' : '🔒 BUY LOCKED — gate not cleared'}
      </button>
    </div>
    <p class="foot">Reward/risk uses your planned entry, stop and target. Bid ${fPx(r.bid)} · Ask ${fPx(r.ask)} · PM VWAP ${fPx(r.pmVwap)} · PM high ${fPx(r.pmHigh)}</p>`;
}

function updateGateLive(r) {
  const g = r.gate;
  const c = $('#gCount');
  if (c) c.textContent = `${g.cleared} OF ${g.total} CHECKS CLEARED`;
  const b = $('#gBar');
  if (b) b.style.width = `${(g.cleared / g.total) * 100}%`;
}

const badgeText = (c) =>
  ({ pass: c.id === 'etf' ? '✓ YES' : '✓ PASS', fail: c.id === 'etf' ? 'ETF' : 'FAIL', pending: 'PENDING', na: 'N/A' })[c.status];

function newsHtml(items) {
  if (!items.length) return '<p class="detail">No recent news found.</p>';
  return `<ul class="news">${items
    .map((n) => {
      const when = n.at ? new Date(n.at).toLocaleString() : '';
      const title = n.url && /^https?:\/\//.test(n.url) ? `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>` : esc(n.title);
      return `<li>${title}<div class="detail">${esc(n.publisher)} · ${esc(when)}</div></li>`;
    })
    .join('')}</ul>`;
}

$('#gate').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const r = selRow();
  if (!r) return;
  const act = btn.dataset.act;
  try {
    if (act === 'catalyst') applyScan(await api('/api/catalyst', { symbol: r.symbol, status: btn.dataset.v }));
    else if (act === 'halal') applyScan(await api('/api/halal', { symbol: r.symbol, status: btn.dataset.v }));
    else if (act === 'news') {
      state.news[r.symbol] = await api(`/api/news?symbol=${encodeURIComponent(r.symbol)}`);
      renderGate();
    } else if (act === 'suggest') suggestPlan(r);
    else if (act === 'plan') await savePlan(r);
    else if (act === 'ticket') await openTicket(r.symbol);
  } catch (err) {
    showError(err.message);
  }
});

$('#gate').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-plan]')) {
    e.preventDefault();
    const r = selRow();
    if (r) savePlan(r).catch((err) => showError(err.message));
  }
});

function readPlanInputs() {
  const v = (k) => document.querySelector(`#gate [data-plan="${k}"]`)?.value ?? '';
  return { entry: v('entry'), stop: v('stop'), target: v('target') };
}

async function savePlan(r) {
  const scan = await api('/api/plan', { symbol: r.symbol, ...readPlanInputs() });
  document.activeElement?.blur();
  applyScan(scan);
}

function suggestPlan(r) {
  const tick = r.price >= 1 ? 0.01 : 0.0001;
  const round = (v) => (r.price >= 1 ? v.toFixed(2) : v.toFixed(4));
  const entry = r.ask ?? (r.priorPmHigh ? r.priorPmHigh + tick : r.price);
  const lows = [r.lastBar?.l, r.pmVwap].filter((x) => x > 0 && x < entry);
  const stop = lows.length ? Math.max(...lows) - tick : entry * 0.97;
  const set = (k, v) => {
    const i = document.querySelector(`#gate [data-plan="${k}"]`);
    if (i) i.value = round(v);
  };
  set('entry', entry);
  set('stop', stop);
  document.querySelector('#gate [data-plan="target"]')?.focus();
}

// ---------- order ticket ----------
async function openTicket(sym) {
  const t = await api('/api/order/preview', { symbol: sym });
  state.ticket = t;
  const liveWarn = t.live
    ? '<div class="warn live">LIVE ACCOUNT — this sends a REAL-MONEY order.</div>'
    : `<div class="warn">${t.broker === 'alpaca' ? 'Alpaca PAPER account' : 'Simulated broker'} — no real money.</div>`;
  $('#orderTitle').textContent = `BUY ${t.symbol}`;
  $('#orderBody').innerHTML = `
    <dl class="kv">
      <dt>Quantity</dt><dd>${t.qty} shares</dd>
      <dt>Limit price</dt><dd>${fPx(t.limit)} <span class="muted">(ask ${fPx(t.ask)})</span></dd>
      <dt>Stop</dt><dd>${fPx(t.stop)}</dd>
      <dt>Target</dt><dd>${fPx(t.target)}</dd>
      <dt>Reward : risk</dt><dd>${t.rr.toFixed(2)}x</dd>
      <dt>Max risk</dt><dd>${usd(t.riskDollars)}</dd>
      <dt>Position value</dt><dd>${usd(t.value)}</dd>
      <dt>Session</dt><dd>${esc(t.session)}</dd>
    </dl>
    <div class="warn">${esc(t.note)}</div>${liveWarn}`;
  $('#orderDlg').showModal();
}

$('#orderDlg').addEventListener('close', async () => {
  if ($('#orderDlg').returnValue !== 'confirm' || !state.ticket) return;
  const t = state.ticket;
  state.ticket = null;
  try {
    const res = await api('/api/order', { symbol: t.symbol, qty: t.qty, limit: t.limit, confirm: true });
    showError('');
    flashMsg(`Order sent: BUY ${res.ticket.qty} ${res.ticket.symbol} @ ${fPx(res.ticket.limit)} — status ${res.order.status}`);
    loadBroker();
  } catch (e) {
    showError(`Order rejected: ${e.message}`);
  }
});

function flashMsg(msg) {
  const el = $('#errorBar');
  el.hidden = false;
  el.style.borderColor = 'var(--green)';
  el.style.color = '#b8f5cf';
  el.style.background = '#0b2a18';
  el.textContent = msg;
  setTimeout(() => {
    el.removeAttribute('style');
    el.hidden = true;
  }, 6000);
}

// ---------- broker panel ----------
async function loadBroker() {
  const el = $('#broker');
  try {
    const b = await api('/api/broker');
    const a = b.account;
    el.innerHTML = `
      <h4>BROKER · ${esc(b.name.toUpperCase())} · ${esc(a.mode)}</h4>
      <div class="acct"><span>Equity <b>${usd(a.equity)}</b></span><span>Cash <b>${usd(a.cash)}</b></span><span>Buying power <b>${usd(a.buyingPower)}</b></span></div>
      <div class="cols">
        <div><div class="table-wrap"><table><thead><tr><th class="l">POSITION</th><th>QTY</th><th>AVG</th><th>LAST</th><th>P/L</th><th></th></tr></thead><tbody>
          ${b.positions.length ? b.positions.map((p) => `<tr><td class="l"><b>${esc(p.symbol)}</b></td><td>${p.qty}</td><td>${fPx(p.avgPrice)}</td><td>${fPx(p.lastPrice)}</td><td class="${cls(p.unrealizedPl)}">${usd(p.unrealizedPl)}</td><td><button class="btn sm danger" data-close="${esc(p.symbol)}">Sell all</button></td></tr>`).join('') : '<tr><td colspan="6" class="muted">No open positions</td></tr>'}
        </tbody></table></div></div>
        <div><div class="table-wrap"><table><thead><tr><th class="l">ORDER</th><th>SIDE</th><th>QTY</th><th>TYPE</th><th>LIMIT</th><th>STATUS</th><th></th></tr></thead><tbody>
          ${b.orders.length ? b.orders.slice(0, 8).map((o) => `<tr><td class="l">${esc(o.symbol)}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${esc(o.side)}</td><td>${o.qty}</td><td>${esc(o.type)}</td><td>${fPx(o.limit)}</td><td>${esc(o.status)}</td><td>${['new', 'accepted', 'pending_new', 'partially_filled', 'held'].includes(o.status) ? `<button class="btn sm" data-cancel="${esc(o.id)}">Cancel</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="7" class="muted">No orders today</td></tr>'}
        </tbody></table></div></div>
      </div>
      <h4 style="margin-top:14px">AUTO EXITS · ${b.autoExits ? '<span class="up">ON</span>' : '<span class="down">OFF</span> (enable in ⚙️)'}</h4>
      <div class="table-wrap"><table><thead><tr><th class="l">SYMBOL</th><th>STOP</th><th>TARGET</th><th>LAST</th><th>STATUS</th><th></th></tr></thead><tbody>
        ${b.exits.length ? b.exits.map((x) => `<tr><td class="l"><b>${esc(x.symbol)}</b></td><td class="down">${fPx(x.stop)}</td><td class="up">${fPx(x.target)}</td><td>${fPx(x.last)}</td><td>${esc(x.status)}${x.error ? ` <span class="down" title="${esc(x.error)}">⚠</span>` : ''}</td><td><button class="btn sm" data-unexit="${esc(x.symbol)}">Remove</button></td></tr>`).join('') : '<tr><td colspan="6" class="muted">No premarket entries being watched</td></tr>'}
      </tbody></table></div>`;
  } catch (e) {
    el.innerHTML = `<h4>BROKER</h4><p class="muted">Unavailable: ${esc(e.message)}</p>`;
  }
}

$('#broker').addEventListener('click', async (e) => {
  const close = e.target.closest('[data-close]');
  const cancel = e.target.closest('[data-cancel]');
  const unexit = e.target.closest('[data-unexit]');
  try {
    if (unexit) {
      await api('/api/exit/remove', { symbol: unexit.dataset.unexit });
      return loadBroker();
    }
    if (close) {
      const sym = close.dataset.close;
      if (!confirm(`Sell entire ${sym} position? Outside regular hours a LIMIT order at the current bid is sent.`)) return;
      await api('/api/close', { symbol: sym });
      loadBroker();
    } else if (cancel) {
      await api('/api/cancel', { id: cancel.dataset.cancel });
      loadBroker();
    }
  } catch (err) {
    showError(err.message);
  }
});

// ---------- controls & settings ----------
function syncControls(s) {
  const setSel = (id, v) => {
    const el = $(id);
    if (document.activeElement === el) return;
    if (![...el.options].some((o) => Number(o.value) === Number(v) || o.value === v)) {
      el.add(new Option(String(v), String(v)));
    }
    el.value = [...el.options].find((o) => o.value === String(v) || Number(o.value) === Number(v)).value;
  };
  setSel('#marketSel', s.market);
  setSel('#pmVolSel', s.minPmVol);
  setSel('#rvolSel', s.minRvol);
}

async function saveSettings(patch) {
  try {
    await api('/api/settings', patch);
    await refresh(true);
    schedule();
  } catch (e) {
    showError(e.message);
  }
}

$('#marketSel').addEventListener('change', (e) => saveSettings({ market: e.target.value }));
$('#pmVolSel').addEventListener('change', (e) => saveSettings({ minPmVol: Number(e.target.value) }));
$('#rvolSel').addEventListener('change', (e) => saveSettings({ minRvol: Number(e.target.value) }));
$('#runBtn').addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  setRunning(!state.running);
});
$('#refreshBtn').addEventListener('click', () => refresh(true));

$('#settingsBtn').addEventListener('click', () => {
  const s = state.scan?.settings;
  if (!s) return;
  const f = $('#settingsForm');
  for (const el of f.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = !!s[el.name];
    else el.value = s[el.name];
  }
  $('#settingsDlg').showModal();
});

$('#settingsDlg').addEventListener('close', () => {
  if ($('#settingsDlg').returnValue !== 'save') return;
  const patch = {};
  for (const el of $('#settingsForm').elements) {
    if (!el.name) continue;
    patch[el.name] = el.type === 'checkbox' ? el.checked : Number(el.value);
  }
  saveSettings(patch);
});

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || document.querySelector('dialog[open]')) return;
  const rows = allRows();
  const i = rows.findIndex((r) => r.symbol === state.selected);
  const r = selRow();
  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    if (rows.length) select(rows[Math.min(rows.length - 1, i + 1)].symbol);
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    if (rows.length) select(rows[Math.max(0, i - 1)].symbol);
  } else if (e.key === 'r' || e.key === 'R') refresh(true);
  else if (e.key === ' ') {
    e.preventDefault();
    setRunning(!state.running);
  } else if ((e.key === 'v' || e.key === 'V') && r) {
    api('/api/catalyst', { symbol: r.symbol, status: 'verified' }).then(applyScan).catch((err) => showError(err.message));
  } else if ((e.key === 'h' || e.key === 'H') && r) {
    api('/api/halal', { symbol: r.symbol, status: 'halal' }).then(applyScan).catch((err) => showError(err.message));
  } else if ((e.key === 'b' || e.key === 'B') && r?.gate.qualified) {
    openTicket(r.symbol).catch((err) => showError(err.message));
  }
});

// ---------- boot ----------
(async function boot() {
  try {
    const s = await api('/api/status');
    state.status = s;
    const badge = $('#modeBadge');
    const brokerTxt = s.broker === 'alpaca' ? (s.live ? 'LIVE MONEY' : 'PAPER') : 'SIM BROKER';
    badge.textContent = s.demoData ? `DEMO DATA — NOT LIVE · ${brokerTxt}` : `LIVE DATA · ${brokerTxt}`;
    badge.className = `mode-badge ${s.live ? 'live' : s.broker === 'alpaca' ? 'paper' : ''}`;
    $('#footLeft').textContent = s.demoData ? 'DEMO · SIMULATED FIGURES · NOT MARKET DATA' : `DATA: ${s.provider.toUpperCase()}`;
  } catch (e) {
    showError(e.message);
  }
  setRunning(true);
  loadBroker();
  setInterval(loadBroker, 10_000);
})();
