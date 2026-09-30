'use strict';
/* 试驾车预约与车况交接平台 —— 前端 SPA（零依赖原生 JS） */

const state = {
  meta: null, actorId: localStorage.getItem('td_actor') || 'st_lin',
  view: location.hash.replace(/^#\/?/, '') || 'board',
  calDate: null,
  selectedRes: null,
};

const SIDES = ['front', 'rear', 'left', 'right'];
const SIDE_NAME = { front: '车头正面', rear: '车尾正面', left: '车身左侧', right: '车身右侧' };
const STATUS_NAME = {
  available: '可预约', booked: '已锁定', out: '在外试驾', watching: '违章留观', incident_locked: '异常锁定',
  requested: '待审核', approved: '已通过', dispatched: '试驾中', returned: '已回店',
  watching: '留观/清洁中', completed: '已完成', rejected: '已驳回',
  cancelled: '已取消', released_late: '迟到释放', swapped_out: '已换车',
};

// ---------------- 工具 ----------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function badge(status, text) { return `<span class="badge b-${status}">${esc(text || STATUS_NAME[status] || status)}</span>`; }
function dt(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'; }
function hm(iso) { return iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''; }
function dkey(iso) { return new Date(iso).toLocaleDateString('zh-CN'); }
function duration(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  return h ? `${h}小时${min % 60 ? (min % 60) + '分' : ''}` : `${min}分钟`;
}
function toLocalInput(iso) {
  const d = new Date(iso), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function overlaps(a, b, c, d) { return new Date(a) < new Date(d) && new Date(c) < new Date(b); }

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg; el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'x-staff-id': state.actorId },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || '请求失败');
    err.code = data.error; err.status = res.status;
    throw err;
  }
  return data;
}

const actor = () => state.meta.staff.find(s => s.id === state.actorId);
const isSuper = () => actor()?.role === 'supervisor';
const vehicle = id => state.meta?._vehicles?.find(v => v.id === id);
const model = id => state.meta?.models.find(m => m.id === id);
const staffName = id => state.meta?.staff.find(s => s.id === id)?.name || id;

// ---------------- 车身 SVG（与服务端同一视觉语言，本地"拍摄"生成） ----------------
function carSVG({ side, color = '#2f6bd8', damage = false, stamp = '', plate = '' }) {
  const label = { front: '车头正面 FRONT', rear: '车尾正面 REAR', left: '车身左侧 LEFT', right: '车身右侧 RIGHT' }[side];
  let shape;
  if (side === 'front' || side === 'rear') {
    const isFront = side === 'front';
    shape = `<path d="M170 250 q10 -86 70 -104 q80 -26 160 0 q60 18 70 104 l-6 52 q-2 14 -18 14 l-228 0 q-16 0 -18 -14 z" fill="${color}" stroke="#1d2530" stroke-width="2"/>
      <path d="M214 158 q106 -34 212 0 l10 38 -232 0 z" fill="#a9c4ee" opacity=".85" stroke="#1d2530"/>
      <rect x="236" y="252" width="168" height="34" rx="8" fill="#222a35"/>
      <rect x="262" y="258" width="116" height="22" rx="4" fill="#eef2f8"/>
      <text x="320" y="275" font-size="15" fill="#2b3038" text-anchor="middle" font-weight="700">${isFront ? '前牌' : '后牌'}</text>
      <circle cx="212" cy="306" r="30" fill="#151a21"/><circle cx="212" cy="306" r="15" fill="#5a6573"/>
      <circle cx="428" cy="306" r="30" fill="#151a21"/><circle cx="428" cy="306" r="15" fill="#5a6573"/>
      <rect x="${isFront ? 208 : 392}" y="214" width="40" height="16" rx="6" fill="#fff3bf" stroke="#1d2530"/>`;
  } else {
    shape = `<path d="M110 268 q8 -70 64 -92 l56 -30 q70 -14 150 4 l52 30 q42 20 52 88 l-4 40 q-2 14 -18 14 l-334 0 q-16 0 -18 -14 z" fill="${color}" stroke="#1d2530" stroke-width="2"/>
      <path d="M188 182 l50 -26 q64 -10 128 2 l46 24 z" fill="#a9c4ee" opacity=".85" stroke="#1d2530"/>
      <line x1="292" y1="158" x2="288" y2="182" stroke="#1d2530" stroke-width="2"/>
      <rect x="250" y="214" width="140" height="10" rx="4" fill="#1d2530" opacity=".35"/>
      <circle cx="196" cy="312" r="34" fill="#151a21"/><circle cx="196" cy="312" r="17" fill="#5a6573"/>
      <circle cx="446" cy="312" r="34" fill="#151a21"/><circle cx="446" cy="312" r="17" fill="#5a6573"/>`;
  }
  const mark = damage ? `<g>
      <ellipse cx="452" cy="230" rx="46" ry="30" fill="none" stroke="#d92d20" stroke-width="4" stroke-dasharray="8 6"/>
      <path d="M430 214 l44 32 M474 214 l-44 32" stroke="#d92d20" stroke-width="3"/>
      <rect x="402" y="176" width="100" height="22" rx="4" fill="#d92d20"/>
      <text x="452" y="192" font-size="13" fill="#fff" text-anchor="middle" font-weight="700">疑似新损伤</text></g>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" width="640" height="400" font-family="ui-monospace,Menlo,Consolas,monospace">
  <rect width="640" height="400" fill="#f4f6fa"/><rect x="0" y="330" width="640" height="70" fill="#e6eaf1"/>
  <g stroke="#d3d9e4"><line x1="0" y1="352" x2="640" y2="352"/><line x1="0" y1="378" x2="640" y2="378"/></g>
  <text x="20" y="36" font-size="15" fill="#2b3038" font-weight="700">${label}</text>
  <text x="20" y="58" font-size="12" fill="#6a7280">${esc(plate)} · 车身影像（模拟）</text>
  ${shape}${mark}
  <text x="20" y="384" font-size="12" fill="#6a7280">${esc(stamp)}</text>
  <text x="620" y="36" font-size="12" fill="#6a7280" text-anchor="end">SHOT-MOCK v1</text></svg>`;
}

async function captureShot(resId, phase, side, damage) {
  const vh = vehicle(reservationVehicleId(resId)) || {};
  const svg = carSVG({
    side, damage,
    color: vh._color || plateColor(vh.plate), plate: vh.plate || '',
    stamp: `${phase === 'out' ? '出车拍摄' : '回店拍摄'} · ${new Date().toLocaleString('zh-CN')}`,
  });
  await api('/api/photos', { method: 'POST', body: { reservation_id: resId, phase, side, svg } });
}
// 车漆色板（车漆白/深石墨/信号蓝体系），按车牌稳定取色
const PAINT = ['#f2f4f8', '#262b33', '#2f6bd8', '#8a93a3', '#3aa0c9', '#41506b', '#6b7280', '#7d5ba6'];
function plateColor(plate) {
  let h = 0;
  for (const ch of String(plate || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PAINT[h % PAINT.length];
}
function reservationVehicleId(resId) {
  const cache = state._resCache || {};
  return cache[resId]?.vehicle_id || $('#drawer')?.dataset?.vehicleId || null;
}

// ---------------- 外壳 ----------------
const TABS = [
  ['board', '车辆状态板'], ['calendar', '车型日历'], ['approvals', '预约审核'],
  ['dispatch', '出车清单'], ['route', '路线计时'], ['return', '回车对照'],
  ['watch', '违章留观'], ['incidents', '事故复核'],
];

async function boot() {
  state.meta = await api('/api/meta');
  const boardData = await api('/api/board');
  state.meta._vehicles = boardData.groups.flatMap(g => g.vehicles);
  renderChrome();
  window.addEventListener('hashchange', route);
  route();
  setInterval(tickClocks, 1000);
}

function renderChrome() {
  $('#tabs').innerHTML = TABS.map(([k, label]) =>
    `<button class="tab" data-view="${k}">${label}</button>`).join('');
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('.tab');
    if (b) location.hash = `#/${b.dataset.view}`;
  });
  const sel = $('#actorSelect');
  sel.innerHTML = state.meta.staff.map(s =>
    `<option value="${s.id}">${s.name}（${s.role === 'supervisor' ? '主管' : '销售顾问'}）</option>`).join('');
  sel.value = state.actorId;
  sel.addEventListener('change', () => {
    state.actorId = sel.value; localStorage.setItem('td_actor', sel.value);
    renderChrome(); route();
  });
}

