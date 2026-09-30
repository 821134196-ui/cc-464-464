'use strict';
const { get } = require('./db');
const { jsonOr } = require('./util');

function one(sql, ...p) { return get().prepare(sql).get(...p); }
function all(sql, ...p) { return get().prepare(sql).all(...p); }
function run(sql, ...p) { return get().prepare(sql).run(...p); }

const staff = {
  list: () => all('SELECT * FROM staff WHERE active=1 ORDER BY role, code'),
  get: (id) => one('SELECT * FROM staff WHERE id=?', id),
  byCode: (code) => one('SELECT * FROM staff WHERE code=?', code),
  insert: (s) => run(`INSERT INTO staff (id,code,name,role,phone,active,created_at)
    VALUES (@id,@code,@name,@role,@phone,@active,@created_at)`, s),
};

const models = {
  list: () => all('SELECT * FROM models ORDER BY brand, name'),
  get: (id) => one('SELECT * FROM models WHERE id=?', id),
  insert: (m) => run(`INSERT INTO models (id,brand,name,segment,created_at)
    VALUES (@id,@brand,@name,@segment,@created_at)`, m),
};

const vehicles = {
  list: () => all(`SELECT v.*, m.brand, m.name AS model_name, m.segment
    FROM vehicles v JOIN models m ON m.id=v.model_id ORDER BY m.brand, m.name, v.plate`),
  get: (id) => one(`SELECT v.*, m.brand, m.name AS model_name, m.segment
    FROM vehicles v JOIN models m ON m.id=v.model_id WHERE v.id=?`, id),
  byModel: (modelId) => all('SELECT * FROM vehicles WHERE model_id=? ORDER BY plate', modelId),
  insert: (v) => run(`INSERT INTO vehicles
    (id,model_id,plate,nickname,year,status,mileage,fuel_pct,condition_flag,issue_note,updated_at)
    VALUES (@id,@model_id,@plate,@nickname,@year,@status,@mileage,@fuel_pct,
            @condition_flag,@issue_note,@updated_at)`, v),
  updateState: (id, fields) => {
    const allowed = ['status', 'mileage', 'fuel_pct', 'condition_flag', 'issue_note'];
    const sets = [], vals = [];
    for (const k of allowed) if (k in fields) { sets.push(`${k}=?`); vals.push(fields[k]); }
    if (!sets.length) return;
    vals.push(new Date().toISOString(), id);
    run(`UPDATE vehicles SET ${sets.join(',')}, updated_at=? WHERE id=?`, ...vals);
  },
};

const customers = {
  list: () => all('SELECT * FROM customers ORDER BY code'),
  get: (id) => one('SELECT * FROM customers WHERE id=?', id),
  byCode: (code) => one('SELECT * FROM customers WHERE code=?', code),
  insert: (c) => run(`INSERT INTO customers (id,code,license_no,license_valid,license_note,pay_fail,created_at)
    VALUES (@id,@code,@license_no,@license_valid,@license_note,@pay_fail,@created_at)`, c),
};

const routes = {
  list: () => all('SELECT * FROM routes ORDER BY planned_minutes'),
  get: (id) => one('SELECT * FROM routes WHERE id=?', id),
  insert: (r) => run(`INSERT INTO routes (id,name,planned_minutes,distance_km,note)
    VALUES (@id,@name,@planned_minutes,@distance_km,@note)`, r),
};

const RES_COLS = `SELECT r.*, m.brand AS model_brand, m.name AS model_name,
  v.plate AS vehicle_plate, s.name AS advisor_name, ro.name AS route_name,
  ro.planned_minutes AS route_minutes
  FROM reservations r
  JOIN models m ON m.id=r.model_id
  JOIN staff s ON s.id=r.advisor_id
  LEFT JOIN vehicles v ON v.id=r.vehicle_id
  LEFT JOIN routes ro ON ro.id=r.route_id`;

function decorate(r) {
  if (!r) return r;
  r.new_damage_obj = jsonOr(r.new_damage_json, null);
  return r;
}

