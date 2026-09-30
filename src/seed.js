// 虚构种子数据：车型 / 试驾车 / 人员 / 路线 / 客户 / 预约（含冲突与事故样例）/ 车身照片
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uid } from './util.js';

// 四方位车身示意 SVG（虚构占位图；damage=true 时叠加新损伤标记）
export function carSvg(position, { damage = false, plate = '沪A·TEST', odo = 0 } = {}) {
  const labels = { front: '车头 FRONT', rear: '车尾 REAR', left: '车身左侧 LEFT', right: '车身右侧 RIGHT' };
  const body = {
    front: `<rect x="150" y="95" width="340" height="180" rx="46" fill="#eef2f7" stroke="#2b2f36" stroke-width="4"/>
      <rect x="205" y="120" width="230" height="70" rx="22" fill="#9fc4ef"/>
      <circle cx="220" cy="285" r="34" fill="#2b2f36"/><circle cx="420" cy="285" r="34" fill="#2b2f36"/>`,
    rear: `<rect x="150" y="95" width="340" height="180" rx="46" fill="#eef2f7" stroke="#2b2f36" stroke-width="4"/>
      <rect x="205" y="190" width="230" height="60" rx="20" fill="#9fc4ef"/>
      <rect x="180" y="110" width="60" height="24" rx="8" fill="#d8483f"/><rect x="400" y="110" width="60" height="24" rx="8" fill="#d8483f"/>
      <circle cx="220" cy="285" r="34" fill="#2b2f36"/><circle cx="420" cy="285" r="34" fill="#2b2f36"/>`,
    left: `<rect x="90" y="150" width="460" height="110" rx="40" fill="#eef2f7" stroke="#2b2f36" stroke-width="4"/>
      <rect x="150" y="165" width="120" height="55" rx="12" fill="#9fc4ef"/><rect x="290" y="165" width="120" height="55" rx="12" fill="#9fc4ef"/>
      <circle cx="170" cy="268" r="34" fill="#2b2f36"/><circle cx="470" cy="268" r="34" fill="#2b2f36"/>`,
    right: `<rect x="90" y="150" width="460" height="110" rx="40" fill="#eef2f7" stroke="#2b2f36" stroke-width="4"/>
      <rect x="150" y="165" width="120" height="55" rx="12" fill="#9fc4ef"/><rect x="290" y="165" width="120" height="55" rx="12" fill="#9fc4ef"/>
      <circle cx="170" cy="268" r="34" fill="#2b2f36"/><circle cx="470" cy="268" r="34" fill="#2b2f36"/>`,
  }[position];
  const mark = damage
    ? `<g><circle cx="430" cy="180" r="26" fill="none" stroke="#e0483f" stroke-width="5"/>
       <line x1="412" y1="162" x2="448" y2="198" stroke="#e0483f" stroke-width="5"/>
       <line x1="448" y1="162" x2="412" y2="198" stroke="#e0483f" stroke-width="5"/>
       <text x="330" y="150" font-family="monospace" font-size="22" fill="#e0483f">新增划痕 28cm</text></g>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
    <rect width="640" height="360" fill="#f7f9fb"/>
    <text x="30" y="46" font-family="sans-serif" font-size="24" font-weight="bold" fill="#1b63d4">${labels[position]}</text>
    <text x="470" y="46" font-family="monospace" font-size="18" fill="#2b2f36">${plate}</text>
    ${body}${mark}
    <text x="30" y="340" font-family="monospace" font-size="16" fill="#5a626c">ODO ${odo.toLocaleString('en-US').padStart(8, '0')} km · 虚构占位照片</text>
  </svg>`;
}

