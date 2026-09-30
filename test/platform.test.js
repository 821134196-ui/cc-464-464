'use strict';
// 测试：时段互斥、换车约束、里程连续、异常放行、数据权限
// 每条用例使用独立临时数据目录，互不干扰。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-test-'));
process.env.TD_DATA_DIR = tmpRoot;
process.env.TD_TICK_MS = '999999999';

const db = require('../src/db');
const seed = require('../src/seed');
const svc = require('../src/services');
const S = require('../src/store');
const photos = require('../src/photos');
const { carSVG } = require('../src/car-art');
const { relIso } = require('../src/util');

const SUPER = 'st_super';
const LIN = 'st_lin';   // 顾问 林澈
const SHEN = 'st_shen';  // 顾问 沈眉
const HAN = 'st_han';    // 顾问 韩竞

function reset() {
  seed.resetStorage();
  seed.runSeed({ quiet: true });
}
function code(errOrAny) { return errOrAny && errOrAny.code; }

// 新建一条未来预约（默认 +400 分钟，避开种子样例）
async function makeFuture(over = {}) {
  return svc.createReservation(over.created_by || LIN, {
    model_id: over.model_id || 'md_e7',
    vehicle_id: over.vehicle_id || 'vh_201',
    advisor_id: over.advisor_id || HAN,
    customer_code: over.customer_code || 'C-1001',
    route_id: over.route_id || 'rt_park',
    companion: '测试随车员',
    start_at: over.start_at || relIso(400),
    end_at: over.end_at || relIso(490),
    note: over.note || '',
  });
}
async function approve(id) { return svc.approveReservation(SUPER, id); }
function shootFour(resId, phase = 'out', damageSide = null) {
  const vh = S.vehicles.get(S.reservations.get(resId).vehicle_id);
  for (const side of ['front', 'rear', 'left', 'right'])
    photos.saveShot(resId, phase, side,
      carSVG({ side, color: '#2f6bd8', damage: side === damageSide, plate: vh.plate, stamp: 'test' }));
}