const reservations = {
  get: (id) => get().prepare(`${RES_COLS} WHERE r.id=?`).get(id),
  byCode: (code) => get().prepare(`${RES_COLS} WHERE r.code=?`).get(code),
  list: () => all(`${RES_COLS} ORDER BY r.start_at`),
  listForAdvisor: (advisorId) => all(`${RES_COLS} WHERE r.advisor_id=? ORDER BY r.start_at`, advisorId),
  insert: (r) => run(`INSERT INTO reservations
    (id,code,vehicle_id,model_id,advisor_id,customer_code,license_no,route_id,companion,
     start_at,end_at,cross_day,status,note,reject_reason,late_grace_min,created_by,created_at,decided_at)
    VALUES (@id,@code,@vehicle_id,@model_id,@advisor_id,@customer_code,@license_no,@route_id,@companion,
     @start_at,@end_at,@cross_day,@status,@note,@reject_reason,@late_grace_min,@created_by,@created_at,@decided_at)`, r),
  setStatus: (id, status, extra = {}) => {
    const fields = { status, ...extra };
    const sets = ['status=?'];
    const vals = [status];
    for (const [k, v] of Object.entries(fields)) if (k !== 'status') {
      sets.push(`${k}=?`); vals.push(v);
    }
    vals.push(id);
    run(`UPDATE reservations SET ${sets.join(',')} WHERE id=?`, ...vals);
  },
  /** 在占预约（车辆或顾问维度），excludeId 排除自身 */
  activeOnVehicle: (vehicleId, excludeId = null) => all(
    `${RES_COLS} WHERE r.vehicle_id=? AND r.id IS NOT ?
     AND r.status IN ('approved','dispatched','watching')`, vehicleId, excludeId),
  activeForAdvisor: (advisorId, excludeId = null) => all(
    `${RES_COLS} WHERE r.advisor_id=? AND r.id IS NOT ?
     AND r.status IN ('approved','dispatched','watching')`, advisorId, excludeId),
  pendingApprovals: () => all(`${RES_COLS} WHERE r.status='requested' ORDER BY r.start_at`),
  insertSwap: (sw) => run(`INSERT INTO swaps
    (id,reservation_id,from_vehicle_id,to_vehicle_id,changed_model,approver_id,reason,created_at)
    VALUES (@id,@reservation_id,@from_vehicle_id,@to_vehicle_id,@changed_model,@approver_id,@reason,@created_at)`, sw),
  swapsFor: (resId) => all('SELECT * FROM swaps WHERE reservation_id=? ORDER BY created_at', resId),
};

const approvals = {
  forReservation: (resId) => all('SELECT * FROM approvals WHERE reservation_id=? ORDER BY created_at', resId),
  find: (resId, type) => one('SELECT * FROM approvals WHERE reservation_id=? AND type=?', resId, type),
  insert: (a) => run(`INSERT INTO approvals (id,reservation_id,type,decision,approver_id,note,created_at)
    VALUES (@id,@reservation_id,@type,@decision,@approver_id,@note,@created_at)`, a),
};

const dispatches = {
  byReservation: (resId) => one(`SELECT d.*, ro.name AS route_name, ro.planned_minutes
    FROM dispatches d LEFT JOIN routes ro ON ro.id=d.route_id WHERE d.reservation_id=?`, resId),
  openForVehicle: (vehicleId) => one(
    `SELECT * FROM dispatches WHERE vehicle_id=? AND returned_at IS NULL`, vehicleId),
  openForAdvisor: (advisorId) => one(
    `SELECT * FROM dispatches WHERE advisor_id=? AND returned_at IS NULL`, advisorId),
  open: () => all(`SELECT d.*, r.customer_code, v.plate, s.name AS advisor_name,
    ro.name AS route_name, ro.planned_minutes
    FROM dispatches d
    JOIN reservations r ON r.id=d.reservation_id
    JOIN vehicles v ON v.id=d.vehicle_id
    JOIN staff s ON s.id=d.advisor_id
    LEFT JOIN routes ro ON ro.id=d.route_id
    WHERE d.returned_at IS NULL ORDER BY d.dispatched_at`),
  insert: (d) => run(`INSERT INTO dispatches
    (id,reservation_id,vehicle_id,advisor_id,companion,license_checked,license_result,license_valid,
     out_mileage,out_fuel,low_fuel_alert,route_id,route_started_at,route_due_at,route_ended_at,
     overtime_minutes,end_mileage,end_fuel,new_damage,return_note,dispatched_at,returned_at)
    VALUES (@id,@reservation_id,@vehicle_id,@advisor_id,@companion,@license_checked,@license_result,@license_valid,
     @out_mileage,@out_fuel,@low_fuel_alert,@route_id,@route_started_at,@route_due_at,@route_ended_at,
     @overtime_minutes,@end_mileage,@end_fuel,@new_damage,@return_note,@dispatched_at,@returned_at)`, d),
  finish: (id, f) => {
    const sets = [], vals = [];
    for (const k of ['route_ended_at','overtime_minutes','end_mileage','end_fuel','new_damage','return_note','returned_at']) {
      if (k in f) { sets.push(`${k}=?`); vals.push(f[k]); }
    }
    vals.push(id);
    run(`UPDATE dispatches SET ${sets.join(',')} WHERE id=?`, ...vals);
  },
};

