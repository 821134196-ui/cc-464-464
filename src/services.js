'use strict';
const S = require('./store');
const { tx } = require('./db');
const adapters = require('./adapters');
const {
  uid, nowISO, overlaps, isCrossDay, minutesBetween, addMinutes,
} = require('./util');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status; this.code = code;
  }
}

const CFG = {
  LATE_GRACE_MIN: Number(process.env.TD_GRACE_MIN || 15),
  LOW_FUEL_PCT: Number(process.env.TD_LOW_FUEL || 15),
  WATCH_MIN: Number(process.env.TD_WATCH_MIN || 60 * 24 * 3), // 违章留观默认 3 天
  DEPOSIT_CENTS: Number(process.env.TD_DEPOSIT_CENTS || 50000),
};

const LOCKED_RES = ['approved', 'dispatched', 'returned', 'watching'];

// ---------- 权限 ----------
function requireActor(actorId) {
  const actor = S.staff.get(actorId);
  if (!actor || !actor.active) throw new ApiError(401, 'unauthorized', '请先选择在职员工身份');
  return actor;
}
const isSupervisor = (a) => a.role === 'supervisor';
function requireSupervisor(actor) {
  if (!isSupervisor(actor)) throw new ApiError(403, 'forbidden', '该操作需要主管权限');
}
function ownOrSupervisor(actor, reservation) {
  if (!isSupervisor(actor) && reservation.advisor_id !== actor.id)
    throw new ApiError(403, 'forbidden', '只能操作分配给自己的预约');
}

// ---------- 冲突检测 ----------
function assertNoVehicleConflict(vehicleId, start, end, excludeResId = null) {
  for (const r of S.reservations.activeOnVehicle(vehicleId, excludeResId)) {
    if (overlaps(start, end, r.start_at, r.end_at)) {
      throw new ApiError(409, 'vehicle_overlap',
        `车辆时间冲突：与预约 ${r.code}（${r.customer_code}）时段重叠`);
    }
  }
  const openDispatch = S.dispatches.openForVehicle(vehicleId);
  if (openDispatch && openDispatch.reservation_id !== excludeResId) {
    throw new ApiError(409, 'vehicle_out', '车辆尚未回店，存在未结束出车单');
  }
}
function assertNoAdvisorConflict(advisorId, start, end, excludeResId = null) {
  for (const r of S.reservations.activeForAdvisor(advisorId, excludeResId)) {
    if (overlaps(start, end, r.start_at, r.end_at)) {
      throw new ApiError(409, 'advisor_overlap',
        `顾问时间冲突：${r.advisor_name} 在该时段已有预约 ${r.code}`);
    }
  }
}

// ---------- 车况版本 ----------
function snapshotVersion(d, vehicleId, source, refId, actor, photos = null, extra = {}) {
  const v = S.vehicles.get(vehicleId);
  S.versions.insert({
    id: uid('ver'), vehicle_id: vehicleId, version: S.versions.nextNo(vehicleId),
    mileage: v.mileage, fuel_pct: v.fuel_pct,
    condition_flag: extra.condition_flag ?? v.condition_flag,
    issue_note: extra.issue_note !== undefined ? extra.issue_note : v.issue_note,
    source, ref_id: refId, photos: photos ? JSON.stringify(photos) : null,
    created_by: actor ? actor.id : 'system', created_at: nowISO(),
  });
}

// ============================================================
// 预约申请
// ============================================================
async function createReservation(actorId, input) {
  const actor = requireActor(actorId);
  const model = S.models.get(input.model_id);
  if (!model) throw new ApiError(404, 'no_model', '车型不存在');
  const advisor = S.staff.get(input.advisor_id) || actor;
  if (advisor.role !== 'advisor') throw new ApiError(422, 'bad_advisor', '试驾必须由销售顾问带队');

  const start = new Date(input.start_at).toISOString();
  const end = new Date(input.end_at).toISOString();
  if (!(new Date(start) < new Date(end))) throw new ApiError(422, 'bad_time', '结束时间必须晚于开始时间');
  const crossDay = isCrossDay(start, end) ? 1 : 0;

  let vehicleId = null;
  if (input.vehicle_id) {
    const vh = S.vehicles.get(input.vehicle_id);
    if (!vh || vh.model_id !== model.id) throw new ApiError(422, 'bad_vehicle', '车辆与车型不匹配');
    vehicleId = vh.id;
  }

  const customer = S.customers.byCode(input.customer_code);
  if (!customer) throw new ApiError(404, 'no_customer', '客户代号不存在，请先建档');

  const r = {
    id: uid('res'), code: input.code || `TD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`,
    vehicle_id: vehicleId, model_id: model.id, advisor_id: advisor.id,
    customer_code: customer.code, license_no: customer.license_no,
    route_id: input.route_id || null, companion: input.companion || null,
    start_at: start, end_at: end, cross_day: crossDay,
    status: 'requested', note: input.note || null, reject_reason: null,
    late_grace_min: CFG.LATE_GRACE_MIN, created_by: actor.id,
    created_at: nowISO(), decided_at: null,
  };
  S.reservations.insert(r);
  S.audit(actor, 'reservation.create', r.id, { code: r.code, cross_day: crossDay });
  return S.reservations.get(r.id);
}