export function seed(db, photoDir, t0 = Date.now()) {
  mkdirSync(photoDir, { recursive: true });
  const dayStart = new Date(t0);
  dayStart.setHours(0, 0, 0, 0);
  const at = (h, m = 0, plusDay = 0) => dayStart.getTime() + plusDay * 86400000 + h * 3600000 + m * 60000;

  const insert = (sql) => db.prepare(sql);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  // ---------- 员工 ----------
  const staff = [
    ['stf_sup', '周衡', 'supervisor', '13800000001'], // 主管
    ['stf_lin', '林岚', 'advisor', '13800000002'],
    ['stf_zhao', '赵北', 'advisor', '13800000003'],
    ['stf_su', '苏南', 'advisor', '13800000004'],
  ];
  for (const [id, name, role, phone] of staff) {
    run(`INSERT INTO staff (id,name,role,phone,active) VALUES (?,?,?,?,1)`, id, name, role, phone);
  }

  // ---------- 车型 ----------
  const models = [
    ['mdl_sedan', 'S5', '星帆 S5', '轿车', '车漆白', 20, 40, 2000],
    ['mdl_suv', 'X7', '岚岳 X7', 'SUV', '深石墨', 25, 50, 3000],
    ['mdl_mpv', 'M8', '云程 M8', 'MPV', '车漆白', 25, 45, 3000],
    ['mdl_sport', 'R1', '赤焰 R1', '性能车', '信号蓝', 30, 35, 5000],
  ];
  for (const [id, code, name, category, color, fuel, mins, dep] of models) {
    run(`INSERT INTO car_models (id,code,name,category,color_name,low_fuel_threshold_pct,max_route_minutes,deposit_cny,active)
         VALUES (?,?,?,?,?,?,?,?,1)`, id, code, name, category, color, fuel, mins, dep);
  }

  // ---------- 车辆 ----------
  const vehicles = [
    // id, model, plate, name, odo, fuel, status, flag
    ['veh_s5_01', 'mdl_sedan', '沪AD·T501', 'S5-01 白', 12840, 68, 'available', 'none'],
    ['veh_s5_02', 'mdl_sedan', '沪AD·T502', 'S5-02 白', 23110, 18, 'available', 'none'],   // 低油样例
    ['veh_s5_03', 'mdl_sedan', '沪AD·T503', 'S5-03 白', 9802, 72, 'available', 'none'],
    ['veh_x7_01', 'mdl_suv', '沪AD·X701', 'X7-01 石墨', 35200, 80, 'available', 'none'],
    ['veh_x7_02', 'mdl_suv', '沪AD·X702', 'X7-02 石墨', 41005, 55, 'reserved', 'none'],
    ['veh_x7_03', 'mdl_suv', '沪AD·X703', 'X7-03 石墨', 18760, 62, 'blocked', 'damage'],   // 事故样例
    ['veh_m8_01', 'mdl_mpv', '沪AD·M801', 'M8-01 白', 56090, 77, 'observation', 'none'],   // 留观样例
    ['veh_m8_02', 'mdl_mpv', '沪AD·M802', 'M8-02 白', 47330, 48, 'cleaning', 'none'],      // 清洁样例
    ['veh_r1_01', 'mdl_sport', '沪AD·R101', 'R1-01 蓝', 7320, 84, 'out', 'none'],          // 试驾中
    ['veh_r1_02', 'mdl_sport', '沪AD·R102', 'R1-02 蓝', 9100, 33, 'checking', 'none'],     // 待回车对照
  ];
  for (const [id, model, plate, name, odo, fuel, status, flag] of vehicles) {
    run(`INSERT INTO vehicles (id,model_id,plate,name,vin,initial_odometer_km,last_odometer_km,last_fuel_pct,status,condition_flag,photo_dir,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, model, plate, name, `LSG${id.toUpperCase()}0000${Math.floor(odo % 1000)}`, odo, odo, fuel, status, flag,
      join(photoDir, id), t0);
    mkdirSync(join(photoDir, id), { recursive: true });
  }

  // ---------- 路线 ----------
  const routes = [
    ['rte_city', '滨江城市环线', 12.5, 40],
    ['rte_park', '科创园舒适线', 9.0, 35],
    ['rte_hill', '西山动力体验线', 18.0, 50],
  ];
  for (const [id, name, km, mins] of routes) {
    run(`INSERT INTO routes (id,name,distance_km,planned_minutes,active) VALUES (?,?,?,?,1)`, id, name, km, mins);
  }

  // ---------- 客户（代号 + 驾照核验摘要，全虚构） ----------
  const mkCustomer = (code, idNumber, status, reason = null, score = null) => {
    const id = uid('cus');
    run(`INSERT INTO customers (id,code,display_name,license_last4,license_status,license_reason,safety_score,created_at)
         VALUES (?,?,?,?,?,?,?,?)`, id, code, `客户${code.slice(-4)}`, idNumber.slice(-4), status, reason, score, t0);
    return id;
  };
  const c1024 = mkCustomer('C-1024', 'SH310101199001010024', 'valid', null, 94);
  const c1025 = mkCustomer('C-1025', 'SH310101199203030025', 'valid', null, 88);
  const c1026 = mkCustomer('C-1026', 'SH310101198807070026', 'valid', null, 91);
  const c1027 = mkCustomer('C-1027', 'X310101199505050027', 'invalid', '证件无效（暂扣/伪造）', null);
  const c1028 = mkCustomer('C-1028', 'SH310101199606060028', 'valid', null, 86);
  const c1029 = mkCustomer('C-1029', 'SH310101199404040029', 'valid', null, 90);
  const c1030 = mkCustomer('C-1030', 'SH310101200101010030', 'valid', null, 82);

  // ---------- 预约 ----------
  const insRes = db.prepare(`INSERT INTO reservations
    (id,code,vehicle_id,requested_model_id,customer_id,advisor_id,route_id,companion,start_ts,end_ts,status,
     approved_by,approved_at,dispatched_at,dispatch_odometer_km,dispatch_fuel_pct,
     returned_at,return_odometer_km,return_fuel_pct,low_fuel_flag,
     route_start_ts,route_end_ts,route_minutes,route_overtime_flag,
     observation_until,observation_released_at,incident_reported_at,incident_note,
     deposit_txn,deposit_amount_cny,created_at,updated_at,version)
    VALUES (@id,@code,@vehicle_id,@requested_model_id,@customer_id,@advisor_id,@route_id,@companion,@start_ts,@end_ts,@status,
     @approved_by,@approved_at,@dispatched_at,@dispatch_odometer_km,@dispatch_fuel_pct,
     @returned_at,@return_odometer_km,@return_fuel_pct,@low_fuel_flag,
     @route_start_ts,@route_end_ts,@route_minutes,@route_overtime_flag,
     @observation_until,@observation_released_at,@incident_reported_at,@incident_note,
     @deposit_txn,@deposit_amount_cny,@created_at,@updated_at,1)`);

  const baseRow = (o) => ({
    id: uid('res'), code: o.code, vehicle_id: o.vehicle ?? null, requested_model_id: o.model,
    customer_id: o.customer, advisor_id: o.advisor ?? null, route_id: o.route ?? null,
    companion: o.companion ?? null, start_ts: o.start, end_ts: o.end, status: o.status,
    approved_by: o.approvedBy ?? null, approved_at: o.approvedAt ?? null,
    dispatched_at: null, dispatch_odometer_km: null, dispatch_fuel_pct: null,
    returned_at: null, return_odometer_km: null, return_fuel_pct: null, low_fuel_flag: 0,
    route_start_ts: null, route_end_ts: null, route_minutes: null, route_overtime_flag: 0,
    observation_until: null, observation_released_at: null,
    incident_reported_at: null, incident_note: null,
    deposit_txn: o.depositTxn ?? null, deposit_amount_cny: o.deposit ?? 0,
    created_at: t0, updated_at: t0,
  });

  const addPhotos = (reservationId, vehicle, plate, kind, odo, withDamage = false) => {
    for (const position of ['front', 'rear', 'left', 'right']) {
      const dir = join(photoDir, vehicle);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${reservationId}_${kind}_${position}.svg`);
      writeFileSync(file, carSvg(position, { damage: withDamage && position === 'right', plate, odo }));
      run(`INSERT INTO photos (id,vehicle_id,reservation_id,position,kind,file_path,content_type,size_bytes,uploaded_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        uid('pho'), vehicle, reservationId, position, kind, file, 'image/svg+xml', 1024, 'stf_lin', t0);
    }
  };

  // 冲突样例锚定到启动时刻之后的下下个半小时档，保证任何时间启动都在未来、不被迟到任务释放
  let slotBase = dayStart.getTime() + (Math.floor((t0 - dayStart.getTime()) / 1800000) + 2) * 1800000;
  if (slotBase + 90 * 60000 > dayStart.getTime() + 20 * 3600000) {
    slotBase = dayStart.getTime() + 86400000 + 10 * 3600000; // 超出今日展示窗口则用次日 10:00
  }

  // 1) 已通过 [slot, slot+60]，占用 X7-02 + 林岚（冲突样例的基准单）
  const r1 = baseRow({
    code: 'TD-26093001', vehicle: 'veh_x7_02', model: 'mdl_suv', customer: c1024,
    advisor: 'stf_lin', route: 'rte_city', companion: '客户配偶随行',
    start: slotBase, end: slotBase + 3600_000, status: 'approved',
    approvedBy: 'stf_sup', approvedAt: slotBase - 90 * 60000, depositTxn: 'MOCKTD26093001AAAA', deposit: 3000,
  });
  insRes.run(r1);

  // 2) 待审核 [slot+30, slot+90] 同车 X7-02 —— 审核时必然提示车辆时段冲突
  const r2 = baseRow({
    code: 'TD-26093002', vehicle: 'veh_x7_02', model: 'mdl_suv', customer: c1025,
    route: 'rte_park', start: slotBase + 1800_000, end: slotBase + 5400_000, status: 'pending',
  });
  insRes.run(r2);

  // 3) 待审核 [slot, slot+45] 顾问林岚重叠 —— 车辆可换但顾问冲突，演示顾问占用
  const r3 = baseRow({
    code: 'TD-26093003', model: 'mdl_sedan', customer: c1026,
    route: 'rte_city', start: slotBase, end: slotBase + 2700_000, status: 'pending',
  });
  insRes.run(r3);

  // 4) 迟到样例：已通过且开始时间已过 15 分钟以上 —— 首跑定时任务即释放
  const lateStart = t0 - 40 * 60000;
  const r4 = baseRow({
    code: 'TD-26092904', vehicle: 'veh_s5_03', model: 'mdl_sedan', customer: c1028,
    advisor: 'stf_su', route: 'rte_park', start: lateStart, end: lateStart + 45 * 60000,
    status: 'approved', approvedBy: 'stf_sup', approvedAt: t0 - 3600000,
    depositTxn: 'MOCKTD26092904BBBB', deposit: 2000,
  });
  insRes.run(r4);

  // 5) 试驾中：R1-01 + 赵北，路线计时进行中（15 分钟前发车）
  const r5 = baseRow({
    code: 'TD-26093005', vehicle: 'veh_r1_01', model: 'mdl_sport', customer: c1029,
    advisor: 'stf_zhao', route: 'rte_hill', companion: '门店体验专员随车',
    start: t0 - 20 * 60000, end: t0 + 25 * 60000, status: 'dispatched',
    approvedBy: 'stf_sup', approvedAt: t0 - 40 * 60000, depositTxn: 'MOCKTD26093005CCCC', deposit: 5000,
  });
  Object.assign(r5, {
    dispatched_at: t0 - 15 * 60000, dispatch_odometer_km: 7320, dispatch_fuel_pct: 84,
    route_start_ts: t0 - 15 * 60000,
  });
  insRes.run(r5);
  addPhotos(r5.id, 'veh_r1_01', '沪AD·R101', 'before', 7320);
  run(`INSERT INTO condition_versions (id,vehicle_id,reservation_id,seq,kind,odometer_km,fuel_pct,photos,note,created_by,created_by_role,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    uid('ver'), 'veh_r1_01', r5.id, 1, 'dispatch', 7320, 84,
    JSON.stringify(['front', 'rear', 'left', 'right']), '出车车况正常', 'stf_zhao', 'advisor', t0 - 15 * 60000);

  // 6) 已回店待对照：R1-02，低油量 + 已超时
  const r6 = baseRow({
    code: 'TD-26093006', vehicle: 'veh_r1_02', model: 'mdl_sport', customer: c1030,
    advisor: 'stf_lin', route: 'rte_hill',
    start: t0 - 80 * 60000, end: t0 - 25 * 60000, status: 'returned',
    approvedBy: 'stf_sup', approvedAt: t0 - 120 * 60000, depositTxn: 'MOCKTD26093006DDDD', deposit: 5000,
  });
  Object.assign(r6, {
    dispatched_at: t0 - 70 * 60000, dispatch_odometer_km: 9100, dispatch_fuel_pct: 33,
    returned_at: t0 - 5 * 60000, return_odometer_km: 9124.6, return_fuel_pct: 12,
    low_fuel_flag: 1, route_start_ts: t0 - 70 * 60000, route_end_ts: t0 - 5 * 60000,
    route_minutes: 65, route_overtime_flag: 1,
  });
  insRes.run(r6);
  addPhotos(r6.id, 'veh_r1_02', '沪AD·R102', 'before', 9100);
  run(`INSERT INTO condition_versions (id,vehicle_id,reservation_id,seq,kind,odometer_km,fuel_pct,photos,note,created_by,created_by_role,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    uid('ver'), 'veh_r1_02', r6.id, 1, 'dispatch', 9100, 33,
    JSON.stringify(['front', 'rear', 'left', 'right']), '出车油量偏低 33%', 'stf_lin', 'advisor', t0 - 70 * 60000);

  // 7) 事故样例：X7-03 回店对照发现右侧划痕 + 报备事故，异常待主管复核
  const r7 = baseRow({
    code: 'TD-26092907', vehicle: 'veh_x7_03', model: 'mdl_suv', customer: c1025,
    advisor: 'stf_su', route: 'rte_city',
    start: at(14, 0, -1), end: at(15, 0, -1), status: 'exception',
    approvedBy: 'stf_sup', approvedAt: at(13, 0, -1), depositTxn: 'MOCKTD26092907EEEE', deposit: 3000,
  });
  Object.assign(r7, {
    dispatched_at: at(14, 0, -1), dispatch_odometer_km: 18742, dispatch_fuel_pct: 62,
    returned_at: at(15, 2, -1), return_odometer_km: 18758.1, return_fuel_pct: 54, low_fuel_flag: 0,
    route_start_ts: at(14, 0, -1), route_end_ts: at(15, 2, -1), route_minutes: 62, route_overtime_flag: 1,
    incident_reported_at: at(15, 5, -1), incident_note: '环岛变道时右后门与隔离桩刮擦，客户报备，无人员受伤',
  });
  insRes.run(r7);
  addPhotos(r7.id, 'veh_x7_03', '沪AD·X703', 'before', 18742);
  addPhotos(r7.id, 'veh_x7_03', '沪AD·X703', 'after', 18758, true);
  run(`INSERT INTO condition_versions (id,vehicle_id,reservation_id,seq,kind,odometer_km,fuel_pct,photos,note,created_by,created_by_role,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    uid('ver'), 'veh_x7_03', r7.id, 1, 'dispatch', 18742, 62,
    JSON.stringify(['front', 'rear', 'left', 'right']), '出车车况正常', 'stf_su', 'advisor', at(14, 0, -1));
  run(`INSERT INTO condition_versions (id,vehicle_id,reservation_id,seq,kind,odometer_km,fuel_pct,new_damages,photos,note,created_by,created_by_role,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    uid('ver'), 'veh_x7_03', r7.id, 2, 'incident', 18758.1, 54,
    JSON.stringify([{ position: 'right', desc: '右后门划痕约 28cm，见底漆' }]),
    JSON.stringify(['front', 'rear', 'left', 'right']),
    '环岛刮擦隔离桩，客户已报备', 'stf_su', 'advisor', at(15, 6, -1));

  // 8) 留观样例：M8-01 已对照完成，留观 12 小时后到期
  const r8 = baseRow({
    code: 'TD-26092908', vehicle: 'veh_m8_01', model: 'mdl_mpv', customer: c1026,
    advisor: 'stf_zhao', route: 'rte_park',
    start: at(9, 0, -1), end: at(10, 0, -1), status: 'checked',
    approvedBy: 'stf_sup', approvedAt: at(8, 0, -1), depositTxn: 'MOCKTD26092908FFFF', deposit: 3000,
  });
  Object.assign(r8, {
    dispatched_at: at(9, 0, -1), dispatch_odometer_km: 56076, dispatch_fuel_pct: 77,
    returned_at: at(10, 3, -1), return_odometer_km: 56090, return_fuel_pct: 70,
    route_start_ts: at(9, 0, -1), route_end_ts: at(10, 3, -1), route_minutes: 63, route_overtime_flag: 1,
    observation_until: t0 + 12 * 3600000,
  });
  insRes.run(r8);

  // 9) 清洁样例：M8-02 留观结束待清洁
  const r9 = baseRow({
    code: 'TD-26092809', vehicle: 'veh_m8_02', model: 'mdl_mpv', customer: c1024,
    advisor: 'stf_lin', route: 'rte_city',
    start: at(15, 0, -2), end: at(16, 0, -2), status: 'checked',
    approvedBy: 'stf_sup', approvedAt: at(14, 0, -2), depositTxn: 'MOCKTD26092809GGGG', deposit: 3000,
  });
  Object.assign(r9, {
    dispatched_at: at(15, 0, -2), dispatch_odometer_km: 47318, dispatch_fuel_pct: 55,
    returned_at: at(16, 5, -2), return_odometer_km: 47330, return_fuel_pct: 48,
    route_start_ts: at(15, 0, -2), route_end_ts: at(16, 5, -2), route_minutes: 65, route_overtime_flag: 1,
    observation_until: t0 - 2 * 3600000, observation_released_at: t0 - 2 * 3600000,
  });
  insRes.run(r9);

  // 10) 证件无效客户的待审核单 —— 审核应被拦截（演示证件无效处理）
  const r10 = baseRow({
    code: 'TD-26093010', model: 'mdl_sedan', customer: c1027,
    route: 'rte_city', start: slotBase + 3600_000, end: slotBase + 6300_000, status: 'pending',
  });
  // 注意：建单接口本身会拒绝无效证件，样例直接落库以呈现“审核环节再次核验”的拦截路径
  insRes.run(r10);

  // 11) 付款失败样例：预约号末位 9，押金适配器返回余额不足
  const r11 = baseRow({
    code: 'TD-26093019', model: 'mdl_suv', customer: c1028,
    route: 'rte_park', start: slotBase + 5400_000, end: slotBase + 8100_000, status: 'pending',
  });
  insRes.run(r11);

  // 12) 跨日试驾：已建跨日审批，待审核通过（开始时间锚定冲突样例当天 18:00，次日 10:00 还车）
  const nightStart = new Date(slotBase); nightStart.setHours(18, 0, 0, 0);
  const nightEnd = new Date(nightStart);
  nightEnd.setDate(nightEnd.getDate() + 1); nightEnd.setHours(10, 0, 0, 0);
  const r12 = baseRow({
    code: 'TD-26093012', model: 'mdl_suv', customer: c1029,
    route: 'rte_hill', companion: '跨日深度体验',
    start: nightStart.getTime(), end: nightEnd.getTime(), status: 'pending',
  });
  insRes.run(r12);
  run(`INSERT INTO overnight_approvals (id,reservation_id,approver_id,approver_role,reason,risk_note,deposit_extra_cny,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    uid('ovn'), r12.id, 'stf_sup', 'supervisor', '客户为高意向置换用户，申请晚间至次日深度体验',
    '夜间停放在指定合作酒店地库，里程上限 120km', 3000, 'approved', t0);

  // 13) 跨日试驾但尚无审批 —— 审核时必须先补跨日审批
  const r13 = baseRow({
    code: 'TD-26093013', model: 'mdl_sport', customer: c1030,
    start: nightStart.getTime(), end: nightEnd.getTime(), status: 'pending',
  });
  insRes.run(r13);

  return { staff: Object.fromEntries(staff.map((s) => [s[1], s[0]])), reservations: { r1: r1.id, r7: r7.id } };
}
