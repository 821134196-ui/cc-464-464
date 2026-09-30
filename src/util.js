// 通用工具
export const now = () => Date.now();

// 本地时间 "YYYY-MM-DD HH:MM"
export function fmt(ts) {
  if (ts == null) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDate(ts) {
  return fmt(ts).slice(0, 10);
}

// "HH:MM"
export function hm(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 把 "YYYY-MM-DD HH:MM"（本地时间）转成 epoch
export function parseLocal(s) {
  if (typeof s === 'number') return s;
  if (!s) throw new Error('时间不能为空');
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) throw new Error(`时间格式错误: ${s}`);
  const [, y, mo, d, h, mi, se] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +(se || 0)).getTime();
}

export function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function sameDay(a, b) {
  const da = new Date(a), db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

export function minutesBetween(a, b) {
  return Math.round((b - a) / 60000);
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function money(n) {
  return `¥${Number(n).toLocaleString('zh-CN')}`;
}

// 简单的 deep clone（SQLite 行均为普通对象）
export const clone = (o) => JSON.parse(JSON.stringify(o));

export function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

export function badRequest(res, message, extra = {}) {
  json(res, 400, { error: message, ...extra });
}

export function notFound(res, message = '资源不存在') {
  json(res, 404, { error: message });
}

export function forbidden(res, message = '无权操作') {
  json(res, 403, { error: message });
}
