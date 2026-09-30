/* 试驾车预约与车况交接平台 —— 前端逻辑（无框架） */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  staffId: localStorage.getItem('td_staff') || '',
  meta: { staff: [], models: [], routes: [] },
  calDate: new Date().toISOString().slice(0, 10),
  board: [],
};

const STATUS_LABEL = {
  pending: '待审核', approved: '已通过·待发车', dispatched: '试驾中', returned: '已回店·待对照',
  exception: '异常待主管复核', checked: '回车对照完成', rejected: '已驳回',
  released: '已释放（迟到/取消）', cancelled: '已取消',
};
const STATUS_BADGE = {
  pending: 'badge', approved: 'badge warn', dispatched: 'badge blue', returned: 'badge',
  exception: 'badge red', checked: 'badge green', rejected: 'badge gray', released: 'badge gray', cancelled: 'badge gray',
};
const VEH_STATUS = {
  available: ['可预约', 'green'], reserved: ['已锁定', 'warn'], out: ['试驾中', 'blue'],
  checking: ['回车检查', ''], observation: ['违章留观', ''], cleaning: ['待清洁', 'gray'], blocked: ['异常封锁', 'red'],
};
const POSITION_LABEL = { front: '车头', rear: '车尾', left: '车身左侧', right: '车身右侧', extra: '附加' };

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.staffId) headers['X-Staff-Id'] = state.staffId;
  if (opts.body && !(opts.body instanceof ArrayBuffer) && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

const fmtTs = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
const fmtDay = (ts) => ts ? new Date(ts).toLocaleDateString('zh-CN') : '—';
const odoFmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const isSuperNow = () => state.meta.staff.find((s) => s.id === state.staffId)?.role === 'supervisor';

function switchView(name) {
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  ({
    board: loadBoard, calendar: loadCalendar, approvals: loadApprovals,
    reservations: loadReservations, ops: loadOps,
  })[name]?.();
}

// ---------------- 车辆状态板 ----------------
async function loadBoard() {
  state.board = await api('/api/board');
  const wrap = $('#boardWrap');
  wrap.innerHTML = '';
  for (const m of state.board) {
    const g = document.createElement('div');
    g.className = 'model-group';
    g.innerHTML = `
      <div class="model-head">
        <span class="cat">${m.category}</span>
        <span class="name">${m.name}</span>
        <span class="meta">${m.code} · ${m.color_name || ''} · 低油阈值 ${m.low_fuel_threshold_pct}% · 路线上限 ${m.max_route_minutes} 分钟 · 押金 ¥${m.deposit_cny}</span>
      </div>
      <div class="vehicle-row"></div>`;
    const row = g.querySelector('.vehicle-row');
    for (const v of m.vehicles) {
      const [label, badgeCls] = VEH_STATUS[v.status] || [v.status, 'gray'];
      const chip = document.createElement('div');
      chip.className = `vehicle-chip s-${v.status}`;
      const lowFuel = v.last_fuel_pct < m.low_fuel_threshold_pct;
      chip.innerHTML = `
        <div class="vc-top">
          <span class="vc-name">${v.name}</span>
          <span class="badge ${badgeCls}">${label}</span>
        </div>
        <div class="vc-plate">${v.plate}</div>
        <div class="vc-odo">ODO <span>${odoFmt(v.last_odometer_km)}</span> km · 油量
          <span class="${lowFuel ? 'danger-text' : ''}${v.last_fuel_pct < 0 ? '' : ''}">${Math.round(v.last_fuel_pct)}%</span>
          ${lowFuel ? ' <span class="badge red">低油</span>' : ''}
          ${v.condition_flag !== 'none' ? `<span class="badge red">${v.condition_flag === 'mechanical' ? '故障' : '损伤'}</span>` : ''}
        </div>`;
      chip.onclick = () => openVehicleDrawer(v);
      row.appendChild(chip);
    }
    wrap.appendChild(g);
  }
}

// ---------------- 车型日历 ----------------
function calPct(ts, dayStart) {
  const START_H = 8, SPAN_H = 12; // 08:00 - 20:00
  return Math.max(0, Math.min(100, ((ts - dayStart) / 3600000 - START_H) / SPAN_H * 100));
}

async function loadCalendar() {
  const data = await api(`/api/calendar?date=${state.calDate}`);
  const dayStart = new Date(`${state.calDate}T00:00:00`).getTime();
  const HOURS = [];
  for (let h = 8; h < 20; h++) HOURS.push(h);

  // 冲突计算：待审单的车辆是否与已有效单重叠；顾问同理
  const active = data.reservations.filter((r) => ['approved', 'dispatched', 'returned', 'exception', 'checked'].includes(r.status));
  const conflictsWith = (r) => active.some((a) =>
    (a.vehicle_id && a.vehicle_id === r.vehicle_id || a.advisor_id && r.advisor_id && a.advisor_id === r.advisor_id) &&
    r.start_ts < a.end_ts && a.start_ts < r.end_ts);

  const blockEl = (r, kind) => {
    const left = calPct(r.start_ts, dayStart);
    const width = Math.max(2.2, calPct(r.end_ts, dayStart) - left);
    const conflict = r.status === 'pending' && conflictsWith(r);
    const b = document.createElement('div');
    b.className = `cal-block ${kind}${conflict ? ' conflict' : ''}`;
    b.style.left = left + '%';
    b.style.width = width + '%';
    const who = kind === 'vehicle-lane'
      ? `${r.customer_code}${r.advisor_name ? ' · ' + r.advisor_name : ''}`
      : `${r.customer_code} · ${r.vehicle_plate || '未派车'}`;
    const s = new Date(r.start_ts); const e = new Date(r.end_ts);
    const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    b.textContent = `${r.code} ${hm(s)}-${hm(e)} ${who}${r.status === 'pending' ? '（待审）' : ''}`;
    b.title = `${r.code} ${STATUS_LABEL[r.status]}${conflict ? ' — 与已有预约时段冲突' : ''}`;
    b.onclick = () => openReservation(r.id);
    return b;
  };

  const lane = (label, sub, reservations, kind) => {
    const lab = document.createElement('div');
    lab.className = 'cal-cell cal-label';
    lab.innerHTML = `${label}<span class="mini">${sub || ''}</span>`;
    const track = document.createElement('div');
    track.className = 'cal-cell';
    track.style.gridColumn = '2 / -1';
    reservations.forEach((r) => track.appendChild(blockEl(r, kind)));
    return [lab, track];
  };

  const host = document.createElement('div');
  host.style.display = 'grid';
  host.style.gridTemplateColumns = '150px 1fr';
  host.style.border = '1px solid var(--line)';
  host.style.borderRadius = '10px';
  host.style.background = '#fff';
  host.style.overflow = 'hidden';

  // 时间轴表头
  const corner = document.createElement('div');
  corner.className = 'cal-cell cal-head';
  corner.textContent = state.calDate;
  const head = document.createElement('div');
  head.style.display = 'grid';
  head.style.gridTemplateColumns = `repeat(${HOURS.length},1fr)`;
  HOURS.forEach((h) => {
    const c = document.createElement('div');
    c.className = 'cal-cell cal-head';
    c.textContent = `${h}:00`;
    head.appendChild(c);
  });
  host.append(corner, head);

  // 车辆泳道（仅显示当日有用车的 + 全部车辆，便于查看空档）
  const divider = document.createElement('div');
  divider.className = 'cal-cell cal-lane-divider';
  divider.textContent = '车辆';
  const d2 = document.createElement('div');
  d2.className = 'cal-cell cal-lane-divider';
  d2.style.gridColumn = '2 / -1';
  host.append(divider, d2);

  for (const v of data.vehicles) {
    const rs = data.reservations.filter((r) => r.vehicle_id === v.id && r.end_ts > dayStart + 8 * 3600000 && r.start_ts < dayStart + 20 * 3600000);
    const [lab, track] = lane(v.name, v.plate, rs, 'vehicle-lane');
    host.append(lab, track);
  }

  const ad = document.createElement('div');
  ad.className = 'cal-cell cal-lane-divider';
  ad.textContent = '顾问';
  const ad2 = document.createElement('div');
  ad2.className = 'cal-cell cal-lane-divider';
  ad2.style.gridColumn = '2 / -1';
  host.append(ad, ad2);

  for (const a of data.advisors) {
    const rs = data.reservations.filter((r) => r.advisor_id === a.id && r.end_ts > dayStart + 8 * 3600000 && r.start_ts < dayStart + 20 * 3600000);
    const [lab, track] = lane(a.name, a.role === 'supervisor' ? '主管' : '顾问', rs, 'advisor-lane');
    host.append(lab, track);
  }

  $('#calWrap').innerHTML = '';
  $('#calWrap').appendChild(host);
}

// ---------------- 预约审核 ----------------
function fillModelSelects() {
  $('#nr-model').innerHTML = state.meta.models.map((m) => `<option value="${m.id}">${m.name}（${m.category}）</option>`).join('');
  $('#nr-route').innerHTML = '<option value="">不指定</option>' + state.meta.routes.map((r) => `<option value="${r.id}">${r.name} · ${r.planned_minutes}分钟</option>`).join('');
  syncVehicleOptions();
}
function syncVehicleOptions() {
  const mid = $('#nr-model').value;
  const vs = state.board.find((m) => m.id === mid)?.vehicles || [];
  $('#nr-vehicle').innerHTML = '<option value="">自动分配同车型可用车</option>' +
    vs.map((v) => `<option value="${v.id}">${v.name} ${v.plate}（${VEH_STATUS[v.status][0]}）</option>`).join('');
}

async function loadApprovals() {
  if (!state.board.length) state.board = await api('/api/board');
  const rows = await api('/api/reservations?view=pending');
  const t = $('#approvalTable');
  t.innerHTML = `
    <tr><th>预约号</th><th>客户代号</th><th>车型</th><th>指定车辆</th><th>时段</th><th>跨日</th><th>证件</th><th>操作</th></tr>
    ${rows.map((r) => `
      <tr class="clickable" data-id="${r.id}">
        <td class="num">${r.code}</td>
        <td>${r.customer_code}</td>
        <td>${r.model_name}</td>
        <td>${r.vehicle_id ? '已指定' : '自动派车'}</td>
        <td class="num">${fmtTs(r.start_ts)}<br>${fmtTs(r.end_ts)}</td>
        <td>${r.overnight_ok ? '<span class="badge green">已审批</span>' : (new Date(r.start_ts).toDateString() !== new Date(r.end_ts).toDateString() ? '<span class="badge red">缺审批</span>' : '—')}</td>
        <td>${licenseBadge(r)}</td>
        <td onclick="event.stopPropagation()">
          <button class="sm" data-act="approve" data-id="${r.id}">通过</button>
          <button class="sm ghost" data-act="overnight" data-id="${r.id}">跨日审批</button>
          <button class="sm gray" data-act="reject" data-id="${r.id}">驳回</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">暂无待审核预约</td></tr>'}`;
  $$('#approvalTable tr[data-id]').forEach((tr) => {
    tr.onclick = () => openReservation(tr.dataset.id);
  });
  $$('#approvalTable button').forEach((b) => b.onclick = async () => {
    const id = b.dataset.id;
    if (b.dataset.act === 'reject') {
      const reason = prompt('驳回原因：', '时段或证件不符');
      if (reason === null) return;
      await wrapApi(() => api(`/api/reservations/${id}/reject`, { method: 'POST', body: { reason } }), '已驳回');
      loadApprovals();
    } else if (b.dataset.act === 'overnight') {
      await wrapApi(async () => {
        const reason = prompt('跨日试驾审批说明：', '客户深度体验需求');
        if (reason === null) throw new Error('已取消');
        const riskNote = prompt('风控备注（停车地点/里程上限）：', '夜间指定停车场，里程上限 120km');
        if (riskNote === null) throw new Error('已取消');
        return api(`/api/reservations/${id}/overnight`, { method: 'POST', body: { reason, riskNote, depositExtraCny: 3000 } });
      }, '跨日审批已创建');
      loadApprovals();
    } else {
      openReservation(id, { approve: true });
    }
  });
}

function licenseBadge(r) {
  // 待审列表不带 license_status 时显示中性标记
  const s = r.license_status;
  if (!s) return '<span class="muted">审核时核验</span>';
  if (s === 'valid') return '<span class="badge green">有效</span>';
  return `<span class="badge red">${({ invalid: '无效', expired: '过期', underage: '未成年' })[s] || s}</span>`;
}

async function createReservation() {
  const body = {
    code: null,
    modelId: $('#nr-model').value,
    routeId: $('#nr-route').value || null,
    preferredVehicleId: $('#nr-vehicle').value || null,
    start: $('#nr-start').value,
    end: $('#nr-end').value,
    companion: $('#nr-companion').value || null,
    code2: undefined,
  };
  await wrapApi(async () => {
    const code = $('#nr-code').value.trim();
    const idNumber = $('#nr-id').value.trim();
    if (!code || !idNumber) throw new Error('请填写客户代号与证件号');
    $('#nr-verify').textContent = '驾照核验中…';
    const c = await api('/api/customers', { method: 'POST', body: { code, idNumber, name: $('#nr-name').value || null } });
    if (!c.verification.ok) {
      $('#nr-verify').innerHTML = `<span class="danger-text">核验未通过：${c.verification.reason}</span>`;
      throw new Error(`驾照核验未通过：${c.verification.reason}`);
    }
    $('#nr-verify').innerHTML = `<span class="ok-text">核验通过（安全分 ${c.verification.safetyScore}），正在建立预约…</span>`;
    return api('/api/reservations', { method: 'POST', body: { ...body, customerId: c.customerId } });
  }, '预约已建立，进入审核队列');
  loadApprovals();
}

// ---------------- 预约列表 ----------------
async function loadReservations() {
  const staff = state.meta.staff.find((s) => s.id === state.staffId);
  $('#resListTitle').textContent = staff ? `预约清单 · ${staff.name}（${staff.role === 'supervisor' ? '主管·全部可见' : '销售顾问'}）` : '预约清单';
  const rows = state.staffId ? await api('/api/reservations') : [];
  $('#resTable').innerHTML = `
    <tr><th>预约号</th><th>状态</th><th>客户</th><th>车型/车辆</th><th>顾问</th><th>时段</th><th>里程(km)</th><th></th></tr>
    ${rows.map((r) => `
      <tr class="clickable" data-id="${r.id}">
        <td class="num">${r.code}</td>
        <td><span class="${STATUS_BADGE[r.status]}">${STATUS_LABEL[r.status]}</span></td>
        <td>${r.customer_code}</td>
        <td>${r.model_name}${r.vehicle_plate ? `<br><span class="muted mono" style="font-size:11px">${r.vehicle_plate}</span>` : ''}</td>
        <td>${r.advisor_name || '<span class="muted">未锁定</span>'}</td>
        <td class="num" style="font-size:12px">${fmtTs(r.start_ts)}<br>${fmtTs(r.end_ts)}</td>
        <td class="num">${r.dispatch_odometer_km != null ? odoFmt(r.dispatch_odometer_km) : '—'} → ${r.return_odometer_km != null ? odoFmt(r.return_odometer_km) : '—'}</td>
        <td><button class="sm ghost" data-id="${r.id}">进入流程</button></td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">请先在右上角选择操作员</td></tr>'}`;
  $$('#resTable tr[data-id]').forEach((tr) => tr.onclick = () => openReservation(tr.dataset.id));
  $$('#resTable button[data-id]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); openReservation(b.dataset.id); });
}

// ---------------- 留观 / 事故 / 清洁 ----------------
async function loadOps() {
  const board = await api('/api/board');
  const obs = board.flatMap((m) => m.vehicles.map((v) => ({ ...v, model: m.name })))
    .filter((v) => ['observation', 'cleaning', 'checking', 'blocked'].includes(v.status));
  $('#obsList').innerHTML = obs.length ? obs.map((v) => `
    <div class="card" style="margin-bottom:8px;padding:10px 12px">
      <div class="row">
        <div><b>${v.name}</b> <span class="mono muted" style="font-size:11px">${v.plate}</span></div>
        <span class="${VEH_STATUS[v.status][1] ? `badge ${VEH_STATUS[v.status][1]}` : 'badge'}">${VEH_STATUS[v.status][0]}</span>
        ${v.condition_flag !== 'none' ? `<span class="badge red">${v.condition_flag === 'mechanical' ? '车辆故障' : '车况损伤'}</span>` : ''}
        <span style="flex:1"></span>
        ${v.status === 'cleaning' ? `<button class="sm" data-clean="${v.id}">完成清洁并上线</button>` : ''}
        ${v.status === 'blocked' ? (isSuperNow() ? `<button class="sm ghost" data-repair="${v.id}">维修完工·主管解除封锁</button>` : '<span class="danger-text" style="font-size:12px">须主管事故复核/维修结案</span>') : ''}
        ${v.status === 'observation' ? '<span class="muted" style="font-size:12px">等待留观到期（定时任务自动转入清洁）</span>' : ''}
      </div>
      <div class="mono muted" style="font-size:11px;margin-top:4px">ODO ${odoFmt(v.last_odometer_km)} km · 油量 ${Math.round(v.last_fuel_pct)}%${v.condition_note ? ' · ' + v.condition_note : ''}</div>
    </div>`).join('') : '<p class="muted">当前没有留观/清洁/异常车辆</p>';
  $$('#obsList [data-clean]').forEach((b) => b.onclick = async () => {
    await wrapApi(() => api(`/api/vehicles/${b.dataset.clean}/clean`, { method: 'POST' }), '清洁完成，车辆已恢复可预约');
    loadOps(); loadBoard();
  });
  $$('#obsList [data-repair]').forEach((b) => b.onclick = async () => {
    const note = prompt('维修完工说明（主管解除封锁）：', '右后门钣喷完成，复检合格');
    if (note === null) return;
    await wrapApi(() => api(`/api/vehicles/${b.dataset.repair}/resolve-repair`, { method: 'POST', body: { note } }),
      '异常已清除，车辆进入留观/清洁流程');
    loadOps(); loadBoard();
  });

  // 异常待复核预约
  const all = state.staffId ? await api('/api/reservations') : [];
  const incidents = all.filter((r) => r.status === 'exception');
  $('#incidentList').innerHTML = incidents.length ? incidents.map((r) => `
    <div class="card" style="margin-bottom:8px;padding:10px 12px">
      <div class="row">
        <b class="mono">${r.code}</b><span class="badge red">待主管复核</span><span style="flex:1"></span>
        <button class="sm" data-rev="${r.id}">进入复核</button>
      </div>
      <div class="muted" style="font-size:12px;margin-top:4px">${r.vehicle_plate} · ${fmtTs(r.incident_reported_at) || ''}<br>${r.incident_note || '回车检查发现损伤/故障'}</div>
    </div>`).join('') : '<p class="muted">没有待复核事故</p>';
  $$('#incidentList [data-rev]').forEach((b) => b.onclick = () => openReservation(b.dataset.rev));
}

// ---------------- 预约详情抽屉（核心工作流） ----------------
let timerHandle = null;
async function openReservation(id, opts = {}) {
  const r = await api(`/api/reservations/${id}`);
  const staff = state.meta.staff.find((s) => s.id === state.staffId);
  const isSuper = staff?.role === 'supervisor';
  const isOwner = staff && r.advisor_id === staff.id;

  $('#drTitle').textContent = `${r.code} · ${r.customer_code}`;
  const st = $('#drStatus');
  st.className = STATUS_BADGE[r.status];
  st.textContent = STATUS_LABEL[r.status];

  const crossDay = new Date(r.start_ts).toDateString() !== new Date(r.end_ts).toDateString();
  const body = $('#drBody');

  const km = (a, b) => (a != null && b != null ? (b - a).toFixed(1) : '—');
  body.innerHTML = `
    <div class="card">
      <div class="kv">
        <dt>车型</dt><dd>${r.model_name}（${r.model_code}）</dd>
        <dt>车辆</dt><dd>${r.vehicle_name || '未派车'} ${r.vehicle_plate ? `<span class="mono muted">${r.vehicle_plate}</span>` : ''}</dd>
        <dt>客户代号</dt><dd>${r.customer_code} · 证件状态 ${licenseBadge({ license_status: r.license_status })}</dd>
        <dt>销售顾问</dt><dd>${r.advisor_name || '<span class="muted">未锁定</span>'}</dd>
        <dt>路线</dt><dd>${r.route_name || '未指定'}</dd>
        <dt>随车人员</dt><dd>${r.companion || '—'}</dd>
        <dt>预约时段</dt><dd class="num">${fmtTs(r.start_ts)} → ${fmtTs(r.end_ts)} ${crossDay ? '<span class="badge red">跨日</span>' : ''}</dd>
        <dt>押金</dt><dd class="num">${r.deposit_txn ? `¥${r.deposit_amount_cny} 已冻结（${r.deposit_txn}）` : '未收取'}</dd>
      </div>
      ${r.overnight && r.overnight.length ? `
        <h3 style="margin-top:10px">跨日审批</h3>
        ${r.overnight.map((o) => `<div class="kv">
          <dt>${o.status === 'approved' ? '已批准' : '已撤销'}</dt>
          <dd>${fmtTs(o.created_at)} · 追加押金 ¥${o.deposit_extra_cny}<br><span class="muted">${o.reason || ''}<br>${o.risk_note || ''}</span></dd>
        </div>`).join('')}` : ''}
    </div>

    <div id="actionZone"></div>

    <div class="card">
      <h3>里程与车况版本链</h3>
      <ul class="seq-list">
        ${(r.versions || []).map((v) => `
          <li>#${v.seq} ${({ dispatch: '出车', return: '回店', incident: '事故报备', supervisor_clear: '主管清除' })[v.kind] || v.kind}
            · <b>${odoFmt(v.odometer_km)}</b> km · 油量 ${v.fuel_pct ?? '—'}%
            ${v.new_damages ? ` · <span class="danger-text">损伤: ${(JSON.parse(v.new_damages)).map((d) => POSITION_LABEL[d.position] + ' ' + d.desc).join('；')}</span>` : ''}
            ${v.mechanical_issue ? ` · <span class="danger-text">故障: ${v.mechanical_issue}</span>` : ''}
            <span class="muted">· ${fmtTs(v.created_at)} · ${v.created_by_role || ''}</span>
            ${v.note ? `<br><span class="muted">备注：${v.note}</span>` : ''}
          </li>`).join('') || '<li class="muted">暂无车况版本</li>'}
      </ul>
    </div>

    ${r.incident_reviews && r.incident_reviews.length ? `
    <div class="card">
      <h3>事故复核结论</h3>
      ${r.incident_reviews.map((rv) => `
        <div class="kv">
          <dt>结论</dt><dd><span class="badge ${rv.clear_condition ? 'green' : 'red'}">
            ${({ customer_fault: '客户责任', store_fault: '门店责任', third_party: '第三方责任', no_fault: '无责' })[rv.conclusion]}</span>
            ${rv.clear_condition ? '· 已清除异常' : '· 维持封锁待维修'}</dd>
          <dt>主管</dt><dd class="num">${fmtTs(rv.created_at)}</dd>
          <dt>备注</dt><dd>${rv.note || '—'}</dd>
        </div>`).join('')}
    </div>` : ''}

    <div class="card">
      <h3>交接时间线</h3>
      <div class="timeline">
        ${timeline(r)}
      </div>
    </div>`;

  const zone = $('#actionZone');

  // ---- 待审核：通过（选顾问）/ 跨日提示 ----
  if (r.status === 'pending') {
    const advisors = state.meta.staff.filter((s) => s.active);
    zone.innerHTML = `
      <div class="card">
        <h3>预约审核 ${crossDay && !r.overnight.length ? '<span class="badge red">跨日单缺少单独审批</span>' : ''}</h3>
        <label class="field">锁定销售顾问
          <select id="ap-advisor">${advisors.map((a) => `<option value="${a.id}">${a.name}（${a.role === 'supervisor' ? '主管' : '顾问'}）</option>`).join('')}</select>
        </label>
        <div class="row">
          <button id="ap-ok">审核通过并锁定车辆/顾问</button>
          ${crossDay && !r.overnight.length ? '<button class="ghost" id="ap-overnight">先创建跨日审批</button>' : ''}
          <button class="gray" id="ap-reject">驳回</button>
        </div>
        <p class="muted" style="font-size:12px;margin-top:8px">系统将校验：车辆时段互斥、顾问占用、车况异常、跨日审批与押金冻结（预约号末位 9 模拟余额不足）。</p>
      </div>`;
    $('#ap-ok').onclick = async () => wrapApi(async () => {
      const out = await api(`/api/reservations/${r.id}/approve`, {
        method: 'POST', body: { advisorId: $('#ap-advisor').value },
      });
      toast(`已通过，锁定车辆与顾问，押金交易号 ${out.deposit_txn}`, 'ok');
      openReservation(r.id);
    });
    $('#ap-reject') && ($('#ap-reject').onclick = async () => {
      const reason = prompt('驳回原因：', '客户时段冲突');
      if (reason === null) return;
      await wrapApi(() => api(`/api/reservations/${r.id}/reject`, { method: 'POST', body: { reason } }), '已驳回');
      closeDrawer();
    });
    $('#ap-overnight') && ($('#ap-overnight').onclick = async () => {
      await overnightFlow(r.id); openReservation(r.id);
    });
  }

  // ---- 已通过：出车清单 / 换车 / 迟到说明 ----
  if (r.status === 'approved') {
    zone.innerHTML = `
      <div class="card">
        <h3>出车清单</h3>
        <ul class="checklist" id="dispatchChecks">
          <li data-check="license"><input type="checkbox" checked disabled> 证件核对：驾照状态 <b>${r.license_status === 'valid' ? '有效' : '无效'}</b>，客户代号 ${r.customer_code}
            <span class="ctl">${r.license_status === 'valid' ? '<span class="ok-text">✓ 适配器已核验</span>' : '<span class="danger-text">禁止出车</span>'}</span></li>
          <li data-check="vehicle">车辆锁定：<b>${r.vehicle_name} ${r.vehicle_plate}</b>，顾问 <b>${r.advisor_name}</b><span class="ctl"><span class="ok-text">✓ 审核时锁定</span></span></li>
          <li data-check="odo">出车里程读数（车机适配器 / 人工校正）
            <span class="ctl"><input type="number" step="0.1" id="dp-odo" placeholder="里程 km"></span></li>
          <li data-check="fuel">出车油量 %
            <span class="ctl"><input type="number" id="dp-fuel" placeholder="油量 %"> <span id="dp-fuel-warn"></span></span></li>
          <li data-check="photos">四个方位车身照片（车头 / 车尾 / 左 / 右）
            <span class="ctl"><button class="sm ghost" id="dp-stub">一键生成占位照</button></span>
            <div class="photo-positions" style="width:100%;margin-top:8px" id="dp-photos"></div></li>
        </ul>
        <div class="row">
          <button id="dp-go" ${!isOwner && !isSuper ? 'disabled' : ''}>确认发车（仅一次）</button>
          <button class="ghost" id="dp-reassign">临时换车 / 换车型</button>
          <span class="muted" style="font-size:12px">${!isOwner && !isSuper ? '只有被锁定顾问本人或主管可以发车' : '同一预约并发发车只接受一次'}</span>
        </div>
      </div>`;
    const photoState = {};
    renderPhotoSlots($('#dp-photos'), 'before', r, photoState);
    $('#dp-stub').onclick = async () => {
      const map = await api(`/api/reservations/${r.id}/photos-stub?kind=before`, { method: 'POST' });
      Object.assign(photoState, map);
      renderPhotoSlots($('#dp-photos'), 'before', r, photoState);
      toast('已生成四方位出车占位照', 'ok');
    };
    const fuelWarn = () => {
      const model = state.meta.models.find((m) => m.id === r.requested_model_id);
      const f = Number($('#dp-fuel').value);
      $('#dp-fuel-warn').innerHTML = f && f < model.low_fuel_threshold_pct
        ? `<span class="badge red">低油量（阈值 ${model.low_fuel_threshold_pct}%）允许出车但留痕</span>` : '';
    };
    $('#dp-fuel').oninput = fuelWarn;
    $('#dp-go').onclick = async () => wrapApi(async () => {
      const out = await api(`/api/reservations/${r.id}/dispatch`, {
        method: 'POST',
        body: {
          odometerKm: $('#dp-odo').value === '' ? null : Number($('#dp-odo').value),
          fuelPct: $('#dp-fuel').value === '' ? null : Number($('#dp-fuel').value),
          photos: photoState,
        },
      });
      if (out.lowFuelWarning) toast(`发车成功，但油量偏低（阈值 ${out.thresholdPct}%），已标记`, 'err');
      else toast('发车成功，路线计时已开始', 'ok');
      openReservation(r.id);
    });
    $('#dp-reassign').onclick = () => reassignFlow(r);
  }

  // ---- 试驾中：路线计时 + 回店登记 ----
  if (r.status === 'dispatched') {
    const planned = r.route_id ? state.meta.routes.find((x) => x.id === r.route_id)?.planned_minutes : null;
    zone.innerHTML = `
      <div class="card">
        <h3>路线计时</h3>
        <div class="row" style="align-items:baseline">
          <div class="timer" id="rt-timer">00:00</div>
          <div class="muted">/ 计划 ${planned || '—'} 分钟 <span id="rt-flag"></span></div>
          <span style="flex:1"></span>
          <button id="rt-end" ${!isOwner && !isSuper ? 'disabled' : ''}>结束路线计时</button>
        </div>
        <p class="muted" style="font-size:12px;margin-top:6px">出车里程 <span class="mono">${odoFmt(r.dispatch_odometer_km)}</span> km · 出车油量 ${Math.round(r.dispatch_fuel_pct)}%</p>
      </div>
      <div class="card">
        <h3>回店登记</h3>
        <div class="grid cols-2">
          <label class="field">结束里程（不得小于出车里程）<input type="number" step="0.1" id="rt-odo" placeholder="${odoFmt(r.dispatch_odometer_km)}"></label>
          <label class="field">回店油量 %<input type="number" id="rt-fuel" placeholder="当前油量"></label>
        </div>
        <button id="rt-return" ${!isOwner && !isSuper ? 'disabled' : ''}>登记回店并进入对照</button>
      </div>`;
    const tick = () => {
      const secs = Math.max(0, Math.floor((Date.now() - r.route_start_ts) / 1000));
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      const el = $('#rt-timer');
      if (!el) { clearInterval(timerHandle); return; }
      el.textContent = `${mm}:${ss}`;
      const over = planned && secs > planned * 60;
      el.classList.toggle('over', !!over);
      $('#rt-flag').innerHTML = over ? '<span class="badge red">路线超时</span>' : '';
    };
    clearInterval(timerHandle);
    timerHandle = setInterval(tick, 1000); tick();
    $('#rt-end').onclick = async () => wrapApi(async () => {
      const out = await api(`/api/reservations/${r.id}/route-end`, { method: 'POST' });
      toast(out.overtime ? `路线结束，用时 ${out.minutes} 分钟，已超时` : `路线结束，用时 ${out.minutes} 分钟`, out.overtime ? 'err' : 'ok');
      openReservation(r.id);
    });
    $('#rt-return').onclick = async () => wrapApi(async () => {
      if ($('#rt-odo').value === '') throw new Error('请填写结束里程');
      const out = await api(`/api/reservations/${r.id}/return`, {
        method: 'POST', body: { odometerKm: Number($('#rt-odo').value), fuelPct: $('#rt-fuel').value === '' ? null : Number($('#rt-fuel').value) },
      });
      let msg = '已回店';
      if (out.lowFuel) { toast('回店油量低于阈值，已标记低油量', 'err'); msg += '（低油）'; }
      if (out.overtime) toast(`路线超时：实际 ${out.minutes} 分钟`, 'err');
      toast(msg + '，进入回车对照', 'ok');
      openReservation(r.id);
    });
  }

  // ---- 回店对照：四方位照片 + 拖动对比 + 新损伤/故障/事故 ----
  if (r.status === 'returned') {
    zone.innerHTML = `
      <div class="card">
        <h3>回车对照 <span class="muted" style="font-size:12px">沿四个方位固定位置拍摄，拖动分隔线对比新旧照片</span></h3>
        <div id="compareGrid" class="grid cols-2"></div>
        <div class="row" style="margin-top:8px">
          <button class="ghost sm" id="ci-stub">一键生成无损伤占位照</button>
          <button class="ghost sm" id="ci-stub-dmg">一键生成带新损伤占位照（右后门）</button>
        </div>
      </div>
      <div class="card">
        <h3>异常登记</h3>
        <div id="damageRows"></div>
        <button class="gray sm" id="ci-add-dmg">+ 添加新损伤</button>
        <label class="field" style="margin-top:10px">车辆故障描述（机械异常）<input id="ci-mech" placeholder="无则留空，如：刹车偶发异响"></label>
        <label class="field" style="display:flex;flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" id="ci-incident" style="width:auto"> 客户/顾问报备事故
        </label>
        <label class="field">事故说明<textarea id="ci-incident-note" rows="2" placeholder="时间、地点、经过、人员情况"></textarea></label>
        <label class="field">其他备注<textarea id="ci-note" rows="2"></textarea></label>
        <button id="ci-submit">提交回车对照</button>
        <p class="muted" style="font-size:12px">存在新损伤/故障/事故时，车辆将封锁并进入主管事故复核；销售无权自行清除异常。</p>
      </div>`;
    const afterState = {};
    const beforeMap = {};
    (r.photos || []).filter((p) => p.kind === 'before').forEach((p) => { beforeMap[p.position] = p; });
    renderCompares($('#compareGrid'), r, beforeMap, afterState);
    const damages = [];
    const redrawDmg = () => {
      $('#damageRows').innerHTML = damages.map((d, i) => `
        <div class="row" style="margin-bottom:6px">
          <select data-i="${i}" data-k="position" style="width:130px">
            ${['front', 'rear', 'left', 'right'].map((p) => `<option value="${p}" ${d.position === p ? 'selected' : ''}>${POSITION_LABEL[p]}</option>`).join('')}
          </select>
          <input class="grow" data-i="${i}" data-k="desc" placeholder="损伤描述，如 划痕 28cm 见底漆" value="${d.desc || ''}">
          <button class="sm gray" data-del="${i}">删除</button>
        </div>`).join('');
      $$('#damageRows select, #damageRows input').forEach((el) => el.onchange = () => { damages[el.dataset.i][el.dataset.k] = el.value; });
      $$('#damageRows [data-del]').forEach((b) => b.onclick = () => { damages.splice(Number(b.dataset.del), 1); redrawDmg(); });
    };
    $('#ci-add-dmg').onclick = () => { damages.push({ position: 'right', desc: '' }); redrawDmg(); };
    redrawDmg();
    const stub = async (damage) => {
      const map = await api(`/api/reservations/${r.id}/photos-stub?kind=after${damage ? '&damage=1' : ''}`, { method: 'POST' });
      Object.assign(afterState, map);
      if (damage && !damages.some((d) => d.position === 'right')) damages.push({ position: 'right', desc: '右后门划痕约 28cm，见底漆' });
      redrawDmg();
      const fresh = await api(`/api/reservations/${r.id}`);
      renderCompares($('#compareGrid'), fresh, beforeMap, afterState);
    };
    $('#ci-stub').onclick = () => stub(false);
    $('#ci-stub-dmg').onclick = () => stub(true);
    $('#ci-submit').onclick = async () => wrapApi(async () => {
      if (Object.keys(afterState).length < 4) throw new Error('请先补齐四个方位的回店照片');
      const incident = $('#ci-incident').checked ? { reported: true, note: $('#ci-incident-note').value } : null;
      const out = await api(`/api/reservations/${r.id}/checkin`, {
        method: 'POST',
        body: {
          afterPhotos: afterState,
          newDamages: damages.filter((d) => d.desc.trim()),
          mechanicalIssue: $('#ci-mech').value.trim() || null,
          incident, note: $('#ci-note').value.trim() || null,
        },
      });
      toast(out.abnormal ? '已登记异常，等待主管事故复核' : '回车对照完成，可开启违章留观', out.abnormal ? 'err' : 'ok');
      openReservation(r.id);
    });
  }

  // ---- 异常待主管复核 ----
  if (r.status === 'exception') {
    zone.innerHTML = `
      <div class="card">
        <h3>事故复核 <span class="badge red">仅主管可操作</span></h3>
        ${r.incident_note ? `<p class="danger-text">事故报备：${r.incident_note}</p>` : ''}
        <label class="field">事故结论
          <select id="rv-conclusion">
            <option value="customer_fault">客户责任</option>
            <option value="store_fault">门店责任</option>
            <option value="third_party">第三方责任</option>
            <option value="no_fault">无责（无需维修）</option>
          </select>
        </label>
        <label class="field" style="display:flex;flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" id="rv-clear" style="width:auto"> 确认后清除车况异常（车辆转入留观/清洁流程）
        </label>
        <label class="field">复核备注<textarea id="rv-note" rows="2" placeholder="维修建议、押金处理等"></textarea></label>
        <button id="rv-submit" ${!isSuper ? 'disabled' : ''}>主管确认结论</button>
        ${!isSuper ? '<p class="danger-text" style="font-size:12px">普通销售不能清除车况异常或给出事故结论。</p>' : ''}
        <p style="font-size:12px" class="muted">不清除异常时车辆保持封锁，等待维修工单；任何角色尝试直接清除都会被拒绝（见 /clear-condition）。</p>
      </div>`;
    if (isSuper) $('#rv-submit').onclick = async () => wrapApi(async () => {
      await api(`/api/reservations/${r.id}/incident-review`, {
        method: 'POST',
        body: {
          conclusion: $('#rv-conclusion').value,
          damageConfirmed: [], clearCondition: $('#rv-clear').checked,
          note: $('#rv-note').value.trim() || null,
        },
      });
      toast('事故结论已确认', 'ok');
      openReservation(r.id);
    });
  }

  // ---- 对照完成：留观 ----
  if (r.status === 'checked') {
    const obsPending = r.observation_until && !r.observation_released_at;
    const obsDone = r.observation_released_at;
    let obsAction;
    if (!r.observation_until) {
      obsAction = `
        <div class="row">
          <label class="field" style="margin:0">留观时长（小时）<input type="number" id="ob-hours" value="24" style="width:110px"></label>
          <button id="ob-start" ${!isOwner && !isSuper ? 'disabled' : ''}>开启违章留观</button>
        </div>`;
    } else if (obsPending) {
      obsAction = '<p class="muted">留观进行中。可使用「留观/事故」页的“立即执行一次”加速演示到期。</p>';
    } else {
      obsAction = `<button id="ob-clean" ${!isOwner && !isSuper ? 'disabled' : ''}>完成清洁并恢复可预约</button>`;
    }
    zone.innerHTML = `
      <div class="card">
        <h3>违章留观与清洁</h3>
        <div class="timeline">
          <div class="t"><div>回车对照完成</div><div class="tt">${fmtTs(r.updated_at)}</div></div>
          <div class="t"><div>${r.observation_until ? `留观至 ${fmtTs(r.observation_until)}` : '尚未开启违章留观'}</div>
            ${obsDone ? `<div class="tt">留观已于 ${fmtTs(r.observation_released_at)} 结束</div>` : ''}</div>
          <div class="t"><div>${r.cleaned_at ? `清洁完成 ${fmtTs(r.cleaned_at)}，车辆可再次预约` : '留观结束后执行清洁，车辆才可再次预约'}</div></div>
        </div>
        ${obsAction}
      </div>`;
    $('#ob-start') && ($('#ob-start').onclick = async () => wrapApi(async () => {
      await api(`/api/reservations/${r.id}/observation`, { method: 'POST', body: { hours: Number($('#ob-hours').value) || 24 } });
      toast('违章留观已开启', 'ok'); openReservation(r.id);
    }));
    $('#ob-clean') && ($('#ob-clean').onclick = async () => wrapApi(async () => {
      await api(`/api/vehicles/${r.vehicle_id}/clean`, { method: 'POST' });
      toast('清洁完成，车辆已上线', 'ok'); openReservation(r.id); loadBoard();
    }));
  }

  openDrawer();
  if (opts.approve) setTimeout(() => $('#ap-ok')?.scrollIntoView({ behavior: 'smooth' }), 100);
}

async function overnightFlow(id) {
  const reason = prompt('跨日试驾审批说明：', '客户深度体验需求');
  if (reason === null) throw new Error('已取消');
  const riskNote = prompt('风控备注：', '夜间指定停车场，里程上限 120km');
  if (riskNote === null) throw new Error('已取消');
  await api(`/api/reservations/${id}/overnight`, { method: 'POST', body: { reason, riskNote, depositExtraCny: 3000 } });
  toast('跨日审批已创建', 'ok');
}

async function reassignFlow(r) {
  const sameModel = confirm('确定要换车吗？\n\n“确定” = 同车型改派另一辆车（保持审核通过）\n“取消” = 换其他车型（车辆与顾问解除锁定，需重新审核）');
  await wrapApi(async () => {
    if (sameModel) {
      await api(`/api/reservations/${r.id}/reassign`, { method: 'POST', body: {} });
      toast('已在同车型内自动改派可用车辆', 'ok');
    } else {
      const opts = state.meta.models.filter((m) => m.id !== r.requested_model_id)
        .map((m) => `${m.id}:${m.name}`).join('\n');
      const mid = prompt(`选择新车型（输入 id）：\n${opts}`, state.meta.models.find((m) => m.id !== r.requested_model_id)?.id);
      if (!mid) throw new Error('已取消');
      await api(`/api/reservations/${r.id}/reassign`, { method: 'POST', body: { newModelId: mid } });
      toast('已换车型，车辆与顾问锁定解除，回到待审核', 'ok');
    }
    openReservation(r.id);
  });
}

function timeline(r) {
  const items = [
    [r.created_at, '建立预约'],
    [r.approved_at, '审核通过，锁定车辆与顾问'],
    [r.dispatched_at, `发车 · 里程 ${odoFmt(r.dispatch_odometer_km)} km · 油量 ${Math.round(r.dispatch_fuel_pct ?? 0)}%`],
    [r.route_end_ts, `路线结束 · 用时 ${r.route_minutes ?? '—'} 分钟${r.route_overtime_flag ? '（超时）' : ''}`],
    [r.returned_at, `回店 · 里程 ${odoFmt(r.return_odometer_km)} km · 油量 ${Math.round(r.return_fuel_pct ?? 0)}%${r.low_fuel_flag ? '（低油）' : ''}`],
    [r.incident_reported_at, `事故报备：${r.incident_note || ''}`],
    [r.observation_until, `违章留观至 ${fmtTs(r.observation_until)}`],
    [r.observation_released_at, '违章留观结束'],
    [r.cleaned_at, '清洁完成，车辆恢复可预约'],
  ].filter(([ts]) => ts);
  return items.map(([ts, txt]) => `<div class="t"><div>${txt}</div><div class="tt">${fmtTs(ts)}</div></div>`).join('');
}

// ---------------- 照片四方位槽位 + 上传 ----------------
function renderPhotoSlots(container, kind, r, photoState) {
  const positions = ['front', 'rear', 'left', 'right'];
  container.innerHTML = positions.map((p) => `
    <div class="photo-slot" data-pos="${p}">
      <span class="ps-label">${POSITION_LABEL[p]}</span>
      <div class="ps-body"></div>
      <div class="ps-actions">
        <label class="btn ghost sm" style="margin:0">选择照片<input type="file" accept="image/*" hidden></label>
        <span class="fname muted">未上传</span>
      </div>
    </div>`).join('');
  $$('.photo-slot', container).forEach((slot) => {
    const pos = slot.dataset.pos;
    const file = $('input[type=file]', slot);
    const body = $('.ps-body', slot);
    const paint = (photoId) => {
      body.innerHTML = photoId ? `<img src="/api/photos/${photoId}/file?t=${Date.now()}">` : '<div class="ps-empty">固定位置：' + POSITION_LABEL[pos] + '</div>';
      $('.fname', slot).textContent = photoId ? `已上传 ${photoId.slice(-8)}` : '未上传';
      slot.style.borderColor = photoId ? 'var(--ok)' : '';
    };
    if (photoState[pos]) paint(photoState[pos]); else paint(null);
    file.onchange = async () => {
      const f = file.files[0];
      if (!f) return;
      const buf = await f.arrayBuffer();
      const photo = await api('/api/photos', {
        method: 'POST',
        headers: {
          'X-Photo-Position': pos, 'X-Photo-Kind': kind,
          'X-Reservation-Id': r.id, 'Content-Type': f.type || 'image/png',
        },
        body: buf,
      });
      photoState[pos] = photo.id;
      paint(photo.id);
      toast(`${POSITION_LABEL[pos]}照片已保存到本地目录`, 'ok');
    };
  });
}

// 新旧照片对比（拖动分隔线）
function renderCompares(container, r, beforeMap, afterState) {
  const positions = ['front', 'rear', 'left', 'right'];
  container.innerHTML = positions.map((p) => `
    <div class="photo-slot" data-pos="${p}" style="border-style:solid">
      <span class="ps-label">${POSITION_LABEL[p]}</span>
      <div class="cmp-wrap"></div>
      <div class="ps-actions">
        <label class="btn ghost sm" style="margin:0">回店照片<input type="file" accept="image/*" hidden></label>
        <span class="fname muted">${afterState[p] ? '已上传' : '未上传'}</span>
      </div>
    </div>`).join('');

  const buildCompare = (slot) => {
    const pos = slot.dataset.pos;
    const before = beforeMap[pos];
    const afterId = afterState[pos];
    const wrap = $('.cmp-wrap', slot);
    if (!before) {
      wrap.innerHTML = '<div class="ps-empty">缺少出车照片，无法对比</div>';
      return;
    }
    if (!afterId) {
      wrap.innerHTML = '<div class="ps-empty">上传/生成回店照片后<br>可拖动分隔线对比</div>';
      return;
    }
    wrap.innerHTML = `
      <div class="compare">
        <img src="/api/photos/${before.id}/file?b=1">
        <div class="after"><img src="/api/photos/${afterId}/file?a=1"></div>
        <span class="tag before">出车前</span><span class="tag after-tag">回店后</span>
        <div class="divider"></div>
      </div>`;
    const cmp = $('.compare', wrap);
    const afterEl = $('.after', cmp);
    const divider = $('.divider', cmp);
    const setPos = (clientX) => {
      const rect = cmp.getBoundingClientRect();
      const pct = Math.max(0, Math.min(100, (clientX - rect.left) / rect.width * 100));
      divider.style.left = pct + '%';
      afterEl.style.clipPath = `inset(0 0 0 ${pct}%)`;
      afterEl.style.width = '100%';
      const imgs = $$('img', afterEl);
      imgs.forEach((im) => { im.style.width = cmp.clientWidth + 'px'; im.style.height = cmp.clientHeight + 'px'; im.style.objectFit = 'cover'; });
    };
    const onMove = (e) => setPos(e.touches ? e.touches[0].clientX : e.clientX);
    const start = (e) => { e.preventDefault(); document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', () => document.removeEventListener('mousemove', onMove)); document.addEventListener('touchmove', onMove, { passive: false }); };
    divider.addEventListener('mousedown', start);
    divider.addEventListener('touchstart', start, { passive: false });
    setTimeout(() => setPos(cmp.getBoundingClientRect().left + cmp.clientWidth * 0.5), 30);
  };

  $$('.photo-slot', container).forEach((slot) => {
    const pos = slot.dataset.pos;
    buildCompare(slot);
    $('input[type=file]', slot).onchange = async () => {
      const f = $('input[type=file]', slot).files[0];
      if (!f) return;
      const photo = await api('/api/photos', {
        method: 'POST',
        headers: { 'X-Photo-Position': pos, 'X-Photo-Kind': 'after', 'X-Reservation-Id': r.id, 'Content-Type': f.type || 'image/png' },
        body: await f.arrayBuffer(),
      });
      afterState[pos] = photo.id;
      buildCompare(slot);
    };
  });
}

// ---------------- 车辆抽屉（状态板点击） ----------------
async function openVehicleDrawer(v) {
  $('#drTitle').textContent = `${v.name} · ${v.plate}`;
  const st = $('#drStatus');
  st.className = `badge ${VEH_STATUS[v.status][1] || ''}`;
  st.textContent = VEH_STATUS[v.status][0];
  const m = state.board.find((mm) => mm.vehicles.some((vv) => vv.id === v.id));
  const lowFuel = v.last_fuel_pct < m.low_fuel_threshold_pct;
  $('#drBody').innerHTML = `
    <div class="card">
      <div class="kv">
        <dt>车型</dt><dd>${m.name}（${m.category}）</dd>
        <dt>车牌</dt><dd class="mono">${v.plate}</dd>
        <dt>状态</dt><dd>${VEH_STATUS[v.status][0]} ${v.condition_flag !== 'none' ? `<span class="badge red">${v.condition_flag === 'mechanical' ? '故障' : '损伤'}</span>` : ''}</dd>
        <dt>累计里程</dt><dd class="mono">${odoFmt(v.last_odometer_km)} km</dd>
        <dt>油量</dt><dd class="mono ${lowFuel ? 'danger-text' : ''}">${Math.round(v.last_fuel_pct)}% ${lowFuel ? '低于低油阈值 ' + m.low_fuel_threshold_pct + '%' : ''}</dd>
        <dt>说明</dt><dd>${v.condition_note || '—'}</dd>
      </div>
      <div class="row">
        ${v.status === 'cleaning' ? '<button id="vh-clean">完成清洁并上线</button>' : ''}
        <button class="gray" id="vh-clear-attempt">尝试直接清除车况异常（权限演示）</button>
      </div>
    </div>`;
  $('#vh-clean') && ($('#vh-clean').onclick = async () => {
    await wrapApi(() => api(`/api/vehicles/${v.id}/clean`, { method: 'POST' }), '清洁完成，车辆已上线');
    closeDrawer(); loadBoard();
  });
  $('#vh-clear-attempt').onclick = async () => {
    try {
      await api(`/api/vehicles/${v.id}/clear-condition`, { method: 'POST' });
    } catch (e) { toast('被拒绝：' + e.message, 'err'); }
  };
  openDrawer();
}

// ---------------- 杂项 ----------------
async function wrapApi(fn, okMsg) {
  try {
    const out = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return out;
  } catch (e) {
    toast(e.message, 'err');
    throw e;
  }
}
function openDrawer() { $('#drawer').classList.add('open'); $('#mask').classList.add('open'); }
function closeDrawer() {
  $('#drawer').classList.remove('open'); $('#mask').classList.remove('open');
  clearInterval(timerHandle);
}

async function init() {
  state.meta = await api('/api/meta');
  state.board = await api('/api/board');

  const sel = $('#staffSelect');
  sel.innerHTML = '<option value="">未登录（请选择操作员）</option>' +
    state.meta.staff.map((s) => `<option value="${s.id}">${s.name}（${s.role === 'supervisor' ? '主管' : '顾问'}）</option>`).join('');
  sel.value = state.staffId;
  const syncRole = () => {
    const s = state.meta.staff.find((x) => x.id === state.staffId);
    const tag = $('#roleTag');
    tag.textContent = s ? (s.role === 'supervisor' ? '主管' : '销售顾问') : '未登录';
    tag.className = 'role-tag' + (s?.role === 'advisor' ? ' advisor' : '');
  };
  sel.onchange = () => {
    state.staffId = sel.value;
    localStorage.setItem('td_staff', state.staffId);
    syncRole();
    switchView($$('#nav button.active')[0]?.dataset.view || 'board');
  };
  syncRole();

  $('#nav').onclick = (e) => { const b = e.target.closest('button[data-view]'); if (b) switchView(b.dataset.view); };
  $('#drClose').onclick = closeDrawer;
  $('#mask').onclick = closeDrawer;

  fillModelSelects();
  $('#nr-model').onchange = syncVehicleOptions;
  $('#nr-submit').onclick = createReservation;

  $('#calDate').value = state.calDate;
  $('#calDate').onchange = () => { state.calDate = $('#calDate').value; loadCalendar(); };
  const shiftDay = (d) => {
    const dt = new Date(state.calDate + 'T00:00:00'); dt.setDate(dt.getDate() + d);
    state.calDate = dt.toISOString().slice(0, 10); $('#calDate').value = state.calDate; loadCalendar();
  };
  $('#calPrev').onclick = () => shiftDay(-1);
  $('#calNext').onclick = () => shiftDay(1);
  $('#calToday').onclick = () => { state.calDate = new Date().toISOString().slice(0, 10); $('#calDate').value = state.calDate; loadCalendar(); };

  $('#btnTick').onclick = async () => {
    const out = await api('/api/scheduler/tick', { method: 'POST' });
    $('#tickResult').textContent = JSON.stringify(out, null, 2);
    loadOps();
  };

  // 默认时间填今天 14:00-15:00
  const today = new Date();
  const local = (h) => {
    const d = new Date(today); d.setHours(h, 0, 0, 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  $('#nr-start').value = local(14);
  $('#nr-end').value = local(15);

  loadBoard();
}

init();
