// US/Eastern helpers. All timestamps are epoch milliseconds.
const TZ = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});

export function etParts(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
    s: Number(p.second),
    wd: p.weekday,
  };
}

function offsetMs(ms) {
  const p = etParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Convert an Eastern wall-clock time to epoch ms. */
export function etToMs(y, mo, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ms = guess - offsetMs(guess);
  const off2 = offsetMs(ms);
  if (guess - off2 !== ms) ms = guess - off2;
  return ms;
}

export function etDateStr(ms) {
  const p = etParts(ms);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function etTimeStr(ms) {
  const p = etParts(ms);
  return [p.h, p.mi, p.s].map((n) => String(n).padStart(2, '0')).join(':');
}

function splitDate(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return { y, mo, d };
}

/** Key session boundaries (ET) for a YYYY-MM-DD date. */
export function sessionTimes(dateStr) {
  const { y, mo, d } = splitDate(dateStr);
  return {
    pmStart: etToMs(y, mo, d, 4, 0),
    open: etToMs(y, mo, d, 9, 30),
    close: etToMs(y, mo, d, 16, 0),
    ahEnd: etToMs(y, mo, d, 20, 0),
  };
}

export function sessionOf(ms) {
  const p = etParts(ms);
  if (p.wd === 'Sat' || p.wd === 'Sun') return 'closed';
  const t = sessionTimes(etDateStr(ms));
  if (ms < t.pmStart) return 'closed';
  if (ms < t.open) return 'premarket';
  if (ms < t.close) return 'regular';
  if (ms < t.ahEnd) return 'afterhours';
  return 'closed';
}

/** Previous `n` weekdays before dateStr (holidays are not removed; they simply have no data). */
export function prevWeekdays(dateStr, n) {
  const { y, mo, d } = splitDate(dateStr);
  const out = [];
  let t = Date.UTC(y, mo - 1, d, 12);
  while (out.length < n) {
    t -= 86400000;
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