const photos = {
  forReservation: (resId) => all(
    'SELECT * FROM photo_shots WHERE reservation_id=? ORDER BY phase, side', resId),
  find: (resId, phase, side) => one(
    'SELECT * FROM photo_shots WHERE reservation_id=? AND phase=? AND side=?', resId, phase, side),
  upsert: (p) => {
    const existing = photos.find(p.reservation_id, p.phase, p.side);
    if (existing) {
      run('UPDATE photo_shots SET path=?, taken_at=? WHERE id=?', p.path, p.taken_at, existing.id);
      return existing.id;
    }
    return run(`INSERT INTO photo_shots (id,reservation_id,phase,side,path,taken_at)
      VALUES (@id,@reservation_id,@phase,@side,@path,@taken_at)`, p).lastInsertRowid;
  },
};

const watches = {
  get: (id) => one(`SELECT w.*, v.plate, r.customer_code
    FROM violation_watches w JOIN vehicles v ON v.id=w.vehicle_id
    JOIN reservations r ON r.id=w.reservation_id WHERE w.id=?`, id),
  list: () => all(`SELECT w.*, v.plate, r.customer_code, r.advisor_id,
    cl.status AS cleaning_status, cl.done_at AS cleaning_done_at
    FROM violation_watches w JOIN vehicles v ON v.id=w.vehicle_id
    JOIN reservations r ON r.id=w.reservation_id
    LEFT JOIN cleanings cl ON cl.reservation_id=w.reservation_id
    ORDER BY w.status='observing' DESC, w.ends_at`),
  forReservation: (resId) => one('SELECT * FROM violation_watches WHERE reservation_id=?', resId),
  open: () => all(`SELECT w.*, v.plate, r.customer_code FROM violation_watches w
    JOIN vehicles v ON v.id=w.vehicle_id JOIN reservations r ON r.id=w.reservation_id
    WHERE w.status='observing' ORDER BY w.ends_at`),
  due: () => all(`SELECT * FROM violation_watches WHERE status='observing' AND ends_at <= ?`,
    new Date().toISOString()),
  insert: (w) => run(`INSERT INTO violation_watches
    (id,reservation_id,vehicle_id,starts_at,ends_at,status,result_note,ended_by,created_at)
    VALUES (@id,@reservation_id,@vehicle_id,@starts_at,@ends_at,@status,@result_note,@ended_by,@created_at)`, w),
  update: (id, fields) => {
    const sets = [], vals = [];
    for (const k of ['status','result_note','ended_by']) if (k in fields) { sets.push(`${k}=?`); vals.push(fields[k]); }
    if (!sets.length) return;
    vals.push(id);
    run(`UPDATE violation_watches SET ${sets.join(',')} WHERE id=?`, ...vals);
  },
};