function route() {
  state.view = location.hash.replace(/^#\/?/, '') || 'board';
  if (!TABS.some(([k]) => k === state.view)) { state.view = 'board'; }
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === state.view));
  const s = actor();
  $('#roleChip').textContent = s ? (s.role === 'supervisor' ? '主管' : '销售顾问') : '';
  $('#roleChip').className = `role-chip ${s?.role || ''}`;
  $('#actorSelect').value = state.actorId;
  ({
    board: renderBoard, calendar: renderCalendar, approvals: renderApprovals,
    dispatch: renderDispatch, route: renderRoute, return: renderReturnView,
    watch: renderWatch, incidents: renderIncidents,
  })[state.view]();
}

function head(title, sub, actions = '') {
  return `<div class="view-head"><h2>${title}</h2><span class="sub">${sub}</span><div class="spacer"></div>${actions}</div>`;
}

function tickClocks() {
  $('#clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const now = Date.now();
  $$('.js-elapsed').forEach(el => {
    const start = +el.dataset.started, due = +el.dataset.due;
    const sec = Math.max(0, Math.floor((now - start) / 1000));
    const mm = String(Math.floor(sec / 60)).padStart(2, '0'), ss = String(sec % 60).padStart(2, '0');
    el.querySelector('.e-val').textContent = `${mm}:${ss}`;
    if (due && now > due) {
      const over = Math.floor((now - due) / 60000);
      el.querySelector('.e-over').textContent = `已超时 ${over} 分钟`;
      el.querySelector('.e-val')?.classList.add('over');
    }
  });
  $$('.js-countdown').forEach(el => {
    const ms = +el.dataset.ends - now;
    if (ms <= 0) { el.textContent = '已到期（等待系统结束）'; el.classList.add('over'); return; }
    const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24,
      m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    el.textContent = d > 0 ? `${d}天 ${h}小时${m}分` : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    el.classList.toggle('over', ms < 3600000);
  });
}

// ================= 1) 车辆状态板 =================
async function renderBoard() {
  const data = await api('/api/board');
  const v = $('#view');
  v.innerHTML = head('车辆状态板', '车辆按车型分组；异常锁定车辆不可预约') +
    data.groups.map(g => `
    <section class="model-group">
      <div class="model-head"><h3>${esc(g.brand)} ${esc(g.name)}</h3>
        <span class="seg">${esc(g.segment)}</span>
        <span class="count">${g.vehicles.length} 台 · ${g.vehicles.filter(x => x.status === 'available').length} 台可约</span></div>
      <div class="vehicle-strip">
        ${g.vehicles.map(vh => `
        <div class="vcard st-${vh.status}" data-vehicle="${vh.id}">
          <div class="spread"><span class="plate mono">${esc(vh.plate)}</span>${badge(vh.status)}</div>
          <div class="nick">${esc(vh.nickname || '')} · ${vh.year} 款</div>
          <div class="sep"></div>
          <div class="spread"><span class="muted small">总里程</span><span class="mileage mono">${vh.mileage.toLocaleString()}<small style="font-weight:400"> km</small></span></div>
          <div class="spread small" style="margin-top:4px">
            <span class="muted">油量 <b class="mono ${vh.fuel_pct < state.meta.config.LOW_FUEL_PCT ? 'fuel-low-tag' : ''}">${vh.fuel_pct}%</b>
              ${vh.fuel_pct < state.meta.config.LOW_FUEL_PCT ? '· 低油量' : ''}</span>
          </div>
          <div class="fuelbar"><i class="${vh.fuel_pct < state.meta.config.LOW_FUEL_PCT ? 'low' : ''}" style="width:${vh.fuel_pct}%"></i></div>
          ${vh.condition_flag === 'abnormal' ? `<div class="tiny" style="color:var(--danger);margin-top:6px">⚠ ${esc(vh.issue_note || '车况异常')}</div>` : ''}
        </div>`).join('')}
      </div>
    </section>`).join('');
  $$('.vcard').forEach(c => c.addEventListener('click', () => openVehicle(c.dataset.vehicle)));
}

async function openVehicle(id) {
  const [versions] = await Promise.all([api(`/api/vehicles/${id}/versions`)]);
  const vh = vehicle(id);
  const verRows = versions.items.slice().reverse();
  openDrawer(`
    <h2>${esc(vh.brand)} ${esc(vh.model_name)} <span class="mono" style="font-size:14px">${esc(vh.plate)}</span></h2>
    <div class="muted small" style="margin:4px 0 12px">${esc(vh.nickname || '')} · ${vh.year} 款</div>
    <div class="row">${badge(vh.status)} ${vh.condition_flag === 'abnormal' ? badge('incident_locked', '车况异常') : badge('completed', '车况正常')}</div>
    <div class="card" style="margin-top:14px">
      <h3>当前读数</h3>
      <div class="grid grid-3">
        <div><div class="muted tiny">总里程</div><div class="readout mono">${vh.mileage.toLocaleString()}<small>km</small></div></div>
        <div><div class="muted tiny">油量</div><div class="readout mono">${vh.fuel_pct}<small>%</small></div></div>
        <div><div class="muted tiny">低油阈值</div><div class="readout" style="font-size:18px">${state.meta.config.LOW_FUEL_PCT}%</div></div>
      </div>
      <div class="sep"></div>
      <div class="row">
        <input type="number" min="0" max="100" id="fuelInput" placeholder="加油后油量 %" style="max-width:160px">
        <button class="btn primary" id="refuelBtn">登记加油</button>
      </div>
    </div>
    <div class="card">
      <h3>车况版本链 <span class="hint">每次出车/回车/事故/加油均生成版本，保证里程连续可溯</span></h3>
      <ul class="timeline">
        ${verRows.map(x => `<li>
          <div class="t-time">v${x.version} · ${dt(x.created_at)}</div>
          <div class="t-txt">
            <b>${{ baseline: '基线台账', dispatch: '出车快照', return: '回车快照', incident: '事故/故障', refuel: '加油登记', clear: '异常清除' }[x.source] || x.source}</b>
            <span class="mono" style="margin-left:8px">${x.mileage.toLocaleString()} km</span>
            · 油量 <span class="mono">${x.fuel_pct}%</span>
            ${x.condition_flag === 'abnormal' ? '· <span class="damage-chip">异常</span>' : ''}
            ${x.issue_note ? `<div class="muted tiny">${esc(x.issue_note)}</div>` : ''}
            <div class="muted tiny">操作人：${staffName(x.created_by)}</div>
          </div></li>`).join('')}
      </ul>
    </div>`);
  $('#refuelBtn').addEventListener('click', async () => {
    const val = Number($('#fuelInput').value);
    try { await api(`/api/vehicles/${id}/refuel`, { method: 'POST', body: { fuel_pct: val } });
      toast('加油已登记，生成新版本', 'ok'); closeDrawer(); renderBoard();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ================= 2) 车型日历 =================
async function renderCalendar() {
  if (!state.calDate) state.calDate = new Date().toISOString().slice(0, 10);
  const v = $('#view');
  v.innerHTML = head('车型日历', '同一视图展示车辆与销售顾问占用', `
    <div class="cal-toolbar">
      <button class="btn sm" id="prevDay">‹ 前一天</button>
      <input type="date" id="calDate" value="${state.calDate}" style="width:auto">
      <button class="btn sm" id="nextDay">后一天 ›</button>
      <button class="btn sm" id="todayBtn">今天</button>
    </div>`) + `
    <div class="card">
      <div class="legend">
        <span><i style="background:#e6efff;border:1px solid #bcd4fb"></i>已通过/待审核</span>
        <span><i style="background:#ece8ff;border:1px solid #cfc5fb"></i>试驾中</span>
        <span><i style="background:#fdf0dc;border:1px solid #f3d7a8"></i>留观/回店</span>
        <span><i style="background:#e4f5ea;border:1px solid #b6e2c4"></i>已完成</span>
      </div>
      <div class="lane-scroll" style="margin-top:10px"><div class="timeline" id="calLanes"></div></div>
    </div>`;

  $('#prevDay').onclick = () => { shiftDate(-1); };
  $('#nextDay').onclick = () => { shiftDate(1); };
  $('#todayBtn').onclick = () => { state.calDate = new Date().toISOString().slice(0, 10); renderCalendar(); };
  $('#calDate').onchange = e => { state.calDate = e.target.value; renderCalendar(); };

  const data = await api(`/api/calendar?date=${state.calDate}`);
  const dayStart = new Date(`${state.calDate}T00:00:00`).getTime();
  const P = date => {
    const ms = new Date(date).getTime() - dayStart;
    return { left: Math.max(0, ms / 864000) / 100, width: 0 };
  };
  const posOf = (sIso, eIso) => {
    const s = Math.max(dayStart, new Date(sIso).getTime());
    const e = Math.min(dayStart + 86400000, new Date(eIso).getTime());
    return { left: (s - dayStart) / 864000, width: Math.max(2, (e - s) / 864000) };
  };
  const ticks = Array.from({ length: 13 }, (_, i) => i * 2).map(h =>
    `<div class="hour-tick" style="left:${h / 24 * 100}%"><span>${String(h).padStart(2, '0')}:00</span></div>`).join('');

  const laneHtml = (label, dot, lanes) => `
    <div class="lane head"><div class="lane-label">${label}</div><div class="lane-track"><div class="hour-row">${ticks}</div></div></div>
    ${lanes.map(l => `
    <div class="lane">
      <div class="lane-label"><span class="dot" style="background:${dot}"></span>
        <span>${esc(l.plate || l.name)}</span>
        ${l.status ? `<span class="muted tiny">${esc(STATUS_NAME[l.status] || '')}</span>` : ''}
      </div>
      <div class="lane-track"><div class="hour-row">
        ${ticks}
        ${l.items.map(r => {
          const p = posOf(r.start_at, r.end_at);
          return `<div class="event ${r.status} ${r.cross_day ? 'crossday' : ''}"
            style="left:${p.left}%;width:${p.width}%" data-res="${r.id}"
            title="${esc(r.code)} ${esc(r.customer_code)} ${dt(r.start_at)}–${dt(r.end_at)}">
            ${hm(r.start_at)} ${esc(r.code)} · ${esc(r.customer_code)}</div>`;
        }).join('')}
      </div></div>
    </div>`).join('')}`;

  $('#calLanes').innerHTML =
    `<div style="padding:6px 10px;font-weight:700;font-size:13px;color:var(--graphite-2)">🚗 车辆占用</div>` +
    laneHtml('', 'var(--signal)', data.vehicleLanes) +
    `<div style="padding:14px 10px 6px;font-weight:700;font-size:13px;color:var(--graphite-2)">🧑‍💼 销售顾问占用</div>` +
    laneHtml('', 'var(--ok)', data.advisorLanes);
  $$('.event').forEach(el => el.addEventListener('click', () => openReservation(el.dataset.res)));
}
function shiftDate(delta) {
  const d = new Date(`${state.calDate}T00:00:00`);
  d.setDate(d.getDate() + delta);
  state.calDate = d.toISOString().slice(0, 10);
  renderCalendar();
}

// ================= 3) 预约审核 =================
async function renderApprovals() {
  const [list] = await Promise.all([api('/api/reservations')]);
  state._resList = list.items;
  state._resCache = Object.fromEntries(list.items.map(r => [r.id, r]));
  const pending = list.items.filter(r => r.status === 'requested');
  const rest = list.items.filter(r => r.status !== 'requested').slice().reverse().slice(0, 30);
  const m = state.meta;
  const v = $('#view');
  v.innerHTML = head('预约审核', '通过后锁定车辆与销售顾问；跨日试驾必须先完成单独审批',
    `<button class="btn primary" id="newResBtn">＋ 新建预约</button>`) + `
    <div class="card">
      <h3>待审核（${pending.length}） <span class="hint">红色提示为车辆/顾问时间冲突，通过时会被服务端拦截</span></h3>
      ${pending.length ? `<table><thead><tr>
        <th>预约号</th><th>时段</th><th>车型/车辆</th><th>顾问</th><th>客户代号</th><th>冲突预检</th><th style="text-align:right">操作</th>
      </tr></thead><tbody>${pending.map(r => pendingRow(r, list.items)).join('')}</tbody></table>`
      : '<div class="empty">暂无待审核预约</div>'}
    </div>
    <div class="card">
      <h3>最近预约记录</h3>
      <table><thead><tr><th>预约号</th><th>时段</th><th>车辆</th><th>顾问</th><th>客户</th><th>状态</th><th></th></tr></thead>
      <tbody>${rest.map(r => `<tr class="clickable" data-res="${r.id}">
        <td class="mono">${esc(r.code)}${r.cross_day ? ' <span class="damage-chip">跨日</span>' : ''}</td>
        <td>${dt(r.start_at)}<br><span class="muted tiny">至 ${dt(r.end_at)}</span></td>
        <td>${esc(r.vehicle_plate || '未指定')}</td><td>${esc(r.advisor_name)}</td>
        <td>${esc(r.customer_code)}</td><td>${badge(r.status)}</td>
        <td style="text-align:right"><button class="btn sm" data-open="${r.id}">详情</button></td></tr>`).join('')}</tbody></table>
    </div>`;

  $('#newResBtn').onclick = openNewReservation;
  $$('[data-open]').forEach(b => b.onclick = e => { e.stopPropagation(); openReservation(b.dataset.open); });
  $$('tr.clickable').forEach(tr => tr.addEventListener('click', () => openReservation(tr.dataset.res)));
  bindApprovalActions(list.items);
}

function conflictHints(r, all) {
  const hints = [];
  for (const o of all) {
    if (o.id === r.id || ['rejected', 'cancelled', 'released_late', 'completed'].includes(o.status)) continue;
    if (!overlaps(r.start_at, r.end_at, o.start_at, o.end_at)) continue;
    if (r.vehicle_id && o.vehicle_id === r.vehicle_id)
      hints.push(`车辆与 ${o.code} 重叠`);
    if (o.advisor_id === r.advisor_id)
      hints.push(`顾问与 ${o.code} 重叠`);
  }
  return hints;
}

function pendingRow(r, all) {
  const hints = conflictHints(r, all);
  return `<tr>
    <td class="mono">${esc(r.code)}${r.cross_day ? ' <span class="damage-chip">跨日</span>' : ''}<br>
      <span class="muted tiny">${esc(r.route_name || '未选路线')}</span></td>
    <td class="small">${dt(r.start_at)}<br><span class="muted tiny">至 ${dt(r.end_at)}</span></td>
    <td>${esc(r.model_brand)} ${esc(r.model_name)}<br><b class="mono tiny">${esc(r.vehicle_plate || '未指定车辆')}</b></td>
    <td>${esc(r.advisor_name)}</td>
    <td class="mono">${esc(r.customer_code)}</td>
    <td>${hints.length ? hints.map(h => `<div style="color:var(--danger)" class="tiny">⚠ ${esc(h)}</div>`).join('') : '<span class="muted tiny">无重叠</span>'}</td>
    <td style="text-align:right;white-space:nowrap">
      <button class="btn sm" data-open="${r.id}">详情</button>
      ${r.cross_day ? `<button class="btn sm" data-xday="${r.id}">跨日审批</button>` : ''}
      <button class="btn sm" data-swap="${r.id}">换车</button>
      <button class="btn sm danger" data-reject="${r.id}">驳回</button>
      <button class="btn sm primary" data-approve="${r.id}" ${isSuper() ? '' : 'disabled title="仅主管可审批"'}>通过</button>
    </td></tr>`;
}

function bindApprovalActions(all) {
  $$('[data-approve]').forEach(b => b.onclick = async () => {
    const id = b.dataset.approve;
    try { await api(`/api/reservations/${id}/approve`, { method: 'POST' });
      toast('预约已通过：车辆与顾问已锁定，押金模拟扣款成功', 'ok'); renderApprovals();
    } catch (e) {
      if (e.code === 'cross_day_required') {
        if (!confirm('该预约为跨日试驾，需要先创建单独的跨日审批记录。现在创建并审批？')) return;
        try {
          await api(`/api/reservations/${id}/approvals`, { method: 'POST', body: { type: 'cross_day', decision: 'approved', note: '跨日深度体验，主管单独审批' } });
          await api(`/api/reservations/${id}/approve`, { method: 'POST' });
          toast('跨日审批已创建，预约通过', 'ok'); renderApprovals();
        } catch (e2) { toast(e2.message, 'err'); }
      } else toast(e.message, 'err');
    }
  });
  $$('[data-reject]').forEach(b => b.onclick = async () => {
    const reason = prompt('驳回原因：', '时段冲突或资料不全');
    if (reason === null) return;
    await api(`/api/reservations/${b.dataset.reject}/reject`, { method: 'POST', body: { reason } })
      .then(() => { toast('已驳回'); renderApprovals(); }).catch(e => toast(e.message, 'err'));
  });
  $$('[data-xday]').forEach(b => b.onclick = async () => {
    try {
      await api(`/api/reservations/${b.dataset.xday}/approvals`, { method: 'POST', body: { type: 'cross_day', decision: 'approved', note: prompt('跨日审批意见：', '同意跨日，需明确过夜停放地点') || '同意' } });
      toast('跨日审批记录已创建', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-swap]').forEach(b => b.onclick = () => openSwap(b.dataset.swap));
}

function openNewReservation() {
  const m = state.meta;
  const start = new Date(); start.setMinutes(start.getMinutes() + 30, 0, 0);
  const end = new Date(start.getTime() + 90 * 60000);
  openDrawer(`
    <h2>新建试驾预约</h2>
    <div class="muted small">客户信息以代号建档；提交后进入待审核</div>
    <div class="card" style="margin-top:12px"><div class="grid grid-2">
      <div><label>车型 *</label><select id="fModel">${m.models.map(x => `<option value="${x.id}">${esc(x.brand)} ${esc(x.name)}（${esc(x.segment)}）</option>`).join('')}</select></div>
      <div><label>试驾车</label><select id="fVehicle"></select></div>
      <div><label>销售顾问 *</label><select id="fAdvisor">${m.staff.filter(s => s.role === 'advisor').map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div>
      <div><label>客户代号 *</label><select id="fCustomer">${m.customers.map(x => `<option value="${x.code}">${esc(x.code)}（${x.license_valid ? '驾照正常' : '驾照异常'}${x.pay_fail ? '·支付失败样本' : ''}）</option>`).join('')}</select></div>
      <div><label>开始 *</label><input type="datetime-local" id="fStart" value="${toLocalInput(start)}"></div>
      <div><label>结束 *</label><input type="datetime-local" id="fEnd" value="${toLocalInput(end)}"></div>
      <div><label>试驾路线</label><select id="fRoute"><option value="">不指定</option>${m.routes.map(x => `<option value="${x.id}">${esc(x.name)}（${x.planned_minutes}分钟）</option>`).join('')}</select></div>
      <div><label>随车人员</label><input id="fCompanion" placeholder="如：体验专员 小温"></div>
    </div>
    <div style="margin-top:10px"><label>备注</label><textarea id="fNote" rows="2"></textarea></div>
    <div id="xdayWarn" class="tiny" style="color:var(--warn);margin-top:6px"></div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="submitRes">提交申请</button></div>
    </div>`);
  const fillVehicles = () => {
    const mid = $('#fModel').value;
    const vs = state.meta._vehicles.filter(v => v.model_id === mid);
    $('#fVehicle').innerHTML = '<option value="">暂不指定（审核前补派）</option>' +
      vs.map(v => `<option value="${v.id}">${esc(v.plate)} · ${esc(v.nickname || '')} · ${STATUS_NAME[v.status]}${v.condition_flag === 'abnormal' ? ' · 异常' : ''}</option>`).join('');
  };
  $('#fModel').onchange = fillVehicles; fillVehicles();
  const warnXday = () => {
    const cross = new Date($('#fStart').value).getDate() !== new Date($('#fEnd').value).getDate();
    $('#xdayWarn').textContent = cross ? '⚠ 该时段跨日：审核通过前必须由主管创建单独的跨日审批记录。' : '';
  };
  $('#fStart').oninput = warnXday; $('#fEnd').oninput = warnXday;
  $('#submitRes').onclick = async () => {
    try {
      const r = await api('/api/reservations', { method: 'POST', body: {
        model_id: $('#fModel').value, vehicle_id: $('#fVehicle').value || null,
        advisor_id: $('#fAdvisor').value, customer_code: $('#fCustomer').value,
        start_at: new Date($('#fStart').value).toISOString(), end_at: new Date($('#fEnd').value).toISOString(),
        route_id: $('#fRoute').value || null, companion: $('#fCompanion').value, note: $('#fNote').value,
      } });
      toast(`预约 ${r.code} 已提交`, 'ok'); closeDrawer(); renderApprovals();
    } catch (e) { toast(e.message, 'err'); }
  };
}

async function openSwap(resId) {
  const r = await api(`/api/reservations/${resId}`).then(x => x.reservation);
  const sameModel = state.meta._vehicles.filter(v => v.model_id === r.model_id && v.id !== r.vehicle_id);
  const others = state.meta._vehicles.filter(v => v.model_id !== r.model_id);
  openDrawer(`
    <h2>临时换车</h2>
    <div class="muted small">当前：<b class="mono">${esc(r.vehicle_plate)}</b>（${esc(r.model_brand)} ${esc(r.model_name)}）
    · 换同车型顾问可直接操作；<b style="color:var(--danger)">换车型必须主管审批</b></div>
    <div class="card" style="margin-top:12px">
      <label>目标车辆</label>
      <select id="swapTo">
        <optgroup label="同车型（可直接调换）">
          ${sameModel.map(v => `<option value="${v.id}">${esc(v.plate)} · ${esc(v.nickname || '')} · ${STATUS_NAME[v.status]}</option>`).join('')}
        </optgroup>
        <optgroup label="其他车型（需换车型审批）">
          ${others.map(v => `<option value="${v.id}">${esc(v.plate)} · ${esc(v.brand)} ${esc(v.model_name)} · ${STATUS_NAME[v.status]}${v.condition_flag === 'abnormal' ? ' · 异常' : ''}</option>`).join('')}
        </optgroup>
      </select>
      <div style="margin-top:10px"><label>原因</label><input id="swapReason" value="客户临时要求换车型体验"></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="swapGo">确认换车</button></div>
      <div id="swapHint" class="tiny" style="margin-top:8px"></div>
    </div>`);
  const hint = () => {
    const v = vehicle($('#swapTo').value);
    $('#swapHint').innerHTML = v.model_id !== r.model_id
      ? `<span style="color:var(--warn)">⚠ 目标为不同车型，提交时需要主管的"换车型"审批记录（当前身份${isSuper() ? '为主管，系统将自动创建' : '不是主管，将被拒绝'}）</span>`
      : '同车型调换，无需额外审批。';
  };
  $('#swapTo').onchange = hint; hint();
  $('#swapGo').onclick = async () => {
    const to = $('#swapTo').value;
    try {
      await api(`/api/reservations/${resId}/swap`, { method: 'POST', body: { to_vehicle_id: to, reason: $('#swapReason').value } });
      toast('换车成功', 'ok'); closeDrawer(); renderApprovals();
    } catch (e) {
      if (e.code === 'swap_model_required' && isSuper()) {
        if (!confirm('需要先创建"换车型"主管审批，是否创建后重试？')) return;
        await api(`/api/reservations/${resId}/approvals`, { method: 'POST', body: { type: 'swap_model', decision: 'approved', note: $('#swapReason').value } });
        await api(`/api/reservations/${resId}/swap`, { method: 'POST', body: { to_vehicle_id: to, reason: $('#swapReason').value } });
        toast('换车型审批已补建，换车成功', 'ok'); closeDrawer(); renderApprovals();
      } else toast(e.message, 'err');
    }
  };
}

// ================= 4) 出车清单 =================
async function renderDispatch() {
  const [list] = await Promise.all([api('/api/reservations')]);
  state._resCache = Object.fromEntries(list.items.map(r => [r.id, r]));
  const approved = list.items.filter(r => r.status === 'approved');
  const details = await Promise.all(approved.map(r => api(`/api/reservations/${r.id}`)));
  state._detailsMap = Object.fromEntries(details.map(d => [d.reservation.id, d]));
  const v = $('#view');
  v.innerHTML = head('出车清单', '出车前逐项核对：证件、里程、油量、四方位车身照片；低油量车辆先加油') +
    (approved.length ? approved.map(r => dispatchCardFull(r, state._detailsMap[r.id])).join('') : '<div class="empty">没有待发车的已通过预约</div>');
  bindDispatchCards(approved);
}

function shotSlot(r, phase, side, ph, disabled = false) {
  const has = !!ph;
  return `<div class="shot ${has ? 'has' : ''}">
    <div class="shot-head"><span>${SIDE_NAME[side]}</span>${has ? '✓ 已拍' : '待拍'}</div>
    <div class="shot-img">${has ? `<img src="${esc(ph.path)}?t=${Date.now()}" alt="">` : '无照片'}</div>
    <div class="shot-foot">
      ${has ? `<a class="btn sm ghost" href="${esc(ph.path)}" target="_blank">查看</a>` : ''}
      <button class="btn sm ${has ? '' : 'primary'}" data-shoot="${r.id}" data-phase="${phase}" data-side="${side}" ${disabled ? 'disabled' : ''}>
        ${has ? '重拍' : '拍摄'}</button>
    </div></div>`;
}

function dispatchCardFull(r, detail) {
  const vh = vehicle(r.vehicle_id);
  const ph = side => detail.photos.find(p => p.phase === 'out' && p.side === side);
  const shotCount = SIDES.filter(s => ph(s)).length;
  const lowFuel = vh.fuel_pct < state.meta.config.LOW_FUEL_PCT;
  const overdue = Date.now() > +new Date(r.start_at) + r.late_grace_min * 60000;
  const cust = state.meta.customers.find(c => c.code === r.customer_code);
  const licenseWarn = /X$/.test(cust?.license_no || '') ? 'bad' : 'ok';
  const ck = (ok, title, sub, cls = ok ? 'ok' : 'bad') => `
    <li><span class="ck-box ${cls}">${cls === 'ok' ? '✓' : cls === 'warn' ? '!' : '×'}</span>
      <div class="ck-body"><div class="ck-title">${title}</div><div class="ck-sub">${sub}</div></div></li>`;

  return `<div class="card">
    <div class="spread">
      <div><b class="mono">${esc(r.code)}</b> ${badge(r.status)}
        ${r.cross_day ? '<span class="damage-chip">跨日（已单独审批）</span>' : ''}
        ${overdue ? '<span class="damage-chip">已超迟到宽限</span>' : ''}</div>
      <div class="muted small">${dt(r.start_at)} – ${dt(r.end_at)} · 宽限 ${r.late_grace_min} 分钟</div>
    </div>
    <div class="grid grid-4" style="margin-top:10px">
      <div><div class="muted tiny">车辆</div><b class="mono">${esc(r.vehicle_plate)}</b><div class="muted tiny">${esc(r.model_brand)} ${esc(r.model_name)}</div></div>
      <div><div class="muted tiny">顾问 / 随车</div><b>${esc(r.advisor_name)}</b><div class="muted tiny">${esc(r.companion || '无随车人员')}</div></div>
      <div><div class="muted tiny">客户代号</div><b class="mono">${esc(r.customer_code)}</b><div class="muted tiny">${esc(cust?.license_no || '')}</div></div>
      <div><div class="muted tiny">路线</div><b>${esc(r.route_name || '未指定')}</b><div class="muted tiny">${r.route_minutes ? `计划 ${r.route_minutes} 分钟` : ''}</div></div>
    </div>
    <div class="sep"></div>
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <ul class="checklist">
        ${ck(licenseWarn === 'ok',
          `证件核验：${licenseWarn === 'ok' ? '驾照号格式正常，发车时适配器实时核验' : '驾照尾号 X：适配器将判定无效'}`,
          '由模拟驾照适配器在发车瞬间调用；无效则禁止发车', licenseWarn)}
        ${ck(true, `出车里程 <span class="mono" style="font-size:15px">${vh.mileage.toLocaleString()} km</span>`,
          '来自车机/台账；回店里程不得小于该值（里程连续性）', 'ok')}
        ${ck(!lowFuel, `油量 <span class="mono" style="font-size:15px">${vh.fuel_pct}%</span>${lowFuel ? ' · 低于阈值 ' + state.meta.config.LOW_FUEL_PCT + '%' : ''}`,
          lowFuel ? '低油量拦截：请先登记加油' : '满足出车油量要求', lowFuel ? 'bad' : 'ok')}
        ${ck(shotCount === 4, `四方位车身照片 ${shotCount}/4`, '沿车头/车尾/左/右固定位置拍摄，回车时同方位对比', shotCount === 4 ? 'ok' : 'warn')}
      </ul>
      <div>
        <div class="section-title">四方位照片（出车）</div>
        <div class="shot-grid" style="grid-template-columns:repeat(2,1fr)">
          ${SIDES.map(s => shotSlot(r, 'out', s, ph(s))).join('')}
        </div>
      </div>
    </div>
    <div class="sep"></div>
    <div class="spread">
      <div>${lowFuel ? `<button class="btn" data-refuel="${r.vehicle_id}">⛽ 先加油</button>` : ''}
        <button class="btn" data-open="${r.id}">预约详情</button></div>
      <button class="btn primary" data-go="${r.id}" ${r.advisor_id !== state.actorId && !isSuper() ? 'disabled title="只能由锁定顾问本人或主管发车"' : ''}>
        🔑 确认出车（实时核验驾照 + 锁定发车）</button>
    </div>
  </div>`;
}

function bindDispatchCards(approved) {
  $$('[data-shoot]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { await captureShot(b.dataset.shoot, 'out', b.dataset.side, false);
      toast(`${SIDE_NAME[b.dataset.side]} 照片已拍摄`, 'ok'); renderDispatch();
    } catch (e) { toast(e.message, 'err'); b.disabled = false; }
  });
  $$('[data-refuel]').forEach(b => b.onclick = async () => {
    const val = Number(prompt('加油后油量百分比（0-100）：', '90'));
    if (!val) return;
    try { await api(`/api/vehicles/${b.dataset.refuel}/refuel`, { method: 'POST', body: { fuel_pct: val } });
      toast('加油完成', 'ok'); renderDispatch();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-open]').forEach(b => b.onclick = () => openReservation(b.dataset.open));
  $$('[data-go]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try {
      await api(`/api/reservations/${b.dataset.go}/dispatch`, { method: 'POST' });
      toast('已发车，路线计时开始', 'ok'); location.hash = '#/route';
    } catch (e) {
      const map = {
        license_invalid: '证件无效，已拦截发车', low_fuel: '低油量，请先加油',
        photos_missing: '四方位照片不齐', too_late: '迟到超过宽限，请改约',
        vehicle_abnormal: '车辆车况异常，禁止放行', double_dispatch_vehicle: '车辆已存在未结束出车单（并发只接受一次）',
        double_dispatch_advisor: '该顾问已有一台车在外',
      };
      toast((map[e.code] || '发车失败') + `：${e.message}`, 'err');
      renderDispatch();
    }
  });
}

// ================= 5) 路线计时 =================
async function renderRoute() {
  const open = await api('/api/open-dispatches');
  const v = $('#view');
  v.innerHTML = head('路线计时', '发车即开始计时；超出计划时间回店需主管确认并生成超时审批') +
    (open.items.length ? open.items.map(d => {
      const over = Date.now() > +new Date(d.route_due_at);
      return `<div class="card timer-card">
        <div>
          <b class="mono">${esc(d.plate)}</b>
          <div class="muted small">${esc(d.customer_code)} · 顾问 ${esc(d.advisor_name)}${d.companion ? ' · ' + esc(d.companion) : ''}</div>
          <div class="muted tiny">${esc(d.route_name || '未指定路线')} · 出车 ${dt(d.dispatched_at)}</div>
        </div>
        <div class="js-elapsed" data-started="${+new Date(d.route_started_at)}" data-due="${+new Date(d.route_due_at)}">
          <div class="muted tiny">已用时间</div>
          <div class="timer-time"><span class="e-val mono">00:00</span></div>
        </div>
        <div>
          <div class="muted tiny">计划 ${d.planned_minutes} 分钟，应于 ${hm(d.route_due_at)} 返回</div>
          <div class="timer-time ${over ? 'over' : ''}" style="font-size:16px">
            ${over ? '<span class="e-over" style="color:var(--danger)"></span>' : '<span class="muted small">计时中</span>'}
          </div>
        </div>
        <div class="row" style="justify-content:flex-end">
          <button class="btn" data-open="${d.reservation_id}">详情</button>
          <button class="btn primary" data-return="${d.reservation_id}">回店登记</button>
        </div>
      </div>`;
    }).join('') : '<div class="empty">当前没有在外试驾车辆</div>');
  $$('[data-return]').forEach(b => b.onclick = () => { state.selectedRes = b.dataset.return; location.hash = '#/return'; });
  $$('[data-open]').forEach(b => b.onclick = () => openReservation(b.dataset.open));
}

// ================= 6) 回车对照 =================
async function renderReturnView() {
  const [list] = await Promise.all([api('/api/reservations')]);
  state._resCache = Object.fromEntries(list.items.map(r => [r.id, r]));
  const out = list.items.filter(r => r.status === 'dispatched');
  const v = $('#view');
  if (!out.length) {
    v.innerHTML = head('回车对照', '固定四方位新旧照片拖动对比；补录结束里程与新损伤') +
      '<div class="empty">没有试驾中待回店的车辆</div>';
    return;
  }
  if (!state.selectedRes || !out.some(r => r.id === state.selectedRes)) state.selectedRes = out[0].id;
  v.innerHTML = head('回车对照', '沿车头/车尾/左/右固定位置拍摄，拖动分隔线对比新旧照片') + `
    <div class="card">
      <div class="row">
        <label style="margin:0">选择回店车辆</label>
        <select id="retSelect" style="max-width:340px">
          ${out.map(r => `<option value="${r.id}" ${r.id === state.selectedRes ? 'selected' : ''}>${esc(r.code)} · ${esc(r.vehicle_plate)} · ${esc(r.advisor_name)}</option>`).join('')}
        </select>
      </div>
    </div><div id="retBody"></div>`;
  $('#retSelect').onchange = e => { state.selectedRes = e.target.value; renderReturnBody(); };
  renderReturnBody();
}

async function renderReturnBody() {
  const id = state.selectedRes;
  const detail = await api(`/api/reservations/${id}`);
  const r = detail.reservation, d = detail.dispatch;
  const vh = vehicle(r.vehicle_id);
  const over = d.route_due_at && Date.now() > +new Date(d.route_due_at);
  const outPh = s => detail.photos.find(p => p.phase === 'out' && p.side === s);
  const retPh = s => detail.photos.find(p => p.phase === 'return' && p.side === s);
  const guess = d.out_mileage + Math.round((r.route_minutes ? Math.max(1, (Date.now() - new Date(d.route_started_at)) / 60000) : 20) * 0.4);

  $('#retBody').innerHTML = `
    <div class="card">
      <div class="spread">
        <div><b class="mono">${esc(r.code)}</b> · <b class="mono">${esc(vh.plate)}</b> · ${esc(r.advisor_name)}
          ${over ? '<span class="damage-chip" style="margin-left:8px">路线超时，回车提交需主管</span>' : ''}</div>
        <div class="muted small">出车 ${dt(d.dispatched_at)}</div>
      </div>
      <div class="grid grid-3" style="margin-top:12px">
        <div><div class="muted tiny">出车里程</div><div class="readout mono">${d.out_mileage.toLocaleString()}<small>km</small></div></div>
        <div><div class="muted tiny">出车油量</div><div class="readout mono">${d.out_fuel}<small>%</small></div></div>
        <div><div class="muted tiny">里程增量（实时）</div><div class="readout mono" id="mileDelta">—</div></div>
      </div>
      <div class="sep"></div>
      <div class="grid grid-3">
        <div><label>结束里程 km（≥ 出车里程，保证连续）</label>
          <input class="mono" type="number" id="endMileage" value="${guess}" min="${d.out_mileage}"></div>
        <div><label>回店油量 %</label><input class="mono" type="number" id="endFuel" value="${Math.max(0, d.out_fuel - 8)}" min="0" max="100"></div>
        <div><label>事故/损伤等级（如有新损伤）</label>
          <select id="severity"><option value="minor">轻微（钣金/漆面）</option><option value="major">重大（安全部件/人伤）</option></select></div>
      </div>
      <div style="margin-top:10px"><label>回店备注</label>
        <input id="retNote" placeholder="如：后排有零食碎屑，车身未见新伤"></div>
      <div style="margin-top:10px"><label>新损伤说明（勾选下方方位后填写）</label>
        <textarea id="damageNote" rows="2" placeholder="如：左后门点状凹陷，客户承认地库剐蹭"></textarea></div>
    </div>
    <div class="card">
      <h3>四方位新旧照片对照 <span class="hint">拖动蓝色分隔线对比；右侧"标记新损伤"会生成事故复核单并锁车</span></h3>
      <div class="shot-grid" id="retShots">
        ${SIDES.map(s => returnShot(r, s, outPh(s), retPh(s))).join('')}
      </div>
    </div>
    <div class="card spread">
      <div class="muted small">提交后自动进入：违章留观（默认 ${Math.round(state.meta.config.WATCH_MIN / 1440)} 天）+ 清洁待完成；两项全部结束车辆才恢复可约</div>
      <button class="btn primary" id="finishReturn">✅ 完成回店登记</button>
    </div>`;

  $('#endMileage').oninput = updateDelta;
  function updateDelta() {
    const end = Number($('#endMileage').value);
    const delta = end - d.out_mileage;
    const el = $('#mileDelta');
    el.innerHTML = `${delta >= 0 ? '+' : ''}${delta} km`;
    el.style.color = delta < 0 ? 'var(--danger)' : '';
  }
  updateDelta();

  $$('.js-drag').forEach(initCompare);
  $$('[data-ret-shoot]').forEach(b => b.onclick = async () => {
    const side = b.dataset.retShoot;
    const damaged = $(`[data-dmg="${side}"]`).checked;
    b.disabled = true;
    try { await captureShot(id, 'return', side, damaged);
      toast(`${SIDE_NAME[side]} 回店照片已拍摄${damaged ? '（已标注新损伤）' : ''}`, damaged ? 'err' : 'ok');
      renderReturnBody();
    } catch (e) { toast(e.message, 'err'); b.disabled = false; }
  });

  $('#finishReturn').onclick = async () => {
    const damageSides = SIDES.filter(s => $(`[data-dmg="${s}"]`)?.checked);
    if (damageSides.length && !$('#damageNote').value)
      return toast('勾选了新损伤方位，必须填写损伤说明', 'err');
    try {
      await api(`/api/reservations/${id}/return`, { method: 'POST', body: {
        end_mileage: Number($('#endMileage').value), end_fuel: Number($('#endFuel').value),
        damage_sides: damageSides, damage_note: $('#damageNote').value,
        severity: $('#severity').value, note: $('#retNote').value,
      } });
      toast('回店登记完成：已进入违章留观与清洁流程', 'ok');
      state.selectedRes = null; location.hash = '#/watch';
    } catch (e) {
      const map = { mileage_gap: '里程不连续', photos_missing: '回店照片不齐', bad_fuel: '油量数据非法' };
      toast((map[e.code] || '回店失败') + `：${e.message}`, 'err');
    }
  };
}

function returnShot(r, side, out, ret) {
  const compare = (out && ret) ? `
    <div class="compare js-drag" style="--pos:50%">
      <img class="bottom" src="${esc(out.path)}?t=${Date.now()}" alt="出车">
      <img class="top" src="${esc(ret.path)}?t=${Date.now()}" alt="回店">
      <span class="tag old">出车</span><span class="tag new">回店</span>
      <div class="divider"></div>
    </div>` : `<div class="shot-img">
        <div style="text-align:center">
          ${out ? '<div class="muted tiny" style="margin-bottom:4px">出车照片已有，待拍回店</div><img style="max-height:90px" src="' + esc(out.path) + '">' : '缺少出车照片'}
        </div></div>`;
  return `<div class="shot ${ret ? 'has' : ''}">
    <div class="shot-head"><span>${SIDE_NAME[side]}</span>${ret ? '✓ 已对照' : '待回店拍摄'}</div>
    ${compare}
    <div class="shot-foot" style="justify-content:space-between">
      <label class="tiny" style="display:flex;align-items:center;gap:4px;margin:0;color:var(--danger)">
        <input type="checkbox" style="width:auto" data-dmg="${side}"> 标记新损伤</label>
      <button class="btn sm ${ret ? '' : 'primary'}" data-ret-shoot="${side}">${ret ? '重拍' : '拍摄回店'}</button>
    </div></div>`;
}

function initCompare(el) {
  const move = clientX => {
    const rect = el.getBoundingClientRect();
    const pct = Math.max(2, Math.min(98, (clientX - rect.left) / rect.width * 100));
    el.style.setProperty('--pos', pct + '%');
  };
  let dragging = false;
  el.addEventListener('pointerdown', e => { dragging = true; el.setPointerCapture(e.pointerId); move(e.clientX); });
  el.addEventListener('pointermove', e => dragging && move(e.clientX));
  el.addEventListener('pointerup', () => { dragging = false; });
}

// ================= 7) 违章留观 =================
async function renderWatch() {
  const data = await api('/api/watches');
  const v = $('#view');
  v.innerHTML = head('违章留观', '留观期满系统自动结束；留观结束且清洁完成，车辆才可再次预约') + `
    <div class="card">
      ${data.items.length ? `<table><thead><tr>
        <th>预约号</th><th>车辆</th><th>客户</th><th>留观期</th><th>留观状态</th><th>清洁</th><th style="text-align:right">操作</th>
      </tr></thead><tbody>
        ${data.items.map(w => `<tr>
          <td class="mono">${esc(w.customer_code)}<br><span class="muted tiny">${esc(w.reservation_id.slice(-6))}</span></td>
          <td><b class="mono">${esc(w.plate)}</b></td>
          <td class="mono">${esc(w.customer_code)}</td>
          <td class="small">${dt(w.starts_at)}<br><span class="muted tiny">至 ${dt(w.ends_at)}</span>
            ${w.status === 'observing' ? `<div class="countdown js-countdown tiny" data-ends="${+new Date(w.ends_at)}"></div>` : ''}</td>
          <td>${badge(w.status, w.status === 'observing' ? '留观中' : w.status === 'cleared' ? '未发现违章' : '发现违章')}
            ${w.result_note ? `<div class="muted tiny">${esc(w.result_note)}</div>` : ''}</td>
          <td>${w.cleaning_status === 'done'
            ? badge('completed', '清洁完成')
            : badge('watching', '待清洁')}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn sm" data-open="${w.reservation_id}">详情</button>
            ${w.status === 'observing' ? `
              <button class="btn sm" data-watch-ok="${w.id}" ${isSuper() ? '' : 'disabled title="仅主管可提前结束留观"'}>无违章结束</button>
              <button class="btn sm danger" data-watch-bad="${w.id}" ${isSuper() ? '' : 'disabled title="仅主管"'}>登记违章</button>` : ''}
          </td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">当前没有留观记录</div>'}
    </div>
    <div class="card">
      <h3>完成清洁 <span class="hint">留观 + 清洁双条件满足后，车辆自动恢复"可预约"；若有未结事故仍保持锁定</span></h3>
      <div id="cleanActions"></div>
    </div>`;
  // 清洁按钮区
  $('#cleanActions').innerHTML = data.items.filter(w => w.status !== 'violation_found').map(w => `
    <div class="spread" style="padding:8px 0;border-bottom:1px dashed var(--pearl-2)">
      <span><b class="mono">${esc(w.plate)}</b> <span class="muted small">（${esc(w.customer_code)}）</span></span>
      <button class="btn sm ${w.cleaning_status === 'done' ? '' : 'primary'}" data-clean="${w.reservation_id}" ${w.cleaning_status === 'done' ? 'disabled' : ''}>
        ${w.cleaning_status === 'done' ? '✓ 清洁已完成' : '标记清洁完成'}</button>
    </div>`).join('') || '<div class="empty">暂无待清洁车辆</div>';

  $$('[data-open]').forEach(b => b.onclick = () => openReservation(b.dataset.open));
  $$('[data-watch-ok]').forEach(b => b.onclick = async () => {
    try { await api(`/api/watches/${b.dataset.watchOk}/resolve`, { method: 'POST', body: { status: 'cleared' } });
      toast('留观结束：未发现违章', 'ok'); renderWatch();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-watch-bad]').forEach(b => b.onclick = async () => {
    const note = prompt('违章情况：', '查询到一次闯红灯记录，转客户处理');
    if (!note) return;
    try { await api(`/api/watches/${b.dataset.watchBad}/resolve`, { method: 'POST', body: { status: 'violation_found', note } });
      toast('已登记违章', ''); renderWatch();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-clean]').forEach(b => b.onclick = async () => {
    try { await api(`/api/reservations/${b.dataset.clean}/cleaning`, { method: 'POST' });
      toast('清洁完成；若留观也已结束，车辆已恢复可约', 'ok'); renderWatch();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ================= 8) 事故复核 =================
async function renderIncidents() {
  const data = await api('/api/incidents');
  const v = $('#view');
  v.innerHTML = head('事故复核', '事故/故障结论由主管确认；普通销售不能清除车况异常',
    '<button class="btn primary" id="newIncBtn">＋ 事故/故障报备</button>') + `
    <div class="card">
      ${data.items.length ? `<table><thead><tr>
        <th>编号</th><th>车辆</th><th>类型/等级</th><th>描述</th><th>报备人</th><th>状态/结论</th><th style="text-align:right">操作</th>
      </tr></thead><tbody>
        ${data.items.map(x => `<tr>
          <td class="mono">${esc(x.code)}<br><span class="muted tiny">${dt(x.created_at)}</span></td>
          <td><b class="mono">${esc(x.plate)}</b><br><span class="muted tiny">${esc(x.customer_code || '')}</span></td>
          <td>${badge(x.severity, x.severity === 'major' ? '重大' : '轻微')}</td>
          <td style="max-width:320px">${esc(x.description)}
            ${x.conclusion ? `<div class="tiny" style="color:var(--warn);margin-top:3px">主管结论：${esc(x.conclusion)}</div>` : ''}</td>
          <td>${esc(x.reporter_name || '')}</td>
          <td>${badge(x.status, { reported: '待主管确认', confirmed: '已确认待整改', cleared: '已关闭' }[x.status])}
            ${x.confirmer_name ? `<div class="muted tiny">${esc(x.confirmer_name)} · ${dt(x.confirmed_at)}</div>` : ''}</td>
          <td style="text-align:right;white-space:nowrap">
            ${x.status === 'reported' ? `<button class="btn sm primary" data-confirm="${x.id}" ${isSuper() ? '' : 'disabled title="仅主管可确认"'}>主管确认</button>` : ''}
            ${x.status !== 'cleared' ? `<button class="btn sm" data-clear="${x.id}" ${isSuper() ? '' : 'disabled title="普通销售不能清除车况异常"'}>清除异常</button>` : ''}
          </td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">暂无事故/故障记录</div>'}
      ${!isSuper() ? '<div class="tiny" style="color:var(--graphite-3);margin-top:8px">⚠ 当前为销售顾问身份：确认与清除按钮已禁用，请切换主管 邵澜 操作。</div>' : ''}
    </div>`;
  $('#newIncBtn').onclick = openNewIncident;
  $$('[data-confirm]').forEach(b => b.onclick = async () => {
    const conclusion = prompt('主管事故结论：', '情况属实，按流程定责并安排维修');
    if (!conclusion) return;
    try { await api(`/api/incidents/${b.dataset.confirm}/confirm`, { method: 'POST', body: { conclusion } });
      toast('事故结论已确认', 'ok'); renderIncidents();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-clear]').forEach(b => b.onclick = async () => {
    const note = prompt('清除车况异常的依据（如：维修复检合格）：', '维修完成并复检合格，恢复运营');
    if (!note) return;
    try { await api(`/api/incidents/${b.dataset.clear}/clear`, { method: 'POST', body: { note } });
      toast('车况异常已清除，车辆状态已重算', 'ok'); renderIncidents();
    } catch (e) { toast(e.message, 'err'); }
  });
}

function openNewIncident() {
  openDrawer(`
    <h2>事故 / 车辆故障报备</h2>
    <div class="muted small">报备后车辆立即锁定，任何顾问无法为其安排预约或发车</div>
    <div class="card" style="margin-top:12px"><div class="grid grid-2">
      <div><label>类型</label><select id="iKind">
        <option value="accident">事故报备</option><option value="fault">车辆故障</option></select></div>
      <div><label>严重程度</label><select id="iSev">
        <option value="minor">轻微</option><option value="major">重大</option></select></div>
      <div style="grid-column:1/-1"><label>车辆 *</label>
        <select id="iVehicle">${state.meta._vehicles.map(v =>
          `<option value="${v.id}">${esc(v.plate)} · ${esc(v.brand)} ${esc(v.model_name)}</option>`).join('')}</select></div>
      <div style="grid-column:1/-1"><label>情况描述 *</label>
        <textarea id="iDesc" rows="3" placeholder="时间、地点、经过、初步损伤"></textarea></div>
    </div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="iSubmit">提交报备并锁车</button></div></div>`);
  $('#iSubmit').onclick = async () => {
    if (!$('#iDesc').value.trim()) return toast('请填写情况描述', 'err');
    try {
      await api('/api/incidents', { method: 'POST', body: {
        vehicle_id: $('#iVehicle').value, kind: $('#iKind').value,
        severity: $('#iSev').value, description: $('#iDesc').value,
      } });
      toast('已报备，车辆已锁定，等待主管复核', 'ok'); closeDrawer(); renderIncidents();
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ---------------- 预约详情抽屉 ----------------
async function openReservation(id) {
  const detail = await api(`/api/reservations/${id}`);
  const r = detail.reservation;
  const vh = vehicle(r.vehicle_id);
  const d = detail.dispatch, w = detail.watch, c = detail.cleaning;
  const tl = [];
  tl.push([r.created_at, `预约创建（${r.created_by === staffName(r.created_by) ? staffName(r.created_by) : staffName(r.created_by)}）`]);
  if (r.decided_at) tl.push([r.decided_at, `审核${r.status === 'rejected' ? '驳回' : '通过'}`]);
  if (d) {
    tl.push([d.dispatched_at, `出车：里程 ${d.out_mileage.toLocaleString()} km / 油量 ${d.out_fuel}% / 驾照核验${d.license_valid ? '通过' : '未过'}`]);
    if (d.returned_at) tl.push([d.returned_at, `回店：里程 ${d.end_mileage?.toLocaleString()} km / 油量 ${d.end_fuel}%${d.overtime_minutes ? ` / 路线超时 ${d.overtime_minutes} 分钟` : ''}`]);
  }
  if (w) tl.push([w.starts_at, `违章留观开始，至 ${dt(w.ends_at)}`]);
  if (c?.done_at) tl.push([c.done_at, '清洁完成']);
  tl.sort((a, b) => new Date(a[0]) - new Date(b[0]));

  const shots = phase => SIDES.map(s => detail.photos.find(p => p.phase === phase && p.side === s)).filter(Boolean);

  openDrawer(`
    <h2>${esc(r.code)} ${badge(r.status)}</h2>
    <div class="muted small">${esc(r.model_brand)} ${esc(r.model_name)} · ${esc(r.vehicle_plate || '未派车')} · ${dt(r.start_at)} – ${dt(r.end_at)}
      ${r.cross_day ? '<br><span class="damage-chip">跨日试驾（须单独审批）</span>' : ''}</div>
    <div class="card" style="margin-top:12px">
      <dl class="kv">
        <dt>客户代号</dt><dd class="mono">${esc(r.customer_code)}（${esc(r.license_no || '')}）</dd>
        <dt>销售顾问</dt><dd>${esc(r.advisor_name)}</dd>
        <dt>随车人员</dt><dd>${esc(r.companion || '无')}</dd>
        <dt>路线</dt><dd>${esc(r.route_name || '未指定')}${r.route_minutes ? `（计划 ${r.route_minutes} 分钟）` : ''}</dd>
        <dt>备注</dt><dd>${esc(r.note || '无')}</dd>
        ${r.reject_reason ? `<dt>驳回原因</dt><dd style="color:var(--danger)">${esc(r.reject_reason)}</dd>` : ''}
      </dl>
    </div>
    ${detail.approvals.length ? `<div class="card"><h3>单独审批记录</h3>${detail.approvals.map(a => `
      <div class="spread small" style="padding:5px 0">
        <span>${{ cross_day: '跨日试驾', swap_model: '更换车型', route_overtime: '路线超时' }[a.type]} · ${a.decision === 'approved' ? '同意' : '拒绝'}</span>
        <span class="muted tiny">${staffName(a.approver_id)} · ${dt(a.created_at)}</span></div>
      ${a.note ? `<div class="muted tiny">${esc(a.note)}</div>` : ''}`).join('')}</div>` : ''}
    ${detail.swaps.length ? `<div class="card"><h3>换车记录</h3>${detail.swaps.map(s => `
      <div class="small">${dt(s.created_at)}：<span class="mono">${esc(vehicle(s.from_vehicle_id)?.plate || '未派车')}</span>
        → <span class="mono">${esc(vehicle(s.to_vehicle_id)?.plate)}</span>
        ${s.changed_model ? '<span class="damage-chip">换车型</span>' : '<span class="badge b-booked">同车型</span>'}</div>`).join('')}</div>` : ''}
    ${d ? `<div class="card"><h3>交接数据</h3>
      <div class="grid grid-3">
        <div><div class="muted tiny">出车里程</div><div class="readout mono" style="font-size:18px">${d.out_mileage.toLocaleString()}</div></div>
        <div><div class="muted tiny">回车里程</div><div class="readout mono" style="font-size:18px">${d.end_mileage ? d.end_mileage.toLocaleString() : '—'}</div></div>
        <div><div class="muted tiny">里程增量</div><div class="readout mono" style="font-size:18px">${d.end_mileage ? '+' + (d.end_mileage - d.out_mileage) + ' km' : '—'}</div></div>
        <div><div class="muted tiny">出车油量</div><div class="mono">${d.out_fuel}%</div></div>
        <div><div class="muted tiny">回车油量</div><div class="mono">${d.end_fuel ?? '—'}%</div></div>
        <div><div class="muted tiny">超时</div><div class="${d.overtime_minutes ? 'diff-add' : ''} mono">${d.overtime_minutes ? d.overtime_minutes + ' 分钟' : '无'}</div></div>
      </div>
      ${d.new_damage ? `<div style="margin-top:8px;color:var(--danger)" class="small">新损伤方位：${esc(d.new_damage)}</div>` : ''}
      ${d.return_note ? `<div class="muted small" style="margin-top:6px">${esc(d.return_note)}</div>` : ''}
      <div class="sep"></div>
      <div class="muted tiny">驾照：${esc(d.license_result || '')}</div>
    </div>` : ''}
    ${w || c ? `<div class="card"><h3>留观与清洁</h3>
      <div class="row">
        ${w ? badge(w.status, { observing: '违章留观中', cleared: '留观结束·无违章', violation_found: '发现违章' }[w.status]) : ''}
        ${c ? (c.status === 'done' ? badge('completed', '清洁完成') : badge('watching', '待清洁')) : ''}
      </div>
      ${w?.ends_at ? `<div class="muted tiny" style="margin-top:6px">留观至 ${dt(w.ends_at)}${w.ended_by ? ` · 结束人：${w.ended_by === 'system' ? '系统定时任务' : staffName(w.ended_by)}` : ''}</div>` : ''}
    </div>` : ''}
    ${detail.incidents.length ? `<div class="card"><h3>事故复核</h3>${detail.incidents.map(x => `
      <div class="small" style="padding:4px 0">${badge(x.status, { reported: '待确认', confirmed: '已确认', cleared: '已关闭' }[x.status])}
        <b class="mono">${esc(x.code)}</b> · ${esc(x.description)}</div>`).join('')}</div>` : ''}
    ${detail.payments.length ? `<div class="card"><h3>模拟付款</h3>${detail.payments.map(p => `
      <div class="small">${dt(p.created_at)} · ¥${(p.amount / 100).toFixed(0)} 押金 ·
        ${p.status === 'success' ? '<span style="color:var(--ok)">成功</span>' : '<span style="color:var(--danger)">失败</span>'}
        <span class="mono muted tiny">${esc(p.provider_ref || p.raw || '')}</span></div>`).join('')}</div>` : ''}
    <div class="card"><h3>流程时间线</h3><ul class="timeline">
      ${tl.map(([time, txt]) => `<li><div class="t-time">${dt(time)}</div><div class="t-txt">${esc(txt)}</div></li>`).join('')}
    </ul></div>
    ${shots('out').length ? `<div class="card"><h3>出车照片</h3><div class="shot-grid" style="grid-template-columns:repeat(2,1fr)">
      ${shots('out').map(p => `<div class="shot has"><div class="shot-head"><span>${SIDE_NAME[p.side]}</span></div><div class="shot-img"><img src="${esc(p.path)}"></div></div>`).join('')}
    </div></div>` : ''}`);
}

// ---------------- 抽屉 ----------------
function openDrawer(html) {
  closeDrawer();
  const mask = document.createElement('div');
  mask.className = 'drawer-mask'; mask.id = 'drawerMask'; mask.onclick = closeDrawer;
  const drawer = document.createElement('aside');
  drawer.className = 'drawer'; drawer.id = 'drawer'; drawer.innerHTML =
    `<div style="text-align:right;margin-bottom:8px"><button class="btn sm" id="drawerClose">关闭 ✕</button></div>${html}`;
  document.body.append(mask, drawer);
  $('#drawerClose').onclick = closeDrawer;
}
function closeDrawer() { $('#drawerMask')?.remove(); $('#drawer')?.remove(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

boot().catch(e => { $('#view').innerHTML = `<div class="card" style="color:var(--danger)">启动失败：${esc(e.message)}</div>`; console.error(e); });