test.beforeEach(() => reset());
test.after(() => { db.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

// ---------------- 1. 时段互斥 ----------------
test('同一车辆不能存在重叠预约：R6 通过后 R7 审核被拒（vehicle_overlap）', async () => {
  await approve('vhres_r6');
  await assert.rejects(() => approve('vhres_r7'), e => code(e) === 'vehicle_overlap');
  // 先申请者不受影响
  assert.equal(S.reservations.get('vhres_r6').status, 'approved');
  assert.equal(S.reservations.get('vhres_r7').status, 'requested');
});

test('同一顾问不能在重叠时段带两单：R1 通过后 R8 审核被拒（advisor_overlap）', async () => {
  await approve('vhres_r1'); // 林澈 +60~+150
  await assert.rejects(() => approve('vhres_r8'), e => code(e) === 'advisor_overlap');
});

test('两名顾问同时发车只接受一次：顾问已有未结束出车单时再次发车被拒', async () => {
  // 沈眉已在驾驶 R3（种子中的未结束出车单）
  const r = await makeFuture({ advisor_id: SHEN, customer_code: 'C-1006' });
  await approve(r.id);
  shootFour(r.id);
  await assert.rejects(() => svc.dispatch(SHEN, r.id),
    e => code(e) === 'double_dispatch_advisor');
});

// ---------------- 2. 换车约束 ----------------
test('同车型换车：顾问可直接换；换车型必须主管审批', async () => {
  // R1 是 A3（vh_001）；vh_002 同为 A3，且与 R1 时段不冲突
  const swapped = await svc.swapVehicle(LIN, 'vhres_r1', 'vh_002', '同车型调换测试');
  assert.equal(swapped.vehicle_id, 'vh_002');

  // 换成 E7（vh_201，不同车型）：普通顾问被权限拦截
  await assert.rejects(() => svc.swapVehicle(LIN, 'vhres_r1', 'vh_201', '想换电轿'),
    e => e.status === 403);
  // 主管但无换车型审批 → 拒绝
  await assert.rejects(() => svc.swapVehicle(SUPER, 'vhres_r1', 'vh_201', '想换电轿'),
    e => code(e) === 'swap_model_required');
  // 主管补审批后成功
  await svc.createSpecialApproval(SUPER, 'vhres_r1', 'swap_model', 'approved', '同意换 E7 体验');
  const again = await svc.swapVehicle(SUPER, 'vhres_r1', 'vh_201', '想换电轿');
  assert.equal(again.model_id, 'md_e7');
});

test('换车不能调入异常车辆', async () => {
  await assert.rejects(() => svc.swapVehicle(LIN, 'vhres_r1', 'vh_202', '调入故障车'),
    e => code(e) === 'target_abnormal');
});

test('跨日试驾没有单独审批记录不能通过审核', async () => {
  await assert.rejects(() => approve('vhres_r2'), e => code(e) === 'cross_day_required');
  await svc.createSpecialApproval(SUPER, 'vhres_r2', 'cross_day', 'approved', '同意跨日，明确过夜停放点');
  const r = await approve('vhres_r2');
  assert.equal(r.status, 'approved');
});

// ---------------- 3. 里程连续 ----------------
test('回店里程小于出车里程：里程不连续被拒（mileage_gap）', async () => {
  const r = await makeFuture();
  await approve(r.id);
  shootFour(r.id);
  const d = await svc.dispatch(HAN, r.id);
  shootFour(r.id, 'return');
  await assert.rejects(() => svc.finishReturn(HAN, r.id, {
    end_mileage: d.out_mileage - 1, end_fuel: 70, damage_sides: [],
  }), e => code(e) === 'mileage_gap');
  // 出车单仍未结束
  assert.equal(S.dispatches.byReservation(r.id).returned_at, null);
});

test('正常回店生成留观+清洁；新损伤立即生成事故单并锁车', async () => {
  const r = await makeFuture();
  await approve(r.id);
  shootFour(r.id);
  const d = await svc.dispatch(HAN, r.id);
  shootFour(r.id, 'return', 'left');
  const out = await svc.finishReturn(HAN, r.id, {
    end_mileage: d.out_mileage + 14, end_fuel: 62,
    damage_sides: ['left'], damage_note: '左后门点状凹陷', severity: 'minor',
    note: '客户承认地库剐蹭',
  });
  assert.equal(out.watch.status, 'observing');
  assert.equal(out.cleaning.status, 'pending');
  const inc = S.incidents.openForVehicle('vh_201');
  assert.equal(inc.length, 1);
  assert.match(inc[0].description, /左后门点状凹陷/);
  const vh = S.vehicles.get('vh_201');
  assert.equal(vh.status, 'incident_locked');
  assert.equal(vh.condition_flag, 'abnormal');
  // 里程已写回车况版本链
  assert.equal(S.versions.latest('vh_201').mileage, d.out_mileage + 14);
});

test('留观结束 + 清洁完成 双条件满足后车辆才恢复可约（无事故场景）', async () => {
  // 种子 R4：留观 1 分钟后到期、清洁待做
  svc.scheduler.tick();
  const w = S.watches.forReservation('vhres_r4');
  assert.equal(w.status, 'cleared');
  assert.equal(w.ended_by, 'system');
  // 仅留观结束：车辆仍 watching
  assert.equal(S.vehicles.get('vh_302').status, 'watching');
  await svc.completeCleaning(LIN, 'vhres_r4');
  assert.equal(S.reservations.get('vhres_r4').status, 'completed');
  assert.equal(S.vehicles.get('vh_302').status, 'available');
});

// ---------------- 4. 异常放行 ----------------
test('存在未结事故的车辆不能通过审核 / 发车', async () => {
  const r = await makeFuture({ vehicle_id: 'vh_301', model_id: 'md_m8', customer_code: 'C-1002' });
  await assert.rejects(() => approve(r.id), e => code(e) === 'vehicle_abnormal');
});

test('普通销售不能确认事故、不能清除车况异常；主管可以', async () => {
  // inc_202 为待确认故障
  await assert.rejects(() => svc.confirmIncident(LIN, 'inc_202', '销售尝试确认'),
    e => e.status === 403);
  await svc.confirmIncident(SUPER, 'inc_202', '动力系统故障属实，停驶检修');
  // 普通销售清除 → 403
  await assert.rejects(() => svc.clearIncident(LIN, 'inc_202', '销售尝试清除'),
    e => e.status === 403);
  assert.equal(S.vehicles.get('vh_202').condition_flag, 'abnormal');
  // 主管清除 → 车辆恢复
  await svc.clearIncident(SUPER, 'inc_202', '更换控制器并复检合格');
  const vh = S.vehicles.get('vh_202');
  assert.equal(vh.condition_flag, 'normal');
  assert.equal(vh.status, 'available');
  assert.equal(S.incidents.get('inc_202').status, 'cleared');
});

test('证件无效：发车瞬间被驾照适配器拦截', async () => {
  const r = await makeFuture({ customer_code: 'C-1007' }); // 驾照尾号 X
  await approve(r.id);
  shootFour(r.id);
  await assert.rejects(() => svc.dispatch(HAN, r.id), e => code(e) === 'license_invalid');
  assert.equal(S.reservations.get(r.id).status, 'approved'); // 未发车
});

test('低油量车辆禁止出车，加油登记后放行', async () => {
  // 先让调度器释放迟到的 R5，释放 vh_002（油量 9%）
  svc.scheduler.tick();
  const r = await makeFuture({
    vehicle_id: 'vh_002', model_id: 'md_a3',
    start_at: relIso(400), end_at: relIso(460),
  });
  await approve(r.id);
  shootFour(r.id);
  await assert.rejects(() => svc.dispatch(HAN, r.id), e => code(e) === 'low_fuel');
  await svc.refuel(HAN, 'vh_002', 90);
  const d = await svc.dispatch(HAN, r.id);
  assert.equal(d.out_fuel, 90);
});

test('四方位照片不齐不能出车', async () => {
  const r = await makeFuture();
  await approve(r.id);
  photos.saveShot(r.id, 'out', 'front', carSVG({ side: 'front', plate: 'TD201' }));
  await assert.rejects(() => svc.dispatch(HAN, r.id), e => code(e) === 'photos_missing');
});

test('模拟支付失败：审核不通过且不锁车', async () => {
  const r = await makeFuture({ customer_code: 'C-1005' }); // pay_fail 样本
  await assert.rejects(() => approve(r.id), e => code(e) === 'payment_failed');
  assert.equal(S.reservations.get(r.id).status, 'requested');
});

// ---------------- 5. 数据权限 ----------------
test('销售顾问只能操作分配给自己的预约（出车/取消/回店均 403）', async () => {
  // R1 锁定顾问为林澈
  await approve('vhres_r1');
  await assert.rejects(() => svc.cancelReservation(HAN, 'vhres_r1', '他人尝试取消'),
    e => e.status === 403);
  await assert.rejects(() => svc.dispatch(HAN, 'vhres_r1'), e => e.status === 403);
  // 主管不受限
  const cancelled = await svc.cancelReservation(SUPER, 'vhres_r1', '主管统筹取消');
  assert.equal(cancelled.status, 'cancelled');
});

test('审批接口仅主管可用', async () => {
  await assert.rejects(() => svc.approveReservation(LIN, 'vhres_r1'), e => e.status === 403);
  await assert.rejects(() => svc.rejectReservation(SHEN, 'vhres_r1', '销售驳回'),
    e => e.status === 403);
});

test('迟到超过宽限未发车：进程内任务自动释放预约与车辆', () => {
  const result = svc.scheduler.tick();
  assert.ok(result.released.includes('TD-TODAY-0005'));
  assert.equal(S.reservations.get('vhres_r5').status, 'released_late');
  // 车辆不再被占用
  assert.equal(S.vehicles.get('vh_002').status, 'available');
});

test('并发双击发车：同车两条请求只有一条成功（DB 部分唯一索引兜底）', async () => {
  const r = await makeFuture();
  await approve(r.id);
  shootFour(r.id);
  const results = await Promise.allSettled([
    svc.dispatch(HAN, r.id),
    svc.dispatch(HAN, r.id),
  ]);
  const fulfilled = results.filter(x => x.status === 'fulfilled');
  const rejected = results.filter(x => x.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(['double_dispatch_vehicle'].includes(rejected[0].reason.code));
  // 只有一条出车单
  assert.equal(S.all('SELECT COUNT(*) AS n FROM dispatches WHERE reservation_id=?', r.id)[0].n, 1);
});

// ---------------- HTTP 全流程 ----------------
test('HTTP 全流程：拍照→发车→回店（新损伤）→主管确认/清除事故', async () => {
  const { createServer } = require('../src/server');
  const server = createServer().listen(0);
  await new Promise(res => server.once('listening', res));
  const port = server.address().port;
  const call = async (method, p, body, actor = SUPER) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(actor ? { 'x-staff-id': actor } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
  try {
    // 用顾问身份新建一条 +6 小时的 E7 预约，主管通过
    let { status, json: r } = await call('POST', '/api/reservations', {
      model_id: 'md_e7', vehicle_id: 'vh_201', advisor_id: HAN,
      customer_code: 'C-1001', route_id: 'rt_park', companion: 'HTTP 测试随车',
      start_at: relIso(360), end_at: relIso(430),
    }, HAN);
    assert.equal(status, 200);
    const rid = r.id;
    ({ status } = await call('POST', `/api/reservations/${rid}/approve`));
    assert.equal(status, 200);

    // 四方位出车照片
    for (const side of ['front', 'rear', 'left', 'right']) {
      const { status: sc } = await call('POST', '/api/photos', {
        reservation_id: rid, phase: 'out', side,
        svg: carSVG({ side, plate: 'TD201', stamp: 'http-out' }),
      }, HAN);
      assert.equal(sc, 200);
    }
    // 非本人顾问发车 → 403
    assert.equal((await call('POST', `/api/reservations/${rid}/dispatch`, {}, SHEN)).status, 403);
    // 锁定顾问发车 → 200
    assert.equal((await call('POST', `/api/reservations/${rid}/dispatch`, {}, HAN)).status, 200);

    // 回店四方位（左侧标损）
    for (const side of ['front', 'rear', 'left', 'right'])
      await call('POST', '/api/photos', {
        reservation_id: rid, phase: 'return', side,
        svg: carSVG({ side, plate: 'TD201', damage: side === 'left', stamp: 'http-return' }),
      }, HAN);

    const vhAfterDispatch = S.vehicles.get('vh_201');
    const fin = await call('POST', `/api/reservations/${rid}/return`, {
      end_mileage: vhAfterDispatch.mileage + 11, end_fuel: 55,
      damage_sides: ['left'], damage_note: 'HTTP 流程：左后门划痕', severity: 'minor',
      note: '流程测试',
    }, HAN);
    assert.equal(fin.status, 200);
    assert.equal(fin.json.watch.status, 'observing');

    // 车辆此时被事故锁定
    assert.equal(S.vehicles.get('vh_201').status, 'incident_locked');
    const inc = S.all(`SELECT * FROM incidents WHERE reservation_id=?`, rid)[0];
    // 销售不能确认
    assert.equal((await call('POST', `/api/incidents/${inc.id}/confirm`, { conclusion: 'x' }, HAN)).status, 403);
    // 主管确认 → 清除
    assert.equal((await call('POST', `/api/incidents/${inc.id}/confirm`, { conclusion: '事故属实，安排维修' })).status, 200);
    assert.equal((await call('POST', `/api/incidents/${inc.id}/clear`, { note: '维修复检合格' })).status, 200);

    // 留观主管提前结束 + 清洁完成 → 车辆恢复
    const watchId = S.watches.forReservation(rid).id;
    assert.equal((await call('POST', `/api/watches/${watchId}/resolve`, { status: 'cleared' })).status, 200);
    assert.equal((await call('POST', `/api/reservations/${rid}/cleaning`, {}, HAN)).status, 200);
    assert.equal(S.vehicles.get('vh_201').status, 'available');
    assert.equal(S.reservations.get(rid).status, 'completed');

    // 回店照片确实落盘到本地目录
    const fs2 = require('node:fs');
    assert.ok(fs2.existsSync(require('node:path').join(require('../src/photos').PHOTO_DIR, rid, 'return', 'left.svg')));
  } finally {
    server.close();
  }
});

// ---------------- HTTP 冒烟：身份头与权限穿透路由 ----------------
test('HTTP 层：身份切换生效，销售身份审批返回 403，主管通过返回 200', async () => {
  const { createServer } = require('../src/server');
  const server = createServer().listen(0);
  await new Promise(res => server.once('listening', res));
  const port = server.address().port;
  const call = (method, p, body, actor) => fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(actor ? { 'x-staff-id': actor } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    const board = await (await call('GET', '/api/board')).json();
    assert.ok(board.groups.length >= 4);

    let res = await call('POST', '/api/reservations/vhres_r1/approve', {}, LIN);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'forbidden');

    res = await call('POST', '/api/reservations/vhres_r1/approve', {}, SUPER);
    assert.equal(res.status, 200);

    // 未登录 → 401
    res = await call('POST', '/api/reservations/vhres_r8/reject', { reason: 'x' }, null);
    assert.equal(res.status, 401);

    // 静态资源与照片可访问
    const home = await call('GET', '/', null);
    assert.equal(home.status, 200);
    const photo = await call('GET', '/photos/vhres_r3/out/front.svg', null);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/svg+xml');
  } finally {
    server.close();
  }
});