const cleanings = {
  forReservation: (resId) => one('SELECT * FROM cleanings WHERE reservation_id=?', resId),
  insert: (c) => run(`INSERT INTO cleanings (id,reservation_id,vehicle_id,status,done_by,done_at,created_at)
    VALUES (@id,@reservation_id,@vehicle_id,@status,@done_by,@done_at,@created_at)`, c),
  complete: (id, staffId) => run('UPDATE cleanings SET status=?, done_by=?, done_at=? WHERE id=?',
    'done', staffId, new Date().toISOString(), id),
};

const incidents = {
  get: (id) => one(`SELECT i.*, v.plate, r.customer_code, s.name AS reporter_name
    FROM incidents i JOIN vehicles v ON v.id=i.vehicle_id
    LEFT JOIN reservations r ON r.id=i.reservation_id
    LEFT JOIN staff s ON s.id=i.reporter_id WHERE i.id=?`, id),
  list: () => all(`SELECT i.*, v.plate, r.customer_code, s.name AS reporter_name,
    c.name AS confirmer_name
    FROM incidents i JOIN vehicles v ON v.id=i.vehicle_id
    LEFT JOIN reservations r ON r.id=i.reservation_id
    LEFT JOIN staff s ON s.id=i.reporter_id
    LEFT JOIN staff c ON c.id=i.confirmed_by
    ORDER BY CASE i.status WHEN 'reported' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END, i.created_at`),
  openForVehicle: (vehicleId) => all(
    `SELECT * FROM incidents WHERE vehicle_id=? AND status IN ('reported','confirmed')`, vehicleId),
  insert: (x) => run(`INSERT INTO incidents
    (id,code,reservation_id,vehicle_id,reporter_id,severity,description,status,conclusion,confirmed_by,confirmed_at,created_at)
    VALUES (@id,@code,@reservation_id,@vehicle_id,@reporter_id,@severity,@description,
     @status,@conclusion,@confirmed_by,@confirmed_at,@created_at)`, x),
  update: (id, fields) => {
    const sets = [], vals = [];
    for (const k of ['status','severity','conclusion','confirmed_by','confirmed_at']) if (k in fields) {
      sets.push(`${k}=?`); vals.push(fields[k]); }
    vals.push(id);
    run(`UPDATE incidents SET ${sets.join(',')} WHERE id=?`, ...vals);
  },
};

const versions = {
  forVehicle: (vehicleId) => all(
    'SELECT * FROM vehicle_condition_versions WHERE vehicle_id=? ORDER BY version', vehicleId),
  latest: (vehicleId) => one(
    'SELECT * FROM vehicle_condition_versions WHERE vehicle_id=? ORDER BY version DESC LIMIT 1', vehicleId),
  nextNo: (vehicleId) => {
    const row = one('SELECT COALESCE(MAX(version),0)+1 AS n FROM vehicle_condition_versions WHERE vehicle_id=?', vehicleId);
    return row.n;
  },
  insert: (ver) => run(`INSERT INTO vehicle_condition_versions
    (id,vehicle_id,version,mileage,fuel_pct,condition_flag,issue_note,source,ref_id,photos,created_by,created_at)
    VALUES (@id,@vehicle_id,@version,@mileage,@fuel_pct,@condition_flag,@issue_note,
            @source,@ref_id,@photos,@created_by,@created_at)`, ver),
};

const payments = {
  insert: (p) => run(`INSERT INTO payments (id,reservation_id,amount,status,provider_ref,raw,created_at)
    VALUES (@id,@reservation_id,@amount,@status,@provider_ref,@raw,@created_at)`, p),
  forReservation: (resId) => all('SELECT * FROM payments WHERE reservation_id=? ORDER BY created_at', resId),
};

function audit(actor, action, target, detail = null) {
  run(`INSERT INTO audit_log (id,actor_id,actor_name,action,target,detail,created_at)
    VALUES (?,?,?,?,?,?,?)`,
    `au_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    actor ? actor.id : 'system', actor ? actor.name : '系统定时任务',
    action, target, typeof detail === 'string' ? detail : JSON.stringify(detail),
    new Date().toISOString());
}

module.exports = {
  one, all, run,
  staff, models, vehicles, customers, routes, reservations, approvals,
  dispatches, photos, watches, cleanings, incidents, versions, payments, audit,
};