// ============================================================
// 预约审核（通过即锁定车辆与顾问；模拟扣款）
// ============================================================
async function approveReservation(actorId, resId) {
  const actor = requireActor(actorId);
  requireSupervisor(actor);
  // 事务一：前置校验（异常车辆、跨日审批、车辆/顾问时段互斥）
  const ctx = tx(() => {
    const r = S.reservations.get(resId);
    if (!r) throw new ApiError(404, 'no_res', '预约不存在');
    if (r.status !== 'requested') throw new ApiError(409, 'bad_state', `当前状态 ${r.status} 不可审核`);

    if (!r.vehicle_id) throw new ApiError(422, 'no_vehicle', '尚未指定试驾车，无法锁定');
    const vh = S.vehicles.get(r.vehicle_id);
    if (vh.condition_flag === 'abnormal' || S.incidents.openForVehicle(vh.id).length)
      throw new ApiError(409, 'vehicle_abnormal', '车辆存在车况异常/未结事故，不能安排预约');

    if (r.cross_day === 1) {
      const ap = S.approvals.find(r.id, 'cross_day');
      if (!ap || ap.decision !== 'approved')
        throw new ApiError(422, 'cross_day_required', '跨日试驾必须先完成单独的跨日审批');
    }

    assertNoVehicleConflict(vh.id, r.start_at, r.end_at, r.id);
    assertNoAdvisorConflict(r.advisor_id, r.start_at, r.end_at, r.id);
    return { r, vh, customer: S.customers.byCode(r.customer_code) };
  });

  // 事务外：模拟押金支付（网络调用）
  const pay = await adapters.chargeReservation(ctx.customer, CFG.DEPOSIT_CENTS);

  // 事务二：落库（支付期间可能被抢占，再次校验）
  return tx(() => {
    const r = S.reservations.get(resId);
    if (r.status !== 'requested') throw new ApiError(409, 'bad_state', '预约状态已变化，请刷新');
    assertNoVehicleConflict(ctx.vh.id, r.start_at, r.end_at, r.id);
    assertNoAdvisorConflict(r.advisor_id, r.start_at, r.end_at, r.id);

    S.payments.insert({
      id: uid('pay'), reservation_id: r.id, amount: pay.amount,
      status: pay.status, provider_ref: pay.providerRef, raw: JSON.stringify(pay.raw),
      created_at: nowISO(),
    });
    if (pay.status !== 'success') {
      S.audit(actor, 'reservation.payment_failed', r.id, pay.raw);
      throw new ApiError(402, 'payment_failed', `押金支付失败：${pay.raw.msg || '模拟渠道拒绝'}`);
    }
    S.reservations.setStatus(r.id, 'approved', { decided_at: nowISO() });
    S.vehicles.updateState(ctx.vh.id, { status: 'booked' });
    S.audit(actor, 'reservation.approve', r.id, {
      vehicle: ctx.vh.plate, pay: pay.providerRef,
    });
    return S.reservations.get(r.id);
  });
}

async function rejectReservation(actorId, resId, reason) {
  const actor = requireActor(actorId);
  requireSupervisor(actor);
  return tx(() => {
    const r = S.reservations.get(resId);
    if (!r) throw new ApiError(404, 'no_res', '预约不存在');
    if (r.status !== 'requested') throw new ApiError(409, 'bad_state', '仅待审核预约可驳回');
    S.reservations.setStatus(r.id, 'rejected', { reject_reason: reason || '未说明', decided_at: nowISO() });
    S.audit(actor, 'reservation.reject', r.id, { reason });
    return S.reservations.get(r.id);
  });
}

