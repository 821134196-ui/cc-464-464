// 测试夹具：内存 SQLite + 可控时钟 + 最小数据集（不用种子大图）
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../src/db.js';
import { Service, DomainError } from '../src/service.js';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function makeHarness() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  let t = new Date(2026, 8, 30, 9, 0, 0).getTime(); // 2026-09-30 09:00 本地
  const clock = () => t;
  const advance = (minutes) => { t += minutes * 60000; };
  const setTime = (ts) => { t = ts; };

  const photoDir = join(tmpdir(), `td-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(photoDir, { recursive: true });
  const svc = new Service(db, { photoDir, clock });

  const ins = (sql, ...a) => db.prepare(sql).run(...a);

  // 人员
  ins(`INSERT INTO staff (id,name,role,active) VALUES ('stf_sup','周衡','supervisor',1)`);
  ins(`INSERT INTO staff (id,name,role,active) VALUES ('stf_a','顾问甲','advisor',1)`);
  ins(`INSERT INTO staff (id,name,role,active) VALUES ('stf_b','顾问乙','advisor',1)`);
  ins(`INSERT INTO staff (id,name,role,active) VALUES ('stf_c','顾问丙','advisor',1)`);

  // 车型
  ins(`INSERT INTO car_models (id,code,name,category,low_fuel_threshold_pct,max_route_minutes,deposit_cny,active)
       VALUES ('m1','S5','星帆S5','轿车',20,40,2000,1)`);
  ins(`INSERT INTO car_models (id,code,name,category,low_fuel_threshold_pct,max_route_minutes,deposit_cny,active)
       VALUES ('m2','X7','岚岳X7','SUV',25,50,3000,1)`);

  // 车辆
  const mkVeh = (id, model, odo = 10000, fuel = 80, status = 'available') =>
    ins(`INSERT INTO vehicles (id,model_id,plate,name,initial_odometer_km,last_odometer_km,last_fuel_pct,status,condition_flag,updated_at)
         VALUES (?,?,?,?,?,?,?,?,'none',?)`,
      id, model, `沪T·${id.slice(-3)}`, id, odo, odo, fuel, status, t);
  mkVeh('v1', 'm1', 10000, 80);
  mkVeh('v2', 'm1', 20000, 60);
  mkVeh('v3', 'm2', 30000, 70);
  mkVeh('v4', 'm2', 40000, 10); // 低油车
  mkVeh('v5', 'm1', 50000, 80, 'blocked');
  ins(`UPDATE vehicles SET condition_flag='damage' WHERE id='v5'`);

  // 路线
  ins(`INSERT INTO routes (id,name,distance_km,planned_minutes,active) VALUES ('rt','城市线',12,40,1)`);

  const mkCustomer = (code, status = 'valid', reason = null, score = 90) => {
    const id = `cus_${code}`;
    ins(`INSERT INTO customers (id,code,license_status,license_reason,safety_score,created_at)
         VALUES (?,?,?,?,?,?)`, id, code, status, reason, score, t);
    return id;
  };
  const c1 = mkCustomer('C-1');
  const c2 = mkCustomer('C-2');
  const c3 = mkCustomer('C-3');
  const cinv = mkCustomer('C-INV', 'invalid', '证件无效');
  const cout = mkCustomer('C-OUT', 'expired', '已过期');
  const cage = mkCustomer('C-AGE', 'underage', '未成年');

  const PHOTOS = { front: 'p1', rear: 'p2', left: 'p3', right: 'p4' };

  // 建预约并走完“通过”流程
  const book = (opts = {}) => {
    const start = opts.at ?? t;
    const end = opts.end ?? (start + 45 * 60000);
    const id = `res_${Math.random().toString(36).slice(2, 8)}`;
    ins(`INSERT INTO reservations
      (id,code,vehicle_id,requested_model_id,customer_id,advisor_id,route_id,start_ts,end_ts,status,created_at,updated_at,version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      id, opts.code || `T-${id.slice(-6)}`, opts.vehicle ?? null, opts.model ?? 'm1',
      opts.customer ?? c1, null, opts.route ?? 'rt', start, end, 'pending', t, t);
    return svc.getReservation(id);
  };

  // 走完整领域逻辑建单（含证件/车辆互斥校验）
  const create = (opts = {}) => {
    const start = opts.at ?? (t + 3600_000);
    const end = opts.end ?? (start + 45 * 60000);
    return svc.createReservation({
      code: opts.code || `CR-${Math.random().toString(36).slice(2, 8)}`,
      modelId: opts.model ?? 'm1', customerId: opts.customer ?? c1,
      startTs: start, endTs: end, routeId: opts.route ?? 'rt',
      preferredVehicleId: opts.vehicle ?? null,
    });
  };

  const approve = (r, staff = 'stf_sup', extra = {}) =>
    svc.approveReservation(r.id, staff, { advisorId: extra.advisor ?? 'stf_a', depositCny: 1000 });

  const photos4 = () => ({ ...PHOTOS });

  const dispatch = (r, odo = null, fuel = null, staffId = 'stf_a') => {
    // 直接在库里塞照片记录（服务层只校验 id 存在与归属）；id 带随机后缀，允许重复尝试
    const map = {};
    for (const [pos, pid] of Object.entries(PHOTOS)) {
      const id = `${pid}_${r.id}_${Math.random().toString(36).slice(2, 7)}`;
      ins(`INSERT INTO photos (id,vehicle_id,reservation_id,position,kind,file_path,created_at)
           VALUES (?,?,?,?,?,?,?)`, id, r.vehicle_id, r.id, pos, 'before', `/tmp/${id}.svg`, t);
      map[pos] = id;
    }
    return svc.dispatch(r.id, staffId, { odometerKm: odo, fuelPct: fuel, photos: map });
  };

  return {
    db, svc, clock, advance, setTime, photoDir,
    ids: { sup: 'stf_sup', a: 'stf_a', b: 'stf_b', c: 'stf_c',
      v1: 'v1', v2: 'v2', v3: 'v3', v4: 'v4', v5: 'v5',
      c1, c2, c3, cinv, cout, cage, rt: 'rt' },
    book, create, approve, photos4, dispatch,
    cleanup: () => { try { rmSync(photoDir, { recursive: true, force: true }); } catch {} },
  };
}

export function expectError(run, codePart) {
  let threw = false;
  try { run(); } catch (e) {
    threw = true;
    if (codePart && !(e instanceof DomainError || String(e.message).includes(codePart) || e.code === codePart)) {
      throw new Error(`期望包含 ${codePart}，实际: ${e.code} ${e.message}`);
    }
    if (!codePart && !(e instanceof DomainError)) throw e;
    return e;
  }
  if (!threw) throw new Error('期望抛错但成功了');
}
