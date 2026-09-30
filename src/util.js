'use strict';

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function pad(n) { return String(n).padStart(2, '0'); }

// 本地日期键 YYYY-MM-DD
function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseISO(s) { return new Date(s); }

function minutesBetween(aIso, bIso) {
  return Math.round((new Date(bIso) - new Date(aIso)) / 60000);
}

function addMinutes(iso, min) {
  return new Date(new Date(iso).getTime() + min * 60000).toISOString();
}

// 半开区间 [s1,e1) 与 [s2,e2) 是否重叠
function overlaps(s1, e1, s2, e2) {
  return new Date(s1) < new Date(e2) && new Date(s2) < new Date(e1);
}

function isCrossDay(sIso, eIso) {
  const a = new Date(sIso), b = new Date(eIso);
  return dateKey(a) !== dateKey(b);
}

function todayAt(hour, minute = 0) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function relIso(minFromNow) {
  return addMinutes(new Date().toISOString(), minFromNow);
}

function jsonOr(v, fallback = null) {
  try { return JSON.parse(v); } catch { return fallback; }
}

const ACTIVE_RES_STATUSES = ['approved', 'dispatched', 'returned', 'watching'];
const BLOCKING_RES_STATUSES = ['requested', 'approved', 'dispatched', 'returned', 'watching'];
const SIDES = ['front', 'rear', 'left', 'right'];
const SIDE_LABEL = { front: '车头正面', rear: '车尾正面', left: '车身左侧', right: '车身右侧' };

module.exports = {
  uid, nowISO, dateKey, parseISO, minutesBetween, addMinutes, overlaps,
  isCrossDay, todayAt, relIso, jsonOr,
  ACTIVE_RES_STATUSES, BLOCKING_RES_STATUSES, SIDES, SIDE_LABEL,
};
