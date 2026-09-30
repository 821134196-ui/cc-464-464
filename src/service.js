// 领域服务：预约状态机、时段互斥、换车、里程链、权限、事故复核、留观与清洁
import { uid, now, overlap, sameDay, minutesBetween, clone } from './util.js';
import { verifyLicense, readTelemetry, chargeDeposit, refundDeposit } from './adapters.js';

// 允许的预约状态流转
const TRANSITIONS = {
  pending:    ['approved', 'rejected', 'cancelled'],
  approved:   ['dispatched', 'released', 'cancelled', 'reassigned'],
  dispatched: ['returned'],
  returned:   ['checked', 'exception'],
  // 回店检查发现事故/故障，进入异常待主管复核
  exception:  ['checked', 'released'],
  // checked 完成对照；之后进入 observation/cleaning（由车辆维度控制），车辆恢复后预约归档完成
  checked:    [],
  rejected:   [],
  released:   [],
  cancelled:  [],
};

const ACTIVE_STATUSES = ['approved', 'dispatched', 'returned', 'exception', 'checked'];
// checked 仍占用车辆，直到留观+清洁完成（释放由 finishVehicleTurnover 处理）

export class DomainError extends Error {
  constructor(message, code = 'bad_request', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class Service {
  constructor(db, { photoDir = 'data/photos', clock = now } = {}) {
    this.db = db;
    this.photoDir = photoDir;
    this.clock = clock;
    this._inserts = this._prepareInserts();
    // node:sqlite 没有 better-sqlite3 的 transaction()，这里补一个等价物：
    // 返回事务函数，嵌套时用 SAVEPOINT，异常回滚。
    if (typeof db.transaction !== 'function') {
      db.transaction = (fn) => (...args) => {
        const depth = (db._txDepth ||= 0);
        const sp = `sp_${depth}`;
        if (depth === 0) db.exec('BEGIN IMMEDIATE');
        else db.exec(`SAVEPOINT ${sp}`);
        db._txDepth = depth + 1;
        try {
          const out = fn(...args);
          if (depth === 0) db.exec('COMMIT');
          else db.exec(`RELEASE SAVEPOINT ${sp}`);
          db._txDepth = depth;
          return out;
        } catch (e) {
          if (depth === 0) db.exec('ROLLBACK');
          else db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
          db._txDepth = depth;
          throw e;
        }
      };
    }
  }

  _prepareInserts() {
    const run = (sql) => this.db.prepare(sql);
    return {
      log: run(`INSERT INTO audit_log (id, entity, entity_id, action, actor, actor_role, detail, created_at)
                VALUES (?,?,?,?,?,?,?,?)`),
    };
  }

  log(entity, entityId, action, actor, actorRole, detail) {
    this._inserts.log.run(uid('log'), entity, entityId, action, actor || null, actorRole || null,
      detail ? JSON.stringify(detail) : null, this.clock());
  }

  // ---------- 基础查询 ----------
  getModel(id) { return this.db.prepare('SELECT * FROM car_models WHERE id=?').get(id); }
  getVehicle(id) { return this.db.prepare('SELECT * FROM vehicles WHERE id=?').get(id); }
  getStaff(id) { return this.db.prepare('SELECT * FROM staff WHERE id=?').get(id); }
  getCustomer(id) { return this.db.prepare('SELECT * FROM customers WHERE id=?').get(id); }
  getReservation(id) { return this.db.prepare('SELECT * FROM reservations WHERE id=?').get(id); }
  getReservationByCode(code) { return this.db.prepare('SELECT * FROM reservations WHERE code=?').get(code); }
  requireReservation(id) {
    const r = this.getReservation(id);
    if (!r) throw new DomainError('预约不存在', 'not_found', 404);
    return r;
  }
  getRoute(id) { return this.db.prepare('SELECT * FROM routes WHERE id=?').get(id); }

  requireStaff(staffId, roles = null) {
    const s = this.getStaff(staffId);
    if (!s || !s.active) throw new DomainError('操作员不存在或已停用', 'no_staff', 401);
    if (roles && !roles.includes(s.role)) throw new DomainError('需要相应权限角色', 'forbidden', 403);
    return s;
  }

  requireTransition(r, target) {
    const allowed = TRANSITIONS[r.status] || [];
    if (!allowed.includes(target)) {
      throw new DomainError(`预约当前为「${r.status}」，不能执行该操作（目标状态 ${target}）`, 'bad_transition', 409);
    }
  }

  // 数据权限：普通销售只能操作锁定给自己的预约；主管不受限
  requireOwnerOrSupervisor(staff, r) {
    if (staff.role === 'supervisor') return;
    if (!r.advisor_id) throw new DomainError('该预约尚未锁定顾问，暂不可操作', 'forbidden', 403);
    if (r.advisor_id !== staff.id) throw new DomainError('不能操作其他顾问锁定的预约', 'forbidden', 403);
  }

  // ---------- 客户与驾照核验 ----------
  // 证件信息只留核验摘要，客户用代号标识
  registerCustomer({ code, idNumber, name }) {
    const v = verifyLicense({ idNumber, name });
    const cid = uid('cus');
    this.db.prepare(`INSERT INTO customers
      (id, code, display_name, license_last4, license_status, license_reason, safety_score, created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(cid, code, v.name || name || null, idNumber ? idNumber.slice(-4) : null,
        v.status, v.ok ? null : v.reason, v.safetyScore ?? null, this.clock());
    this.log('customer', cid, 'license_verify', 'system', 'adapter', { code, status: v.status, reason: v.reason });
    return { customerId: cid, verification: v };
  }

  // ---------- 互斥：同一车辆不能存在重叠预约 ----------
  findConflictingReservation(vehicleId, startTs, endTs, excludeId = null) {
    const rows = this.db.prepare(`
      SELECT * FROM reservations
      WHERE vehicle_id = ?
        AND status IN ('approved','dispatched','returned','exception','checked')
        AND start_ts < ? AND end_ts > ?
    `).all(vehicleId, endTs, startTs);
    return rows.find((r) => r.id !== excludeId) || null;
  }

  // 顾问占用：同一名顾问在重叠时段只能有一单（日历展示 + 审核拦截）
  findAdvisorConflict(advisorId, startTs, endTs, excludeId = null) {
    const rows = this.db.prepare(`
      SELECT * FROM reservations
      WHERE advisor_id = ?
        AND status IN ('approved','dispatched','returned','exception','checked')
        AND start_ts < ? AND end_ts > ?
    `).all(advisorId, endTs, startTs);
    return rows.find((r) => r.id !== excludeId) || null;
  }

  // ---------- 创建预约 ----------
  createReservation({ code, modelId, customerId, startTs, endTs, routeId, companion, preferredVehicleId = null }) {
    if (endTs <= startTs) throw new DomainError('结束时间必须晚于开始时间');
    if (endTs - startTs > 6 * 3600_000 && !sameDay(startTs, endTs)) {
      // 跨日允许，但必须走单独审批（见 requestOvernightApproval）
    }
    const model = this.getModel(modelId);
    if (!model) throw new DomainError('车型不存在');
    const customer = this.getCustomer(customerId);
    if (!customer) throw new DomainError('客户不存在');
    if (customer.license_status && customer.license_status !== 'valid') {
      throw new DomainError(`客户驾照核验未通过（${customer.license_status}），不能建立预约`, 'license_invalid');
    }
    if (routeId) {
      const route = this.getRoute(routeId);
      if (!route || !route.active) throw new DomainError('路线不存在或已停用');
    }
    if (preferredVehicleId) {
      const v = this.getVehicle(preferredVehicleId);
      if (!v || v.model_id !== modelId) throw new DomainError('指定车辆不属于该车型');
      const conflict = this.findConflictingReservation(preferredVehicleId, startTs, endTs);
      if (conflict) throw new DomainError('该车辆在所选时段已有重叠预约', 'vehicle_overlap', 409);
      if (v.status !== 'available' && v.status !== 'reserved') {
        throw new DomainError(`车辆当前状态为「${v.status}」，暂不可预约`, 'vehicle_unavailable', 409);
      }
    }
    const id = uid('res');
    this.db.prepare(`INSERT INTO reservations
      (id, code, vehicle_id, requested_model_id, customer_id, route_id, companion,
       start_ts, end_ts, status, created_at, updated_at, version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`)
      .run(id, code, preferredVehicleId, modelId, customerId, routeId || null, companion || null,
        startTs, endTs, 'pending', this.clock(), this.clock());
    this.log('reservation', id, 'create', null, null, { code, modelId });
    return this.getReservation(id);
  }

  // ---------- 预约审核：通过后锁定车辆与销售顾问 ----------
  approveReservation(reservationId, staffId, { advisorId, depositCny } = {}) {
    const staff = this.requireStaff(staffId);
    const r = this.requireReservation(reservationId);
    this.requireTransition(r, 'approved');

    // 硬门槛先行：证件无效直接拒绝（避免被车辆/顾问冲突等次级校验掩盖）
    const customer = this.getCustomer(r.customer_id);
    if (!customer || customer.license_status !== 'valid') {
      throw new DomainError(`客户证件状态为「${customer?.license_status || 'unknown'}」：${customer?.license_reason || '未核验'}，不能通过`, 'license_invalid', 412);
    }

    // 跨日试驾必须先有主管的单独审批记录（预约自身门槛，先于派车）
    if (!sameDay(r.start_ts, r.end_ts)) {
      const ov = this.db.prepare(
        `SELECT * FROM overnight_approvals WHERE reservation_id=? AND status='approved'`).get(r.id);
      if (!ov) throw new DomainError('跨日试驾必须先创建单独的跨日审批记录', 'overnight_required', 412);
    }

    // 锁定顾问并检查顾问占用
    const advisor = this.requireStaff(advisorId, ['advisor', 'supervisor']);
    const advConflict = this.findAdvisorConflict(advisorId, r.start_ts, r.end_ts, r.id);
    if (advConflict) throw new DomainError(`顾问在该时段已有预约 ${advConflict.code}`, 'advisor_overlap', 409);

    // 选择车辆：优先预约已指定车辆，否则在同车型里挑一辆可用车
    let vehicleId = r.vehicle_id;
    if (!vehicleId) {
      const v = this._pickAvailableVehicle(r.requested_model_id, r.start_ts, r.end_ts);
      if (!v) throw new DomainError('该车型在所选时段没有可用试驾车', 'no_vehicle', 409);
      vehicleId = v.id;
    }
    const vehicle = this.getVehicle(vehicleId);
    if (!vehicle || vehicle.model_id !== r.requested_model_id) throw new DomainError('车辆与车型不符');

    // 再次校验时段互斥
    const conflict = this.findConflictingReservation(vehicleId, r.start_ts, r.end_ts, r.id);
    if (conflict) throw new DomainError(`车辆时段冲突：与预约 ${conflict.code} 重叠`, 'vehicle_overlap', 409);
    if (vehicle.status !== 'available' && vehicle.status !== 'reserved') {
      throw new DomainError(`车辆状态为「${vehicle.status}」，不能锁定`, 'vehicle_unavailable', 409);
    }
    if (vehicle.condition_flag !== 'none') {
      throw new DomainError('车辆存在未清除的车况异常，需主管复核后方可预约', 'vehicle_condition', 409);
    }

    // 付款适配器：押金
    const model = this.getModel(r.requested_model_id);
    const amount = depositCny ?? model.deposit_cny;
    const pay = chargeDeposit({ reservationCode: r.code, amountCny: amount });
    if (!pay.ok) throw new DomainError(`押金收取失败：${pay.reason}`, 'payment_failed', 402);

    const t = this.clock();
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE reservations SET
          status='approved', vehicle_id=?, advisor_id=?, approved_by=?, approved_at=?,
          deposit_txn=?, deposit_amount_cny=?, reject_reason=NULL, updated_at=?, version=version+1
        WHERE id=?`)
        .run(vehicleId, advisorId, staffId, t, pay.transactionNo, amount, t, r.id);
      this.db.prepare(`UPDATE vehicles SET status='reserved', updated_at=? WHERE id=?`)
        .run(t, vehicleId);
    });
    tx();
    this.log('reservation', r.id, 'approve', staffId, staff.role,
      { vehicleId, advisorId, txn: pay.transactionNo });
    return this.getReservation(r.id);
  }

  rejectReservation(reservationId, staffId, reason) {
    const staff = this.requireStaff(staffId);
    const r = this.requireReservation(reservationId);
    this.requireTransition(r, 'rejected');
    this.db.prepare(`UPDATE reservations SET status='rejected', reject_reason=?, updated_at=?, version=version+1 WHERE id=?`)
      .run(reason || '未通过审核', this.clock(), r.id);
    this.log('reservation', r.id, 'reject', staffId, staff.role, { reason });
    return this.getReservation(r.id);
  }

  // 跨日试驾：单独审批记录（主管权限）
  requestOvernightApproval(reservationId, staffId, { reason, riskNote, depositExtraCny = 0 } = {}) {
    const supervisor = this.requireStaff(staffId, ['supervisor']);
    const r = this.requireReservation(reservationId);
    if (sameDay(r.start_ts, r.end_ts)) {
      throw new DomainError('该预约为当日试驾，无需跨日审批');
    }
    const exists = this.db.prepare(
      `SELECT id FROM overnight_approvals WHERE reservation_id=? AND status='approved'`).get(r.id);
    if (exists) throw new DomainError('该预约已有有效的跨日审批', 'duplicate', 409);
    const id = uid('ovn');
    this.db.prepare(`INSERT INTO overnight_approvals
      (id, reservation_id, approver_id, approver_role, reason, risk_note, deposit_extra_cny, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, r.id, staffId, supervisor.role, reason || null, riskNote || null, depositExtraCny, 'approved', this.clock());
    this.log('overnight', id, 'approve', staffId, supervisor.role, { reservation: r.code });
    return this.db.prepare('SELECT * FROM overnight_approvals WHERE id=?').get(id);
  }

  _pickAvailableVehicle(modelId, startTs, endTs) {
    const candidates = this.db.prepare(
      `SELECT * FROM vehicles WHERE model_id=? AND status='available' AND condition_flag='none' ORDER BY plate`)
      .all(modelId);
    for (const v of candidates) {
      if (!this.findConflictingReservation(v.id, startTs, endTs)) return v;
    }
    return null;
  }

  // ---------- 迟到释放（进程内定时任务 + 手工触发共用） ----------
  // 超过预约开始时间 graceMinutes 分钟仍未出车 -> 释放车辆与顾问
  releaseLateReservations(graceMinutes = 15) {
    const t = this.clock();
    const rows = this.db.prepare(`
      SELECT * FROM reservations
      WHERE status='approved' AND start_ts + ? < ?
    `).all(graceMinutes * 60000, t);
    const released = [];
    for (const r of rows) {
      released.push(this._releaseOne(r, 'late', `迟到超过 ${graceMinutes} 分钟，自动释放`));
    }
    return released;
  }

  _releaseOne(r, reasonType, note) {
    const vehicleId = r.vehicle_id;
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE reservations SET status='released', reject_reason=?, updated_at=?, version=version+1 WHERE id=?`)
        .run(note, this.clock(), r.id);
      if (vehicleId) this._tryMakeVehicleAvailable(vehicleId);
      if (r.deposit_txn) {
        refundDeposit(r.deposit_txn); // 模拟退款
      }
    });
    tx();
    this.log('reservation', r.id, 'release', 'scheduler', 'system', { reasonType, note });
    return this.getReservation(r.id);
  }

  // 若车辆没有其他占用预约，恢复 available
  _tryMakeVehicleAvailable(vehicleId) {
    const occupied = this.db.prepare(`
      SELECT COUNT(*) AS n FROM reservations
      WHERE vehicle_id=? AND status IN ('approved','dispatched','returned','exception','checked')
    `).get(vehicleId).n;
    if (occupied === 0) {
      this.db.prepare(`UPDATE vehicles SET status='available', updated_at=? WHERE id=? AND status!='blocked'`)
        .run(this.clock(), vehicleId);
    }
  }

  // ---------- 临时换车型 / 改派车辆 ----------
  // 已通过但未出车的预约可换车；换车型必须重新审核；换同车型车辆改派后仍有效
  reassignVehicle(reservationId, staffId, { newVehicleId, newModelId = null } = {}) {
    const staff = this.requireStaff(staffId, ['advisor', 'supervisor']);
    const r = this.requireReservation(reservationId);
    if (!['approved', 'pending'].includes(r.status)) {
      throw new DomainError('仅未出车的预约可以换车', 'bad_transition', 409);
    }
    const targetModelId = newModelId || r.requested_model_id;
    const targetModel = this.getModel(targetModelId);
    if (!targetModel) throw new DomainError('目标车型不存在');

    let target;
    if (newVehicleId) {
      target = this.getVehicle(newVehicleId);
      if (!target || target.model_id !== targetModelId) throw new DomainError('目标车辆与车型不符');
      if (target.condition_flag !== 'none') throw new DomainError('目标车辆存在车况异常', 'vehicle_condition', 409);
    } else {
      target = this._pickAvailableVehicle(targetModelId, r.start_ts, r.end_ts);
      if (!target) throw new DomainError('目标车型在该时段无可用车辆', 'no_vehicle', 409);
    }
    const conflict = this.findConflictingReservation(target.id, r.start_ts, r.end_ts, r.id);
    if (conflict) throw new DomainError(`目标车辆与预约 ${conflict.code} 时段重叠`, 'vehicle_overlap', 409);

    const changedModel = targetModelId !== r.requested_model_id;
    const oldVehicleId = r.vehicle_id;
    const t = this.clock();
    const tx = this.db.transaction(() => {
      if (changedModel) {
        // 换车型：车辆与顾问锁定全部解除，回到待审核
        this.db.prepare(`UPDATE reservations SET
            requested_model_id=?, vehicle_id=?, advisor_id=NULL, approved_by=NULL, approved_at=NULL,
            reassigned_from_vehicle_id=?, status='pending', deposit_txn=NULL, updated_at=?, version=version+1
          WHERE id=?`)
          .run(targetModelId, target.id, oldVehicleId || r.reassigned_from_vehicle_id, t, r.id);
      } else {
        // 同车型改派：保持审核通过，锁定新车
        this.db.prepare(`UPDATE reservations SET
            vehicle_id=?, reassigned_from_vehicle_id=?, updated_at=?, version=version+1 WHERE id=?`)
          .run(target.id, oldVehicleId, t, r.id);
        this.db.prepare(`UPDATE vehicles SET status='reserved', updated_at=? WHERE id=?`).run(t, target.id);
      }
      if (oldVehicleId && oldVehicleId !== target.id) this._tryMakeVehicleAvailable(oldVehicleId);
    });
    tx();
    this.log('reservation', r.id, 'reassign', staffId, staff.role,
      { from: oldVehicleId, to: target.id, changedModel });
    return this.getReservation(r.id);
  }

  // ---------- 出车清单：核对证件、里程、油量 ----------
  dispatch(reservationId, staffId, { odometerKm = null, fuelPct = null, photos = null, companion = null } = {}) {
    const staff = this.requireStaff(staffId, ['advisor', 'supervisor']);
    const r = this.requireReservation(reservationId);
    this.requireTransition(r, 'dispatched');

    if (staffId !== r.advisor_id && staff.role !== 'supervisor') {
      throw new DomainError('只有被锁定的顾问本人（或主管）可以发车', 'forbidden', 403);
    }
    const customer = this.getCustomer(r.customer_id);
    if (!customer || customer.license_status !== 'valid') {
      throw new DomainError('证件无效或未核验，不能出车', 'license_invalid', 412);
    }
    const vehicle = this.getVehicle(r.vehicle_id);
    if (!vehicle) throw new DomainError('未锁定车辆');
    if (vehicle.condition_flag !== 'none') {
      throw new DomainError('车辆车况异常未清除，禁止出车', 'vehicle_condition', 412);
    }

    // 里程/油量：适配器读数优先，允许人工录入校正
    const tel = readTelemetry(vehicle);
    const odo = odometerKm == null ? tel.odometerKm : Number(odometerKm);
    const fuel = fuelPct == null ? tel.fuelPct : Number(fuelPct);
    if (odo < vehicle.last_odometer_km - 0.01) {
      throw new DomainError(`出车里程 ${odo} 小于车上次记录 ${vehicle.last_odometer_km}，里程不连续`, 'odometer_gap', 409);
    }
    const model = this.getModel(vehicle.model_id);
    const lowFuel = fuel < model.low_fuel_threshold_pct;

    // 出车前四个方位照片必须齐全
    const photoSet = photos || {};
    const missing = ['front', 'rear', 'left', 'right'].filter((p) => !photoSet[p]);
    if (missing.length) throw new DomainError(`缺少出车车身照片：${missing.join('、')}`, 'photo_missing', 412);

    // “两名顾问同时发车只接受一次”：所有校验通过后，在同一事务内做一次性 CAS 更新
    const t0 = this.clock();
    let casChanges = 0;
    const tx = this.db.transaction(() => {
      const cas = this.db.prepare(`
        UPDATE reservations SET status='dispatched',
          dispatched_at=?, dispatch_odometer_km=?, dispatch_fuel_pct=?,
          route_start_ts=?, companion=COALESCE(?, companion), updated_at=?, version=version+1
        WHERE id=? AND status='approved'
      `).run(t0, odo, fuel, t0, companion ?? null, t0, r.id);
      casChanges = cas.changes;
      if (casChanges !== 1) throw new DomainError('该预约已经发车，不能重复发车（只接受一次）', 'double_dispatch', 409);
      this.db.prepare(`UPDATE vehicles SET status='out', last_odometer_km=?, last_fuel_pct=?, updated_at=? WHERE id=?`)
        .run(odo, fuel, t0, vehicle.id);
      this._addConditionVersion({
        vehicleId: vehicle.id, reservationId: r.id, kind: 'dispatch',
        odometerKm: odo, fuelPct: fuel, photos: photoSet,
        note: lowFuel ? `出车低油量 ${fuel}%` : '出车车况正常', createdBy: staffId, role: staff.role,
      });
    });
    tx();
    this.log('reservation', r.id, 'dispatch', staffId, staff.role, { odo, fuel, lowFuel });
    const out = this.getReservation(r.id);
    return { reservation: out, lowFuelWarning: lowFuel, thresholdPct: model.low_fuel_threshold_pct };
  }

  _addConditionVersion({ vehicleId, reservationId, kind, odometerKm, fuelPct, newDamages, mechanicalIssue, photos, note, createdBy, role }) {
    const seqRow = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM condition_versions WHERE vehicle_id=?').get(vehicleId);
    const id = uid('ver');
    this.db.prepare(`INSERT INTO condition_versions
      (id, vehicle_id, reservation_id, seq, kind, odometer_km, fuel_pct, new_damages, mechanical_issue, photos, note, created_by, created_by_role, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, vehicleId, reservationId || null, seqRow.seq, kind,
        odometerKm ?? null, fuelPct ?? null,
        newDamages ? JSON.stringify(newDamages) : null, mechanicalIssue || null,
        photos ? JSON.stringify(photos) : null, note || null, createdBy || null, role || null, this.clock());
    return id;
  }

  // ---------- 路线计时 ----------
  endRoute(reservationId, staffId) {
    const staff = this.requireStaff(staffId, ['advisor', 'supervisor']);
    const r = this.requireReservation(reservationId);
    this.requireOwnerOrSupervisor(staff, r);
    if (r.status !== 'dispatched') throw new DomainError('只有在试驾途中才能结束路线计时', 'bad_transition', 409);
    if (!r.route_start_ts) throw new DomainError('尚未开始计时');
    if (r.route_end_ts) throw new DomainError('路线计时已结束');
    const endTs = this.clock();
    const mins = minutesBetween(r.route_start_ts, endTs);
    const model = this.getModel(r.requested_model_id);
    const planned = r.route_id ? this.getRoute(r.route_id)?.planned_minutes : model.max_route_minutes;
    const overtime = planned != null && mins > planned;
    this.db.prepare(`UPDATE reservations SET route_end_ts=?, route_minutes=?, route_overtime_flag=?, updated_at=?, version=version+1 WHERE id=?`)
      .run(endTs, mins, overtime ? 1 : 0, endTs, r.id);
    this.log('reservation', r.id, 'route_end', staffId, staff.role, { mins, planned, overtime });
    return { reservation: this.getReservation(r.id), minutes: mins, plannedMinutes: planned, overtime };
  }

  // ---------- 回店：补录结束里程 ----------
  returnVehicle(reservationId, staffId, { odometerKm, fuelPct } = {}) {
    const staff = this.requireStaff(staffId, ['advisor', 'supervisor']);
    const r = this.requireReservation(reservationId);
    this.requireTransition(r, 'returned');
    this.requireOwnerOrSupervisor(staff, r);
    const vehicle = this.getVehicle(r.vehicle_id);

    const tel = readTelemetry(vehicle);
    const odo = Number(odometerKm);
    const fuel = fuelPct == null ? tel.fuelPct : Number(fuelPct);
    if (!(odo >= r.dispatch_odometer_km - 0.01)) {
      throw new DomainError(`回店里程 ${odo} 小于出车里程 ${r.dispatch_odometer_km}，里程不连续`, 'odometer_gap', 409);
    }
    const model = this.getModel(vehicle.model_id);
    const lowFuel = fuel < model.low_fuel_threshold_pct;
    const t = this.clock();

    // 若路线未手动结束，此处自动结束
    let routeMins = r.route_minutes;
    let overtime = !!r.route_overtime_flag;
    if (!r.route_end_ts && r.route_start_ts) {
      routeMins = minutesBetween(r.route_start_ts, t);
      const planned = r.route_id ? this.getRoute(r.route_id)?.planned_minutes : model.max_route_minutes;
      overtime = planned != null && routeMins > planned;
    }

    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE reservations SET
          status='returned', returned_at=?, return_odometer_km=?, return_fuel_pct=?,
          low_fuel_flag=?, route_end_ts=COALESCE(route_end_ts,?), route_minutes=COALESCE(route_minutes,?),
          route_overtime_flag=?, updated_at=?, version=version+1
        WHERE id=?`)
        .run(t, odo, fuel, lowFuel ? 1 : 0, t, routeMins, overtime ? 1 : 0, t, r.id);
      this.db.prepare(`UPDATE vehicles SET status='checking', last_odometer_km=?, last_fuel_pct=?, updated_at=? WHERE id=?`)
        .run(odo, fuel, t, vehicle.id);
    });
    tx();
    this.log('reservation', r.id, 'return', staffId, staff.role, { odo, fuel, lowFuel, routeMins, overtime });
    return { reservation: this.getReservation(r.id), lowFuel, overtime, minutes: routeMins };
  }

  // ---------- 回车对照：新损伤 / 照片差异 / 车辆故障 / 事故报备 ----------
  checkIn(reservationId, staffId, payload = {}) {
    const staff = this.requireStaff(staffId, ['advisor', 'supervisor']);
    const r = this.requireReservation(reservationId);
    if (r.status !== 'returned') throw new DomainError('请先登记回店里程再做回车对照', 'bad_transition', 409);
    this.requireOwnerOrSupervisor(staff, r);
    const vehicle = this.getVehicle(r.vehicle_id);
    const {
      afterPhotos = {}, newDamages = [], mechanicalIssue = null,
      incident = null, // {reported: bool, note}
      note = null,
    } = payload;

    // 回店四个方位照片也必须齐全（沿车身四个方位固定照片位置）
    const missing = ['front', 'rear', 'left', 'right'].filter((p) => !afterPhotos[p]);
    if (missing.length) throw new DomainError(`缺少回店车身照片：${missing.join('、')}`, 'photo_missing', 412);

    const hasDamage = Array.isArray(newDamages) && newDamages.length > 0;
    const hasMechanical = !!mechanicalIssue;
    const hasIncident = incident && incident.reported;
    const abnormal = Boolean(hasDamage || hasMechanical || hasIncident);

    const t = this.clock();
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE reservations SET status=?, updated_at=?, version=version+1 WHERE id=?`)
        .run(abnormal ? 'exception' : 'checked', t, r.id);
      if (hasIncident) {
        this.db.prepare(`UPDATE reservations SET incident_reported_at=?, incident_note=? WHERE id=?`)
          .run(t, incident.note || '客户/顾问报备事故', r.id);
      }
      // 车辆置为异常或待留观清洁
      const flag = hasIncident ? 'damage' : hasDamage ? 'damage' : hasMechanical ? 'mechanical' : 'none';
      this.db.prepare(`UPDATE vehicles SET status=?, condition_flag=?, condition_note=?, updated_at=? WHERE id=?`)
        .run(abnormal ? 'blocked' : 'observation', flag === 'none' ? 'none' : flag,
          abnormal ? (incident?.note || mechanicalIssue || JSON.stringify(newDamages)) : null, t, vehicle.id);
      this._addConditionVersion({
        vehicleId: vehicle.id, reservationId: r.id,
        kind: hasIncident ? 'incident' : 'return',
        odometerKm: r.return_odometer_km, fuelPct: r.return_fuel_pct,
        newDamages: hasDamage ? newDamages : null,
        mechanicalIssue: hasMechanical ? mechanicalIssue : null,
        photos: afterPhotos, note, createdBy: staffId, role: staff.role,
      });
    });
    tx();
    this.log('reservation', r.id, 'checkin', staffId, staff.role,
      { hasDamage, hasMechanical, hasIncident, abnormal });
    return { reservation: this.getReservation(r.id), abnormal, needsSupervisorReview: abnormal };
  }

  // 普通销售在回车对照时发现异常，但不能自行清除；显式拒绝
  clearConditionAttempt(vehicleId, staffId) {
    const staff = this.requireStaff(staffId);
    if (staff.role !== 'supervisor') {
      this.log('vehicle', vehicleId, 'clear_condition_denied', staffId, staff.role, {});
      throw new DomainError('普通销售不能清除车况异常，须主管在事故复核中确认', 'forbidden', 403);
    }
    throw new DomainError('请通过事故复核流程给出结论', 'bad_transition', 409);
  }

  // ---------- 事故复核：主管确认结论 ----------
  reviewIncident(reservationId, supervisorId, { conclusion, damageConfirmed = [], clearCondition = false, note = null } = {}) {
    const sup = this.requireStaff(supervisorId, ['supervisor']);
    const r = this.requireReservation(reservationId);
    if (!['exception', 'checked'].includes(r.status)) throw new DomainError('该预约没有待复核的异常', 'bad_transition', 409);
    const vehicle = this.getVehicle(r.vehicle_id);
    const allowed = ['customer_fault', 'store_fault', 'third_party', 'no_fault'];
    if (!allowed.includes(conclusion)) throw new DomainError('事故结论无效');

    const id = uid('rev');
    const t = this.clock();
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO incident_reviews
        (id, reservation_id, vehicle_id, supervisor_id, conclusion, damage_confirmed, clear_condition, note, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, r.id, vehicle.id, supervisorId, conclusion, JSON.stringify(damageConfirmed),
          clearCondition ? 1 : 0, note, t);
      this.db.prepare(`UPDATE reservations SET status='checked', updated_at=?, version=version+1 WHERE id=?`).run(t, r.id);
      if (clearCondition) {
        // 主管确认无责/无需维修：清除异常，进入留观+清洁收尾
        this.db.prepare(`UPDATE vehicles SET condition_flag='none', condition_note=NULL, status='observation', updated_at=? WHERE id=?`)
          .run(t, vehicle.id);
        this._addConditionVersion({
          vehicleId: vehicle.id, reservationId: r.id, kind: 'supervisor_clear',
          odometerKm: r.return_odometer_km, fuelPct: r.return_fuel_pct,
          note: `主管复核：${conclusion}，清除异常`, createdBy: supervisorId, role: 'supervisor',
        });
      } else {
        // 维持 blocked，等待维修；车辆不可再约
        this.db.prepare(`UPDATE vehicles SET status='blocked', condition_note=COALESCE(condition_note,?), updated_at=? WHERE id=?`)
          .run(note, t, vehicle.id);
      }
    });
    tx();
    this.log('incident', id, 'review', supervisorId, 'supervisor',
      { reservation: r.code, conclusion, clearCondition });
    return this.db.prepare('SELECT * FROM incident_reviews WHERE id=?').get(id);
  }

  // 主管确认损伤属实并维持封锁后，维修完工由此解除：清除异常，回到留观→清洁流程
  resolveRepair(vehicleId, supervisorId, { note = null } = {}) {
    const sup = this.requireStaff(supervisorId, ['supervisor']);
    const vehicle = this.getVehicle(vehicleId);
    if (!vehicle) throw new DomainError('车辆不存在');
    if (vehicle.condition_flag === 'none') throw new DomainError('该车辆没有未结案的车况异常');
    const t = this.clock();
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE vehicles SET condition_flag='none', condition_note=NULL, status='observation', updated_at=? WHERE id=?`)
        .run(t, vehicleId);
      this._addConditionVersion({
        vehicleId, reservationId: null, kind: 'supervisor_clear',
        odometerKm: vehicle.last_odometer_km, fuelPct: vehicle.last_fuel_pct,
        note: `维修完工，主管解除封锁${note ? '：' + note : ''}`, createdBy: supervisorId, role: 'supervisor',
      });
    });
    tx();
    this.log('vehicle', vehicleId, 'repair_resolved', supervisorId, 'supervisor', { note });
    return this.getVehicle(vehicleId);
  }

  // ---------- 违章留观 ----------
  // 回车对照完成后开启留观，观察期结束由进程内任务自动释放；之后仍需清洁
  startObservation(reservationId, staffId, { hours = 24 } = {}) {
    const staff = this.requireStaff(staffId, ['advisor', 'supervisor']);
    const r = this.requireReservation(reservationId);
    if (r.status !== 'checked') throw new DomainError('只有完成回车对照的预约才能进入违章留观', 'bad_transition', 409);
    this.requireOwnerOrSupervisor(staff, r);
    if (r.observation_until) throw new DomainError('已在留观中', 'duplicate', 409);
    const until = this.clock() + hours * 3600_000;
    this.db.prepare(`UPDATE reservations SET observation_until=?, updated_at=? WHERE id=?`).run(until, this.clock(), r.id);
    this.db.prepare(`UPDATE vehicles SET status='observation', updated_at=? WHERE id=?`).run(until, r.vehicle_id);
    this.log('reservation', r.id, 'observation_start', staffId, staff.role, { until });
    return this.getReservation(r.id);
  }

  // 定时任务：结束到期留观（车辆进入待清洁）
  expireObservations() {
    const t = this.clock();
    const rows = this.db.prepare(`
      SELECT * FROM reservations
      WHERE status='checked' AND observation_until IS NOT NULL
        AND observation_released_at IS NULL AND observation_until <= ?
    `).all(t);
    for (const r of rows) {
      this.db.prepare(`UPDATE reservations SET observation_released_at=?, updated_at=? WHERE id=?`)
        .run(t, t, r.id);
      const v = this.getVehicle(r.vehicle_id);
      if (v && v.condition_flag === 'none') {
        this.db.prepare(`UPDATE vehicles SET status='cleaning', updated_at=? WHERE id=?`).run(t, v.id);
      }
      this.log('reservation', r.id, 'observation_end', 'scheduler', 'system', {});
    }
    return rows.map((r) => r.id);
  }

  // ---------- 清洁 ----------
  markCleaned(vehicleId, staffId) {
    const staff = this.requireStaff(staffId, ['advisor', 'supervisor']);
    const vehicle = this.getVehicle(vehicleId);
    if (!vehicle) throw new DomainError('车辆不存在');
    if (vehicle.condition_flag !== 'none') {
      throw new DomainError('车况异常未清除，清洁后也不能上线', 'vehicle_condition', 409);
    }
    // 必须所有留观结束
    const pending = this.db.prepare(`
      SELECT COUNT(*) AS n FROM reservations
      WHERE vehicle_id=? AND status='checked' AND observation_until IS NOT NULL AND observation_released_at IS NULL
    `).get(vehicleId).n;
    if (pending > 0) throw new DomainError('违章留观尚未结束，不能完成清洁', 'observation_open', 409);

    const t = this.clock();
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE vehicles SET status='available', updated_at=? WHERE id=?`).run(t, vehicleId);
      this.db.prepare(`UPDATE reservations SET cleaned_at=? WHERE vehicle_id=? AND cleaned_at IS NULL`)
        .run(t, vehicleId);
    });
    tx();
    this.log('vehicle', vehicleId, 'cleaned', staffId, staff.role, {});
    return this.getVehicle(vehicleId);
  }

  // 车辆完成全部周转（留观+清洁）后才能再次预约——可用车辆判断
  isBookable(vehicle) {
    return vehicle.status === 'available' && vehicle.condition_flag === 'none';
  }

  // ---------- 照片登记 ----------
  addPhoto({ vehicleId, reservationId, position, kind, filePath, contentType, sizeBytes, uploadedBy }) {
    const id = uid('pho');
    this.db.prepare(`INSERT INTO photos
      (id, vehicle_id, reservation_id, position, kind, file_path, content_type, size_bytes, uploaded_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, vehicleId, reservationId || null, position, kind, filePath, contentType || null,
        sizeBytes || 0, uploadedBy || null, this.clock());
    return this.db.prepare('SELECT * FROM photos WHERE id=?').get(id);
  }

  // ---------- 聚合视图 ----------
  board() {
    const models = this.db.prepare('SELECT * FROM car_models WHERE active=1 ORDER BY category, code').all();
    const vehicles = this.db.prepare('SELECT * FROM vehicles ORDER BY model_id, plate').all();
    return models.map((m) => ({
      ...m,
      vehicles: vehicles.filter((v) => v.model_id === m.id).map((v) => ({ ...v, bookable: this.isBookable(v) })),
    }));
  }

  // 日历：某日的车辆占用 + 顾问占用
  calendar(dayStartTs, dayEndTs) {
    const rs = this.db.prepare(`
      SELECT r.*, v.plate AS vehicle_plate, v.name AS vehicle_name, vm.name AS model_name,
             s.name AS advisor_name, c.code AS customer_code
      FROM reservations r
      LEFT JOIN vehicles v ON v.id = r.vehicle_id
      LEFT JOIN car_models vm ON vm.id = r.requested_model_id
      LEFT JOIN staff s ON s.id = r.advisor_id
      LEFT JOIN customers c ON c.id = r.customer_id
      WHERE r.start_ts < ? AND r.end_ts > ?
      ORDER BY r.start_ts
    `).all(dayEndTs, dayStartTs);
    const vehicles = this.db.prepare(`SELECT v.*, m.name AS model_name FROM vehicles v JOIN car_models m ON m.id=v.model_id ORDER BY m.code, v.plate`).all();
    const advisors = this.db.prepare(`SELECT * FROM staff WHERE active=1 AND role IN ('advisor','supervisor') ORDER BY role, name`).all();
    return { reservations: rs, vehicles, advisors };
  }

  pendingApprovals() {
    return this.db.prepare(`
      SELECT r.*, m.name AS model_name, c.code AS customer_code,
             (SELECT COUNT(*) FROM overnight_approvals o WHERE o.reservation_id=r.id AND o.status='approved') AS overnight_ok
      FROM reservations r
      JOIN car_models m ON m.id=r.requested_model_id
      JOIN customers c ON c.id=r.customer_id
      WHERE r.status='pending'
      ORDER BY r.start_ts
    `).all();
  }

  reservationDetail(id) {
    const r = this.db.prepare(`
      SELECT r.*, m.name AS model_name, m.code AS model_code,
             v.plate AS vehicle_plate, v.name AS vehicle_name, v.condition_flag,
             s.name AS advisor_name, c.code AS customer_code, c.license_status,
             ro.name AS route_name
      FROM reservations r
      JOIN car_models m ON m.id=r.requested_model_id
      JOIN customers c ON c.id=r.customer_id
      LEFT JOIN vehicles v ON v.id=r.vehicle_id
      LEFT JOIN staff s ON s.id=r.advisor_id
      LEFT JOIN routes ro ON ro.id=r.route_id
      WHERE r.id=?`).get(id);
    if (!r) return null;
    r.versions = this.db.prepare(
      'SELECT * FROM condition_versions WHERE vehicle_id=? ORDER BY seq').all(r.vehicle_id);
    r.photos = this.db.prepare('SELECT * FROM photos WHERE reservation_id=? ORDER BY kind, position').all(id);
    r.overnight = this.db.prepare('SELECT * FROM overnight_approvals WHERE reservation_id=?').all(id);
    r.incident_reviews = this.db.prepare('SELECT * FROM incident_reviews WHERE reservation_id=? ORDER BY created_at').all(id);
    return r;
  }

  // 数据权限：销售只能看到自己被锁定的预约；主管看全部
  listForStaff(staffId) {
    const s = this.getStaff(staffId);
    if (!s) throw new DomainError('操作员不存在', 'no_staff', 401);
    const base = `
      SELECT r.*, m.name AS model_name, v.plate AS vehicle_plate, s.name AS advisor_name, c.code AS customer_code
      FROM reservations r
      JOIN car_models m ON m.id=r.requested_model_id
      JOIN customers c ON c.id=r.customer_id
      LEFT JOIN vehicles v ON v.id=r.vehicle_id
      LEFT JOIN staff s ON s.id=r.advisor_id`;
    // 销售可见：自己负责的预约 + 待审核池（可看不可操作他人单）；主管看全部
    if (s.role === 'supervisor') {
      return this.db.prepare(`${base} ORDER BY r.start_ts DESC`).all();
    }
    return this.db.prepare(
      `${base} WHERE r.advisor_id=? OR r.status='pending' ORDER BY r.start_ts DESC`).all(staffId);
  }
}