async function cancelReservation(actorId, resId, reason) {
  const actor = requireActor(actorId);
  return tx(() => {
    const r = S.reservations.get(resId);
    if (!r) throw new ApiError(404, 'no_res', '预约不存在');
    ownOrSupervisor(actor, r);
    if (!['requested', 'approved'].includes(r.status))
      throw new ApiError(409, 'bad_state', '已发车预约不能取消，请走回店流程');
    S.reservations.setStatus(r.id, 'cancelled', { reject_reason: reason || null });
    recomputeVehicleStatus(r.vehicle_id);
    S.audit(actor, 'reservation.cancel', r.id, { reason });
    return S.reservations.get(r.id);
  });
}

// 单独审批：跨日 / 换车型
async function createSpecialApproval(actorId, resId, type, decision, note) {
  const actor = requireActor(actorId);
  requireSupervisor(actor);
  if (!['cross_day', 'swap_model', 'route_overtime'].includes(type))
    throw new ApiError(422, 'bad_type', '不支持的审批类型');
  return tx(() => {
    const r = S.reservations.get(resId);
    if (!r) throw new ApiError(404, 'no_res', '预约不存在');
    if (type === 'cross_day' && r.cross_day !== 1)
      throw new ApiError(422, 'not_cross_day', '该预约并非跨日试驾');
    const existing = S.approvals.find(resId, type);
    if (existing) throw new ApiError(409, 'exists', '该审批记录已存在');
    const a = {
      id: uid('ap'), reservation_id: resId, type, decision,
      approver_id: actor.id, note: note || null, created_at: nowISO(),
    };
    S.approvals.insert(a);
    S.audit(actor, `approval.${type}`, resId, { decision, note });
    return a;
  });
}

// ============================================================
// 临时换车（同车型顾问可换；换车型必须主管审批）
// ============================================================
async function swapVehicle(actorId, resId, toVehicleId, reason) {
  const actor = requireActor(actorId);
  return tx(() => {
    const r = S.reservations.get(resId);
    if (!r) throw new ApiError(404, 'no_res', '预约不存在');
    ownOrSupervisor(actor, r);
    if (!['requested', 'approved'].includes(r.status))
      throw new ApiError(409, 'bad_state', '车辆已发出，不能再换车');
    const to = S.vehicles.get(toVehicleId);
    if (!to) throw new ApiError(404, 'no_vehicle', '目标车辆不存在');
    if (to.id === r.vehicle_id) throw new ApiError(422, 'same_vehicle', '目标车辆与当前车辆相同');
    if (to.condition_flag === 'abnormal' || S.incidents.openForVehicle(to.id).length)
      throw new ApiError(409, 'target_abnormal', '目标车辆存在车况异常，不能调入');
    if (S.dispatches.openForVehicle(to.id))
      throw new ApiError(409, 'target_out', '目标车辆当前在外');

    const changedModel = to.model_id !== r.model_id;
    if (changedModel) {
      requireSupervisor(actor);
      const ap = S.approvals.find(r.id, 'swap_model');
      if (!ap || ap.decision !== 'approved')
        throw new ApiError(422, 'swap_model_required', '临时更换车型必须先获得主管的换车型审批');
    }

    assertNoVehicleConflict(to.id, r.start_at, r.end_at, r.id);

    const fromId = r.vehicle_id;
    S.reservations.insertSwap({
      id: uid('sw'), reservation_id: r.id, from_vehicle_id: fromId,
      to_vehicle_id: to.id, changed_model: changedModel ? 1 : 0,
      approver_id: changedModel ? actor.id : null,
      reason: reason || (changedModel ? '临时更换车型' : '同车型调换'), created_at: nowISO(),
    });
    S.reservations.setStatus(r.id, r.status, { vehicle_id: to.id, model_id: to.model_id });
    S.vehicles.updateState(to.id, { status: r.status === 'approved' ? 'booked' : to.status });
    if (fromId) recomputeVehicleStatus(fromId);
    S.audit(actor, 'reservation.swap', r.id, { from: fromId, to: to.id, changed_model: changedModel });
    return S.reservations.get(r.id);
  });
}

