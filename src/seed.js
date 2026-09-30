'use strict';
// 虚构种子数据：人员、车型、车辆、客户代号、路线，以及冲突 / 事故 / 迟到 / 留观样例。
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const S = require('./store');
const { uid, nowISO, addMinutes } = require('./util');
const { carSVG } = require('./car-art');
const photosMod = require('./photos');

const t = (min) => addMinutes(nowISO(), min);

function resetStorage() {
  db.close();
  for (const f of [db.DB_PATH, db.DB_PATH + '-wal', db.DB_PATH + '-shm']) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(db.PHOTO_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(db.DATA_DIR, '.seeded'), { force: true });
}

function runSeed({ quiet = false } = {}) {
  db.open();
  const d = db.get();
  const count = d.prepare('SELECT COUNT(*) AS n FROM staff').get().n;
  if (count > 0) { if (!quiet) console.log('已存在数据，跳过种子。'); return; }

  const say = (...a) => { if (!quiet) console.log(...a); };

  // ---------- 员工 ----------
  const staffRows = [
    { id: 'st_super', code: 'SL001', name: '邵澜', role: 'supervisor', phone: '138-0000-0001' },
    { id: 'st_lin',   code: 'LC002', name: '林澈', role: 'advisor', phone: '138-0000-0002' },
    { id: 'st_shen',  code: 'SM003', name: '沈眉', role: 'advisor', phone: '138-0000-0003' },
    { id: 'st_han',   code: 'HJ004', name: '韩竞', role: 'advisor', phone: '138-0000-0004' },
  ];
  for (const s of staffRows) S.staff.insert({ ...s, active: 1, created_at: nowISO() });

  // ---------- 车型 ----------
  const modelRows = [
    { id: 'md_a3', brand: '星澜', name: 'A3 锐行版', segment: '紧凑轿车' },
    { id: 'md_x5', brand: '曜石', name: 'X5 城市版', segment: '中型 SUV' },
    { id: 'md_e7', brand: '云际', name: 'E7 长续航', segment: '纯电轿车' },
    { id: 'md_m8', brand: '岚舟', name: 'M8 家庭版', segment: '中大型 MPV' },
  ];
  for (const m of modelRows) S.models.insert({ ...m, created_at: nowISO() });

  // ---------- 路线 ----------
  const routeRows = [
    { id: 'rt_river', name: '滨江环线', planned_minutes: 35, distance_km: 12.5, note: '城市道路为主，途经两个红绿灯路口' },
    { id: 'rt_park',  name: '产业园高架', planned_minutes: 50, distance_km: 22.0, note: '含一段高架加速体验' },
    { id: 'rt_hill',  name: '东山体验线', planned_minutes: 75, distance_km: 38.0, note: '山路弯多，需主管同意后排长线' },
  ];
  for (const r of routeRows) S.routes.insert(r);

  // ---------- 车辆 ----------
  // colors 仅用于车身示意图
  const vehicleRows = [
    { id: 'vh_001', model_id: 'md_a3', plate: '苏A·TD001', nickname: '小白', year: 2026, status: 'available', mileage: 12380, fuel_pct: 72, condition_flag: 'normal', issue_note: null, color: '#f2f4f8' },
    { id: 'vh_002', model_id: 'md_a3', plate: '苏A·TD002', nickname: '低油量样车', year: 2025, status: 'booked', mileage: 20415, fuel_pct: 9, condition_flag: 'normal', issue_note: null, color: '#2f6bd8' },
    { id: 'vh_101', model_id: 'md_x5', plate: '苏A·TD101', nickname: '大黑', year: 2026, status: 'out', mileage: 18420, fuel_pct: 58, condition_flag: 'normal', issue_note: null, color: '#262b33' },
    { id: 'vh_102', model_id: 'md_x5', plate: '苏A·TD102', nickname: '灰灰', year: 2026, status: 'booked', mileage: 15674, fuel_pct: 64, condition_flag: 'normal', issue_note: null, color: '#8a93a3' },
    { id: 'vh_201', model_id: 'md_e7', plate: '苏A·TD201', nickname: '闪电', year: 2026, status: 'available', mileage: 8320, fuel_pct: 81, condition_flag: 'normal', issue_note: null, color: '#3aa0c9' },
    { id: 'vh_202', model_id: 'md_e7', plate: '苏A·TD202', nickname: '故障留厂', year: 2025, status: 'incident_locked', mileage: 31205, fuel_pct: 47, condition_flag: 'abnormal', issue_note: '【车辆故障】充电后动力偶发中断待主管复核', color: '#6b7280' },
    { id: 'vh_301', model_id: 'md_m8', plate: '苏A·TD301', nickname: '事故待清除', year: 2025, status: 'incident_locked', mileage: 9899, fuel_pct: 53, condition_flag: 'abnormal', issue_note: '事故已确认待整改：左后门钣金维修中', color: '#41506b' },
    { id: 'vh_302', model_id: 'md_m8', plate: '苏A·TD302', nickname: '奶爸车', year: 2026, status: 'watching', mileage: 26158, fuel_pct: 41, condition_flag: 'normal', issue_note: null, color: '#7d5ba6' },
  ];
  for (const v of vehicleRows) {
    const { color, ...row } = v;
    S.vehicles.insert({ ...row, updated_at: nowISO() });
    // 车况基线版本
    S.versions.insert({
      id: uid('ver'), vehicle_id: v.id, version: 1,
      mileage: v.mileage, fuel_pct: v.fuel_pct,
      condition_flag: v.condition_flag, issue_note: v.issue_note,
      source: 'baseline', ref_id: null, photos: null,
      created_by: 'st_super', created_at: addMinutes(nowISO(), -43200),
    });
    v._color = color;
  }

  // ---------- 客户代号（虚构，不存实名） ----------
  const customerRows = [
    { id: 'cu_1', code: 'C-1001', license_no: '320105199001152318', license_valid: 1, license_note: null, pay_fail: 0 },
    { id: 'cu_2', code: 'C-1002', license_no: '320106199207304426', license_valid: 1, license_note: null, pay_fail: 0 },
    { id: 'cu_3', code: 'C-1003', license_no: '320107198812051134', license_valid: 1, license_note: null, pay_fail: 0 },
    { id: 'cu_4', code: 'C-1004', license_no: '32010819950322667X', license_valid: 1, license_note: null, pay_fail: 0 },
    { id: 'cu_5', code: 'C-1005', license_no: '320109199109188821', license_valid: 1, license_note: null, pay_fail: 1 },
    { id: 'cu_6', code: 'C-1006', license_no: '320110199706012245', license_valid: 1, license_note: null, pay_fail: 0 },
    { id: 'cu_7', code: 'C-1007', license_no: '32011119860524999X', license_valid: 1, license_note: '尾号 X 为"证件无效"模拟样本', pay_fail: 0 },
    { id: 'cu_8', code: 'C-1008', license_no: '320112199402113357', license_valid: 1, license_note: null, pay_fail: 0 },
  ];
  for (const c of customerRows) S.customers.insert({ ...c, created_at: addMinutes(nowISO(), -20000) });

  const res = (o) => ({
    id: o.id,
    code: o.code, vehicle_id: o.vehicle_id, model_id: o.model_id,
    advisor_id: o.advisor_id, customer_code: o.customer_code,
    license_no: o.license_no || null, route_id: o.route_id || null,
    companion: o.companion || null,
    start_at: o.start_at, end_at: o.end_at, cross_day: o.cross_day || 0,
    status: o.status, note: o.note || null, reject_reason: o.reject_reason || null,
    late_grace_min: o.late_grace_min ?? 15,
    created_by: o.created_by || 'st_lin', created_at: o.created_at || addMinutes(nowISO(), -120),
    decided_at: o.decided_at || null,
  });
  const pay = (resId, ok) => S.payments.insert({
    id: uid('pay'), reservation_id: resId, amount: 50000,
    status: ok ? 'success' : 'failed',
    provider_ref: ok ? `PAY-MOCK-${Math.floor(100000 + Math.random() * 900000)}` : null,
    raw: JSON.stringify(ok ? { code: 'OK' } : { code: 'INSUFFICIENT_FUND' }),
    created_at: nowISO(),
  });
  const shoot = (resId, phase, side, vh, stamp, damage = false) =>
    photosMod.seedShot(resId, phase, side,
      carSVG({ side, color: vh._color, damage, stamp, plate: vh.plate }), stamp);
  const fourShots = (resId, phase, vh, stampAt, damageSide = null) => {
    for (const side of ['front', 'rear', 'left', 'right'])
      shoot(resId, phase, side, vh, new Date(stampAt).toLocaleString('zh-CN'), side === damageSide);
  };

  // ---------- R1：普通待审核（+60~+150 分钟） ----------
  const r1 = res({
    id: 'vhres_r1', code: 'TD-TODAY-0001', vehicle_id: 'vh_001', model_id: 'md_a3',
    advisor_id: 'st_lin', customer_code: 'C-1001', route_id: 'rt_river', companion: '随车体验员 阿澈',
    start_at: t(60), end_at: t(150), status: 'requested', note: '客户关注低速顿挫与泊车辅助',
  });
  S.reservations.insert(r1);

  // ---------- R2：跨日待审核（必须先走跨日单独审批） ----------
  const r2 = res({
    id: 'vhres_r2', code: 'TD-TOMO-0002', vehicle_id: 'vh_002', model_id: 'md_a3',
    advisor_id: 'st_han', customer_code: 'C-1002', route_id: 'rt_hill',
    start_at: t(26 * 60), end_at: t(50 * 60), cross_day: 1, status: 'requested',
    note: '跨日深度体验申请，客户要求山路+夜景',
  });
  S.reservations.insert(r2);

  // ---------- R3：已出车（路线计时中，出车 60 分钟，计划 35 分钟 → 回车将判超时） ----------
  const vh101 = vehicleRows.find(v => v.id === 'vh_101');
  const r3 = res({
    id: 'vhres_r3', code: 'TD-TODAY-0003', vehicle_id: 'vh_101', model_id: 'md_x5',
    advisor_id: 'st_shen', customer_code: 'C-1003', route_id: 'rt_river', companion: '销售实习生 小温',
    start_at: t(-60), end_at: t(30), status: 'dispatched',
    created_at: t(-90), decided_at: t(-65),
  });
  S.reservations.insert(r3);
  pay(r3.id, true);
  S.dispatches.insert({
    id: 'dp_r3', reservation_id: r3.id, vehicle_id: 'vh_101', advisor_id: 'st_shen',
    companion: '销售实习生 小温', license_checked: 1, license_result: '驾照在有效期内（模拟）', license_valid: 1,
    out_mileage: 18420, out_fuel: 66, low_fuel_alert: 0, route_id: 'rt_river',
    route_started_at: t(-60), route_due_at: t(-25), route_ended_at: null, overtime_minutes: 0,
    end_mileage: null, end_fuel: null, new_damage: null, return_note: null,
    dispatched_at: t(-60), returned_at: null,
  });
  fourShots(r3.id, 'out', vh101, t(-60));
  S.versions.insert({
    id: uid('ver'), vehicle_id: 'vh_101', version: 2, mileage: 18420, fuel_pct: 66,
    condition_flag: 'normal', issue_note: null, source: 'dispatch', ref_id: 'dp_r3',
    photos: JSON.stringify(['front', 'rear', 'left', 'right'].map(s => ({ side: s, path: `/photos/${r3.id}/out/${s}.svg` }))),
    created_by: 'st_shen', created_at: t(-60),
  });

  // ---------- R4：回店留观中（留观 1 分钟后到期，由进程内任务自动结束；清洁未做） ----------
  const vh302 = vehicleRows.find(v => v.id === 'vh_302');
  const r4 = res({
    id: 'vhres_r4', code: 'TD-TODAY-0004', vehicle_id: 'vh_302', model_id: 'md_m8',
    advisor_id: 'st_lin', customer_code: 'C-1004', route_id: 'rt_park',
    start_at: t(-240), end_at: t(-190), status: 'watching',
    created_at: t(-300), decided_at: t(-245),
  });
  S.reservations.insert(r4);
  pay(r4.id, true);
  S.dispatches.insert({
    id: 'dp_r4', reservation_id: r4.id, vehicle_id: 'vh_302', advisor_id: 'st_lin',
    companion: null, license_checked: 1, license_result: '驾照在有效期内（模拟）', license_valid: 1,
    out_mileage: 26110, out_fuel: 55, low_fuel_alert: 0, route_id: 'rt_park',
    route_started_at: t(-240), route_due_at: t(-190), route_ended_at: t(-190), overtime_minutes: 0,
    end_mileage: 26158, end_fuel: 41, new_damage: null, return_note: '车身未见新伤，后排有零食碎屑待清洁',
    dispatched_at: t(-240), returned_at: t(-190),
  });
  fourShots(r4.id, 'out', vh302, t(-240));
  fourShots(r4.id, 'return', vh302, t(-190));
  S.versions.insert({
    id: uid('ver'), vehicle_id: 'vh_302', version: 2, mileage: 26110, fuel_pct: 55,
    condition_flag: 'normal', issue_note: null, source: 'dispatch', ref_id: 'dp_r4', photos: null,
    created_by: 'st_lin', created_at: t(-240),
  });
  S.versions.insert({
    id: uid('ver'), vehicle_id: 'vh_302', version: 3, mileage: 26158, fuel_pct: 41,
    condition_flag: 'normal', issue_note: null, source: 'return', ref_id: 'dp_r4', photos: null,
    created_by: 'st_lin', created_at: t(-190),
  });
  S.watches.insert({
    id: 'vw_r4', reservation_id: r4.id, vehicle_id: 'vh_302',
    starts_at: t(-190), ends_at: t(-1), status: 'observing',
    result_note: null, ended_by: null, created_at: t(-190),
  });
  S.cleanings.insert({
    id: 'cl_r4', reservation_id: r4.id, vehicle_id: 'vh_302',
    status: 'pending', done_by: null, done_at: null, created_at: t(-190),
  });

  // ---------- R5：已通过但迟到（开始 -18 分钟，宽限 15 → 启动后自动释放） ----------
  const r5 = res({
    id: 'vhres_r5', code: 'TD-TODAY-0005', vehicle_id: 'vh_002', model_id: 'md_a3',
    advisor_id: 'st_han', customer_code: 'C-1005', route_id: 'rt_river',
    start_at: t(-18), end_at: t(42), status: 'approved',
    created_at: t(-60), decided_at: t(-30), note: '客户电话称路上堵车',
  });
  S.reservations.insert(r5);
  pay(r5.id, true);

  // ---------- R6 / R7：同车重叠（车辆互斥冲突样例，均待审核） ----------
  const r6 = res({
    id: 'vhres_r6', code: 'TD-TODAY-0006', vehicle_id: 'vh_201', model_id: 'md_e7',
    advisor_id: 'st_lin', customer_code: 'C-1006', route_id: 'rt_park',
    start_at: t(180), end_at: t(270), status: 'requested', note: '冲突样例 A：15:00 档先申请者',
  });
  S.reservations.insert(r6);
  const r7 = res({
    id: 'vhres_r7', code: 'TD-TODAY-0007', vehicle_id: 'vh_201', model_id: 'md_e7',
    advisor_id: 'st_shen', customer_code: 'C-1003', route_id: 'rt_park',
    start_at: t(200), end_at: t(290), status: 'requested', note: '冲突样例 B：与 0006 车辆时段重叠',
    created_at: addMinutes(nowISO(), -100),
  });
  S.reservations.insert(r7);

  // ---------- R8：顾问占用冲突（林澈同时段在另一台车上） ----------
  const r8 = res({
    id: 'vhres_r8', code: 'TD-TODAY-0008', vehicle_id: 'vh_201', model_id: 'md_e7',
    advisor_id: 'st_lin', customer_code: 'C-1002', route_id: 'rt_river',
    start_at: t(70), end_at: t(120), status: 'requested', note: '冲突样例：顾问林澈与 0001 时段重叠（车辆时段空闲，仅拦顾问冲突）',
  });
  S.reservations.insert(r8);

  // ---------- R9：已通过、证件无效客户（出车时将被驾照适配器拦截） ----------
  const r9 = res({
    id: 'vhres_r9', code: 'TD-TODAY-0009', vehicle_id: 'vh_102', model_id: 'md_x5',
    advisor_id: 'st_han', customer_code: 'C-1007', route_id: 'rt_river',
    start_at: t(15), end_at: t(75), status: 'approved',
    created_at: t(-40), decided_at: t(-20), note: '证件无效拦截样例：驾照尾号 X',
  });
  S.reservations.insert(r9);
  pay(r9.id, true);
  fourShots(r9.id, 'out', vehicleRows.find(v => v.id === 'vh_102'), t(-5));

  // ---------- R10：事故已确认待清除（普通销售无权清除异常） ----------
  const vh301 = vehicleRows.find(v => v.id === 'vh_301');
  const r10 = res({
    id: 'vhres_r10', code: 'TD-TODAY-0010', vehicle_id: 'vh_301', model_id: 'md_m8',
    advisor_id: 'st_shen', customer_code: 'C-1008', route_id: 'rt_park',
    start_at: t(-360), end_at: t(-300), status: 'completed',
    created_at: t(-420), decided_at: t(-365),
  });
  S.reservations.insert(r10);
  pay(r10.id, true);
  S.dispatches.insert({
    id: 'dp_r10', reservation_id: r10.id, vehicle_id: 'vh_301', advisor_id: 'st_shen',
    companion: null, license_checked: 1, license_result: '驾照在有效期内（模拟）', license_valid: 1,
    out_mileage: 9870, out_fuel: 68, low_fuel_alert: 0, route_id: 'rt_park',
    route_started_at: t(-360), route_due_at: t(-310), route_ended_at: t(-302), overtime_minutes: 8,
    end_mileage: 9899, end_fuel: 53,
    new_damage: JSON.stringify({ left: '回店照片比对发现左后门凹陷划痕' }),
    return_note: '客户承认地库转弯剐蹭，已报案',
    dispatched_at: t(-360), returned_at: t(-300),
  });
  fourShots(r10.id, 'out', vh301, t(-360));
  fourShots(r10.id, 'return', vh301, t(-300), 'left');
  S.versions.insert({
    id: uid('ver'), vehicle_id: 'vh_301', version: 2, mileage: 9870, fuel_pct: 68,
    condition_flag: 'normal', issue_note: null, source: 'dispatch', ref_id: 'dp_r10', photos: null,
    created_by: 'st_shen', created_at: t(-360),
  });
  S.versions.insert({
    id: uid('ver'), vehicle_id: 'vh_301', version: 3, mileage: 9899, fuel_pct: 53,
    condition_flag: 'abnormal', issue_note: '新损伤待复核：left', source: 'return', ref_id: 'dp_r10', photos: null,
    created_by: 'st_shen', created_at: t(-300),
  });
  S.watches.insert({
    id: 'vw_r10', reservation_id: r10.id, vehicle_id: 'vh_301',
    starts_at: t(-300), ends_at: t(-299), status: 'cleared',
    result_note: '留观期内未查到违章记录', ended_by: 'system', created_at: t(-300),
  });
  S.cleanings.insert({
    id: 'cl_r10', reservation_id: r10.id, vehicle_id: 'vh_301',
    status: 'done', done_by: 'st_lin', done_at: t(-280), created_at: t(-300),
  });
  S.incidents.insert({
    id: 'inc_r10', code: `ACC-${new Date().getFullYear()}-2031`,
    reservation_id: r10.id, vehicle_id: 'vh_301', reporter_id: 'st_shen',
    severity: 'minor',
    description: '【事故报备】回店比对发现新损伤（left）：客户地库转弯剐蹭左后门，已报案',
    status: 'confirmed', conclusion: '邵澜：情况属实，责任客户主责，安排钣金维修后复检',
    confirmed_by: 'st_super', confirmed_at: t(-260), created_at: t(-298),
  });
  S.versions.insert({
    id: uid('ver'), vehicle_id: 'vh_301', version: 4, mileage: 9899, fuel_pct: 53,
    condition_flag: 'abnormal', issue_note: '事故已确认待整改：左后门钣金维修中',
    source: 'incident', ref_id: 'inc_r10', photos: null,
    created_by: 'st_super', created_at: t(-260),
  });

  // ---------- TD202：车辆故障报备，待主管确认 ----------
  S.incidents.insert({
    id: 'inc_202', code: `FLT-${new Date().getFullYear()}-1187`,
    reservation_id: null, vehicle_id: 'vh_202', reporter_id: 'st_lin',
    severity: 'major',
    description: '【车辆故障】今晨点检发现充电后动力偶发中断，仪表报动力系统受限，已留厂停用',
    status: 'reported', conclusion: null, confirmed_by: null, confirmed_at: null,
    created_at: t(-150),
  });
  S.versions.insert({
    id: uid('ver'), vehicle_id: 'vh_202', version: 2, mileage: 31205, fuel_pct: 47,
    condition_flag: 'abnormal', issue_note: '【车辆故障】充电后动力偶发中断待主管复核',
    source: 'incident', ref_id: 'inc_202', photos: null,
    created_by: 'st_lin', created_at: t(-150),
  });

  // 审计起点
  S.audit(null, 'seed.loaded', null, { reservations: 10, vehicles: 8, incidents: 2 });
  say('种子完成：8 台车辆 / 10 条预约 / 2 条事故样例 / 冲突与迟到样例就绪');
}

if (require.main === module) {
  if (process.argv.includes('--reset')) resetStorage();
  runSeed();
  db.close();
}

module.exports = { runSeed, resetStorage };