// ============================================================
// 出车：证件 / 里程 / 油量 / 四方位照片
// ============================================================
async function dispatch(actorId, resId) {
  const actor = requireActor(actorId);
  const ctx = tx(() => {
    const r = S.reservations.get(resId);
    if (!r) throw new ApiError(404, 'no_res', '预约不存在');
    ownOrSupervisor(actor, r);
    if (r.status !== 'approved') throw new ApiError(409, 'bad_state', '只有已通过预约可以出车');
    if (new Date(nowISO()) > new Date(addMinutes(r.start_at, r.late_grace_min)))
      throw new ApiError(409, 'too_late', '已超过迟到宽限时间，请重新预约或申请改派');

    const vh = S.vehicles.get(r.vehicle_id);
    if (vh.condition_flag === 'abnormal' || S.incidents.openForVehicle(vh.id).length)
      throw new ApiError(409, 'vehicle_abnormal', '车辆存在车况异常，禁止放行');
    if (S.dispatches.openForVehicle(vh.id))
      throw new ApiError(409, 'double_dispatch_vehicle', '该车辆已有未结束出车单（同一车辆不能重复发车）');
    if (S.dispatches.openForAdvisor(r.advisor_id))
      throw new ApiError(409, 'double_dispatch_advisor', '该顾问已有一辆试驾车在外');

    const shots = S.photos.forReservation(r.id).filter(p => p.phase === 'out');
    if (shots.length < 4)
      throw new ApiError(422, 'photos_missing', `出车照片不完整（${shots.length}/4），需补拍四方位照片`);

    return { r, vh, shots };
  });

  // 适配器：驾照核验（事务外模拟网络调用）
  const customer = S.customers.byCode(ctx.r.customer_code);
  const lic = await adapters.verifyLicense(customer);
  if (!lic.valid) {
    S.audit(actor, 'dispatch.license_invalid', ctx.r.id, lic);
    throw new ApiError(422, 'license_invalid', `证件无效：${lic.reason}`);
  }

  // 适配器：里程读取
  const mil = await adapters.readMileage(ctx.vh);
  if (mil.mileage < ctx.vh.mileage)
    throw new ApiError(409, 'mileage_regress', '车机里程小于台账里程，设备异常');

  try {
    return tx(() => {
      const vh = S.vehicles.get(ctx.vh.id); // 重新读取，事务内最新
      const lowFuel = vh.fuel_pct < CFG.LOW_FUEL_PCT ? 1 : 0;
      if (lowFuel)
        throw new ApiError(422, 'low_fuel', `油量 ${vh.fuel_pct}% 低于 ${CFG.LOW_FUEL_PCT}%，请先加油再出车`);

      const route = ctx.r.route_id ? S.routes.get(ctx.r.route_id) : null;
      const startedAt = nowISO();
      const d = {
        id: uid('dp'), reservation_id: ctx.r.id, vehicle_id: vh.id, advisor_id: ctx.r.advisor_id,
        companion: ctx.r.companion, license_checked: 1, license_result: lic.reason, license_valid: 1,
        out_mileage: vh.mileage, out_fuel: vh.fuel_pct, low_fuel_alert: 0,
        route_id: ctx.r.route_id, route_started_at: startedAt,
        route_due_at: route ? addMinutes(startedAt, route.planned_minutes) : null,
        route_ended_at: null, overtime_minutes: 0,
        end_mileage: null, end_fuel: null, new_damage: null, return_note: null,
        dispatched_at: startedAt, returned_at: null,
      };
      // 唯一索引 ux_open_dispatch_vehicle 兜底并发：两名顾问同时点发车只有一条成功
      S.dispatches.insert(d);
      S.reservations.setStatus(ctx.r.id, 'dispatched');
      S.vehicles.updateState(vh.id, { status: 'out' });
      snapshotVersion(null, vh.id, 'dispatch', d.id, actor,
        ctx.shots.map(p => ({ side: p.side, path: p.path })));
      S.audit(actor, 'dispatch.ok', ctx.r.id, {
        plate: vh.plate, mileage: vh.mileage, fuel: vh.fuel_pct,
        license: lic.provider, obd: mil.deviceId,
      });
      return S.dispatches.byReservation(ctx.r.id);
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE constraint failed')) {
      throw new ApiError(409, 'double_dispatch_vehicle', '并发冲突：该车辆同时刻已被另一路发车占用');
    }
    throw e;
  }
}

// 路线单独计时（也可在出车时自动开始；这里支持暂停后重开场景之外的手动开始）
async function startRoute(actorId, resId) {
  const actor = requireActor(actorId);
  return tx(() => {
    const r = S.reservations.get(resId);
    if (!r) throw new ApiError(404, 'no_res', '预约不存在');
    ownOrSupervisor(actor, r);
    const d = S.dispatches.byReservation(resId);
    if (!d || d.returned_at) throw new ApiError(409, 'bad_state', '出车单不存在或已结束');
    if (d.route_started_at) throw new ApiError(409, 'route_started', '路线计时已开始');
    const route = S.routes.get(d.route_id);
    const startedAt = nowISO();
    S.run('UPDATE dispatches SET route_started_at=?, route_due_at=? WHERE id=?',
      startedAt, route ? addMinutes(startedAt, route.planned_minutes) : null, d.id);
    S.audit(actor, 'route.start', resId, { route: route ? route.name : null });
    return S.dispatches.byReservation(resId);
  });
}

// ============================================================
// 回店：里程连续 / 新损伤 / 违章留观 / 清洁
// ============================================================
async function finishReturn(actorId, resId, input) {
  const actor = requireActor(actorId);
  return tx(() => {
    const r = S.reservations.get(resId);
    if (!r) throw new ApiError(404, 'no_res', '预约不存在');
    ownOrSupervisor(actor, r);
    if (r.status !== 'dispatched') throw new ApiError(409, 'bad_state', '只有出车中的预约可以回店登记');
    const d = S.dispatches.byReservation(resId);
    if (!d || d.returned_at) throw new ApiError(409, 'bad_dispatch', '出车单状态异常');

    const endMileage = Math.trunc(Number(input.end_mileage));
    const endFuel = Math.trunc(Number(input.end_fuel));
    if (!Number.isFinite(endMileage) || !Number.isFinite(endFuel))
      throw new ApiError(422, 'bad_reading', '里程/油量读数不合法');
    if (endFuel < 0 || endFuel > 100) throw new ApiError(422, 'bad_fuel', '油量必须在 0-100 之间');
    // 里程连续性：不得小于出车里程，也不得小于当前台账里程
    if (endMileage < d.out_mileage)
      throw new ApiError(422, 'mileage_gap',
        `里程不连续：回店里程 ${endMileage} 小于出车里程 ${d.out_mileage}`);
    const vh0 = S.vehicles.get(r.vehicle_id);
    if (endMileage < vh0.mileage)
      throw new ApiError(422, 'mileage_gap', `里程不连续：小于台账里程 ${vh0.mileage}`);

    const endedAt = nowISO();
    let overtime = 0;
    if (d.route_started_at) {
      overtime = Math.max(0, minutesBetween(d.route_due_at || d.route_started_at, endedAt));
    }
    if (overtime > 0) {
      requireSupervisor(actor);
      const ap = S.approvals.find(r.id, 'route_overtime');
      if (!ap) S.approvals.insert({
        id: uid('ap'), reservation_id: r.id, type: 'route_overtime',
        decision: 'approved', approver_id: actor.id,
        note: `路线超时 ${overtime} 分钟，主管现场确认`, created_at: nowISO(),
      });
    }

    const returnShots = S.photos.forReservation(r.id).filter(p => p.phase === 'return');
    if (returnShots.length < 4)
      throw new ApiError(422, 'photos_missing', `回店照片不完整（${returnShots.length}/4）`);

    const damageSides = Array.isArray(input.damage_sides) ? input.damage_sides.filter(s =>
      ['front', 'rear', 'left', 'right'].includes(s)) : [];
    const damageDetail = {};
    for (const s of damageSides) damageDetail[s] = input.damage_note || '回店照片比对发现新损伤';

    S.dispatches.finish(d.id, {
      route_ended_at: endedAt, overtime_minutes: overtime,
      end_mileage: endMileage, end_fuel: endFuel,
      new_damage: damageSides.length ? JSON.stringify(damageDetail) : null,
      return_note: input.note || null, returned_at: endedAt,
    });
    S.vehicles.updateState(vh0.id, { mileage: endMileage, fuel_pct: endFuel });

    const watchId = uid('vw');
    const starts = nowISO();
    S.watches.insert({
      id: watchId, reservation_id: r.id, vehicle_id: vh0.id,
      starts_at: starts, ends_at: addMinutes(starts, CFG.WATCH_MIN),
      status: 'observing', result_note: null, ended_by: null, created_at: nowISO(),
    });
    S.cleanings.insert({
      id: uid('cl'), reservation_id: r.id, vehicle_id: vh0.id,
      status: 'pending', done_by: null, done_at: null, created_at: nowISO(),
    });

    let locked = false;
    if (damageSides.length) {
      const inc = {
        id: uid('inc'), code: `DMG-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`,
        reservation_id: r.id, vehicle_id: vh0.id, reporter_id: actor.id,
        severity: input.severity === 'major' ? 'major' : 'minor',
        description: `回店比对发现新损伤（${damageSides.join('/')}）：${input.damage_note || '待主管复核'}`,
        status: 'reported', conclusion: null, confirmed_by: null, confirmed_at: null,
        created_at: nowISO(),
      };
      S.incidents.insert(inc);
      S.vehicles.updateState(vh0.id, {
        status: 'incident_locked', condition_flag: 'abnormal',
        issue_note: `新损伤待复核：${damageSides.join('/')}`,
      });
      locked = true;
    } else {
      S.vehicles.updateState(vh0.id, { status: 'watching' });
    }

    snapshotVersion(null, vh0.id, 'return', d.id, actor,
      returnShots.map(p => ({ side: p.side, path: p.path })),
      locked ? { condition_flag: 'abnormal', issue_note: vh0.issue_note } : {});

    S.reservations.setStatus(r.id, 'watching');
    S.audit(actor, 'return.ok', r.id, {
      end_mileage: endMileage, end_fuel: endFuel, overtime, damage: damageSides, watch: watchId,
    });
    return {
      dispatch: S.dispatches.byReservation(r.id),
      watch: S.watches.forReservation(r.id),
      cleaning: S.cleanings.forReservation(r.id),
    };
  });
}

// 事故 / 故障报备（任何员工；立即锁车）
async function reportIncident(actorId, input) {
  const actor = requireActor(actorId);
  return tx(() => {
    const vh = S.vehicles.get(input.vehicle_id);
    if (!vh) throw new ApiError(404, 'no_vehicle', '车辆不存在');
    if (input.reservation_id) {
      const r = S.reservations.get(input.reservation_id);
      if (!r) throw new ApiError(404, 'no_res', '预约不存在');
      ownOrSupervisor(actor, r);
    }
    const kind = input.kind === 'fault' ? '车辆故障' : '事故报备';
    const inc = {
      id: uid('inc'),
      code: `${input.kind === 'fault' ? 'FLT' : 'ACC'}-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`,
      reservation_id: input.reservation_id || null, vehicle_id: vh.id, reporter_id: actor.id,
      severity: input.severity === 'major' ? 'major' : 'minor',
      description: `【${kind}】${input.description || '待补充'}`,
      status: 'reported', conclusion: null, confirmed_by: null, confirmed_at: null,
      created_at: nowISO(),
    };
    S.incidents.insert(inc);
    S.vehicles.updateState(vh.id, {
      status: 'incident_locked', condition_flag: 'abnormal',
      issue_note: `${kind}待主管复核：${input.description || ''}`.slice(0, 120),
    });
    snapshotVersion(null, vh.id, 'incident', inc.id, actor);
    S.audit(actor, 'incident.report', inc.id, { plate: vh.plate, kind });
    return S.incidents.get(inc.id);
  });
}

// 主管确认事故结论
async function confirmIncident(actorId, incId, conclusion, severity) {
  const actor = requireActor(actorId);
  requireSupervisor(actor);
  return tx(() => {
    const inc = S.incidents.get(incId);
    if (!inc) throw new ApiError(404, 'no_incident', '事故不存在');
    if (inc.status !== 'reported') throw new ApiError(409, 'bad_state', '仅待复核事故可确认');
    const fields = {
      status: 'confirmed', conclusion: conclusion || '主管确认：情况属实，按流程处理',
      confirmed_by: actor.id, confirmed_at: nowISO(),
    };
    if (severity) fields.severity = severity === 'major' ? 'major' : 'minor';
    S.incidents.update(incId, fields);
    S.vehicles.updateState(inc.vehicle_id, { issue_note: `事故已确认待整改：${(conclusion || '').slice(0, 80)}` });
    S.audit(actor, 'incident.confirm', incId, { conclusion });
    return S.incidents.get(incId);
  });
}

// 主管清除车况异常（普通销售禁止）
async function clearIncident(actorId, incId, note) {
  const actor = requireActor(actorId);
  requireSupervisor(actor);
  return tx(() => {
    const inc = S.incidents.get(incId);
    if (!inc) throw new ApiError(404, 'no_incident', '事故不存在');
    if (inc.status === 'cleared') throw new ApiError(409, 'already_cleared', '该事故已关闭');
    S.incidents.update(incId, {
      status: 'cleared', conclusion: note || inc.conclusion || '维修/复核完成，异常清除',
    });
    if (!S.incidents.openForVehicle(inc.vehicle_id).length) {
      S.vehicles.updateState(inc.vehicle_id, {
        condition_flag: 'normal', issue_note: null,
      });
      snapshotVersion(null, inc.vehicle_id, 'clear', incId, actor);
      tryReleaseVehicleAfterIncident(inc.vehicle_id);
    }
    S.audit(actor, 'incident.clear', incId, { note });
    return S.incidents.get(incId);
  });
}

function tryReleaseVehicleAfterIncident(vehicleId) {
  const vh = S.vehicles.get(vehicleId);
  if (vh.status !== 'incident_locked') return;
  // 仍有后续生效预约 → booked，否则 available
  const future = S.all(`SELECT * FROM reservations WHERE vehicle_id=? AND status='approved'
    AND end_at > ? ORDER BY start_at LIMIT 1`, vehicleId, nowISO());
  S.vehicles.updateState(vehicleId, { status: future.length ? 'booked' : 'available' });
}

// 加油（低油量处理）
async function refuel(actorId, vehicleId, fuelPct) {
  const actor = requireActor(actorId);
  return tx(() => {
    const vh = S.vehicles.get(vehicleId);
    if (!vh) throw new ApiError(404, 'no_vehicle', '车辆不存在');
    const fuel = Math.max(0, Math.min(100, Math.trunc(Number(fuelPct))));
    if (fuel <= vh.fuel_pct) throw new ApiError(422, 'bad_fuel', '加油后油量必须高于当前油量');
    S.vehicles.updateState(vehicleId, { fuel_pct: fuel });
    snapshotVersion(null, vehicleId, 'refuel', null, actor);
    S.audit(actor, 'vehicle.refuel', vehicleId, { fuel });
    return S.vehicles.get(vehicleId);
  });
}

// 清洁完成
async function completeCleaning(actorId, resId) {
  const actor = requireActor(actorId);
  return tx(() => {
    const r = S.reservations.get(resId);
    if (!r) throw new ApiError(404, 'no_res', '预约不存在');
    ownOrSupervisor(actor, r);
    const c = S.cleanings.forReservation(resId);
    if (!c) throw new ApiError(404, 'no_cleaning', '清洁记录不存在');
    if (c.status === 'done') return c;
    S.cleanings.complete(c.id, actor.id);
    S.audit(actor, 'cleaning.done', resId, {});
    maybeComplete(resId);
    return S.cleanings.forReservation(resId);
  });
}

// 手动结束留观（主管；系统任务也会调用 system 版）
async function resolveWatch(actorId, watchId, status, note) {
  const actor = actorId === 'system' ? null : requireActor(actorId);
  if (actor) requireSupervisor(actor);
  return tx(() => {
    const w = S.watches.get(watchId);
    if (!w) throw new ApiError(404, 'no_watch', '留观记录不存在');
    if (w.status !== 'observing') throw new ApiError(409, 'bad_state', '留观已结束');
    const finalStatus = status === 'violation_found' ? 'violation_found' : 'cleared';
    S.watches.update(watchId, {
      status: finalStatus,
      result_note: note || (finalStatus === 'cleared' ? '留观期内未查到违章记录' : '发现违章，转处理流程'),
      ended_by: actor ? actor.id : 'system',
    });
    S.audit(actor, `watch.${finalStatus}`, w.reservation_id, { note });
    maybeComplete(w.reservation_id);
    return S.watches.get(watchId);
  });
}

function maybeComplete(resId) {
  const w = S.watches.forReservation(resId);
  const c = S.cleanings.forReservation(resId);
  const r = S.reservations.get(resId);
  if (!w || !c || !r) return;
  if (w.status === 'observing' || c.status !== 'done') return;
  if (!['watching', 'returned'].includes(r.status)) return;

  const hasOpenIncident = S.incidents.openForVehicle(r.vehicle_id).length > 0;
  S.reservations.setStatus(resId, 'completed');
  if (!hasOpenIncident) {
    S.vehicles.updateState(r.vehicle_id, {
      status: 'available',
      condition_flag: 'normal', issue_note: null,
    });
  }
  S.audit(null, 'reservation.complete', resId, { has_open_incident: hasOpenIncident });
}

// 根据在效预约重算车辆状态（取消/释放后）
function recomputeVehicleStatus(vehicleId) {
  if (!vehicleId) return;
  const vh = S.vehicles.get(vehicleId);
  if (!vh) return;
  if (vh.condition_flag === 'abnormal') { S.vehicles.updateState(vehicleId, { status: 'incident_locked' }); return; }
  if (S.dispatches.openForVehicle(vehicleId)) { S.vehicles.updateState(vehicleId, { status: 'out' }); return; }
  const watch = S.one(`SELECT * FROM violation_watches WHERE vehicle_id=? AND status='observing'`, vehicleId);
  if (watch) { S.vehicles.updateState(vehicleId, { status: 'watching' }); return; }
  const booked = S.one(`SELECT * FROM reservations WHERE vehicle_id=? AND status='approved'
    AND end_at > ? ORDER BY start_at LIMIT 1`, vehicleId, nowISO());
  S.vehicles.updateState(vehicleId, { status: booked ? 'booked' : 'available' });
}

// ============================================================
// 进程内定时任务：迟到释放 / 留观到期
// ============================================================
const scheduler = {
  tick() {
    const result = { released: [], watchesEnded: [] };
    // 1) 迟到：approved 且超过宽限仍未发车
    const late = S.all(`SELECT * FROM reservations WHERE status='approved'
      AND datetime(start_at, '+' || late_grace_min || ' minutes') < datetime(?)`, nowISO());
    for (const r of late) {
      tx(() => {
        const fresh = S.reservations.get(r.id);
        if (fresh.status !== 'approved') return;
        if (S.dispatches.byReservation(r.id)) return;
        S.reservations.setStatus(r.id, 'released_late', {
          note: (fresh.note ? fresh.note + ' | ' : '') + '超过迟到宽限未出车，系统自动释放',
        });
        recomputeVehicleStatus(fresh.vehicle_id);
        S.audit(null, 'reservation.auto_release_late', r.id, {
          start_at: fresh.start_at, grace: fresh.late_grace_min,
        });
        result.released.push(r.code);
      });
    }
    // 2) 留观到期
    for (const w of S.watches.due()) {
      try {
        const out = resolveWatch('system', w.id, 'cleared', '留观期满，系统自动结束，未发现违章');
        result.watchesEnded.push(out.id);
      } catch (e) { /* 已被手动处理 */ }
    }
    return result;
  },
  start(intervalMs = 10000) {
    return setInterval(() => {
      try { scheduler.tick(); } catch (e) { console.error('[scheduler]', e.message); }
    }, intervalMs);
  },
};

// 详情聚合
function reservationDetail(resId) {
  const r = S.reservations.get(resId);
  if (!r) throw new ApiError(404, 'no_res', '预约不存在');
  return {
    reservation: r,
    dispatch: S.dispatches.byReservation(resId),
    photos: S.photos.forReservation(resId),
    swaps: S.reservations.swapsFor(resId),
    approvals: S.approvals.forReservation(resId),
    watch: S.watches.forReservation(resId),
    cleaning: S.cleanings.forReservation(resId),
    payments: S.payments.forReservation(resId),
    incidents: S.all(`SELECT i.* FROM incidents i WHERE i.reservation_id=? ORDER BY i.created_at`, resId),
  };
}

module.exports = {
  ApiError, CFG,
  createReservation, approveReservation, rejectReservation, cancelReservation,
  createSpecialApproval, swapVehicle,
  dispatch, startRoute, finishReturn,
  reportIncident, confirmIncident, clearIncident, refuel,
  completeCleaning, resolveWatch, reservationDetail,
  recomputeVehicleStatus, snapshotVersion, scheduler,
};
