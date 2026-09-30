// HTTP 集成冒烟：完整走一单（审核→发车占位照→计时→回店→对照→留观→清洁）+ 关键拦截
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'td-http-'));
let base, close;

const SUP = 'stf_sup', LIN = 'stf_lin', ZHAO = 'stf_zhao', SU = 'stf_su';

async function call(method, path, { staff, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (staff) h['X-Staff-Id'] = staff;
  let payload;
  if (raw) { payload = raw; }
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers: h, body: payload });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  return { status: res.status, data };
}

test.before(async () => {
  const app = await createApp({
    dbPath: join(dir, 'app.db'), photoDir: join(dir, 'photos'),
    reset: true, scheduler: false,
  });
  const addr = await app.listen(0);
  base = `http://127.0.0.1:${addr.port}`;
  close = () => app.close();
});

test.after(() => { close?.(); try { rmSync(dir, { recursive: true, force: true }); } catch {} });

test('元数据/状态板/日历接口', async () => {
  const meta = await call('GET', '/api/meta');
  assert.equal(meta.status, 200);
  assert.ok(meta.data.models.length >= 4);
  assert.ok(meta.data.staff.some((s) => s.role === 'supervisor'));

  const board = await call('GET', '/api/board');
  assert.equal(board.status, 200);
  assert.ok(board.data.some((m) => m.vehicles.length));
  assert.ok(board.data[0].vehicles[0].bookable !== undefined);

  const cal = await call('GET', '/api/calendar');
  assert.equal(cal.status, 200);
  assert.ok(Array.isArray(cal.data.vehicles) && Array.isArray(cal.data.advisors));
});

test('种子冲突单审批被拒：车辆重叠 / 顾问重叠 / 缺跨日审批 / 付款失败 / 证件无效', async () => {
  const pend = (await call('GET', '/api/reservations?view=pending')).data;
  const byCode = Object.fromEntries(pend.map((r) => [r.code, r]));

  // TD-26093002 指定 X7-02 与 TD-26093001 重叠
  let r = await call('POST', `/api/reservations/${byCode['TD-26093002'].id}/approve`, { staff: SUP, body: { advisorId: ZHAO } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /时段冲突/);

  // TD-26093003 车型不同可派车，但顾问林岚 10:00 已占用
  r = await call('POST', `/api/reservations/${byCode['TD-26093003'].id}/approve`, { staff: SUP, body: { advisorId: LIN } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /顾问/);
  // 换空闲顾问可过
  r = await call('POST', `/api/reservations/${byCode['TD-26093003'].id}/approve`, { staff: SUP, body: { advisorId: SU } });
  assert.equal(r.status, 200);

  // 证件无效
  r = await call('POST', `/api/reservations/${byCode['TD-26093010'].id}/approve`, { staff: SUP, body: { advisorId: ZHAO } });
  assert.equal(r.status, 412);

  // 付款失败（号末位 9）
  r = await call('POST', `/api/reservations/${byCode['TD-26093019'].id}/approve`, { staff: SUP, body: { advisorId: ZHAO } });
  assert.equal(r.status, 402);

  // 跨日缺审批
  r = await call('POST', `/api/reservations/${byCode['TD-26093013'].id}/approve`, { staff: SUP, body: { advisorId: ZHAO } });
  assert.equal(r.status, 412);
});

test('迟到释放定时任务：种子单 TD-26092904 被释放', async () => {
  const before = (await call('GET', '/api/reservations', { staff: SUP })).data
    .find((x) => x.code === 'TD-26092904');
  assert.equal(before.status, 'approved');
  const tick = await call('POST', '/api/scheduler/tick');
  assert.ok(tick.data.releasedLate.includes('TD-26092904'));
  const after2 = (await call('GET', '/api/reservations', { staff: SUP })).data
    .find((x) => x.code === 'TD-26092904');
  assert.equal(after2.status, 'released');
});

test('试驾中订单：非归属顾问不能操作；占位照→发车→回店→对照→留观→清洁全链路', async () => {
  // 种子单 TD-26093005 是赵北在试驾中的 R1-01
  const list = (await call('GET', '/api/reservations', { staff: ZHAO })).data;
  const r5 = list.find((x) => x.code === 'TD-26093005');
  assert.equal(r5.status, 'dispatched');

  // 林岚不是该单顾问，不能结束路线
  let r = await call('POST', `/api/reservations/${r5.id}/route-end`, { staff: LIN });
  assert.equal(r.status, 403);
  // 未登录拒绝
  r = await call('POST', `/api/reservations/${r5.id}/route-end`);
  assert.equal(r.status, 401);
  // 赵北可以结束（已超时 15 分钟以上 vs 50 分钟计划 → 视当时时间，不断言超时）
  r = await call('POST', `/api/reservations/${r5.id}/route-end`, { staff: ZHAO });
  assert.equal(r.status, 200);

  // 回店里程必须递增
  r = await call('POST', `/api/reservations/${r5.id}/return`, { staff: ZHAO, body: { odometerKm: 7000, fuelPct: 70 } });
  assert.equal(r.status, 409);
  r = await call('POST', `/api/reservations/${r5.id}/return`, { staff: ZHAO, body: { odometerKm: 7338.2, fuelPct: 61 } });
  assert.equal(r.status, 200);

  // 回店占位照（四方位 SVG）
  const stub = await call('POST', `/api/reservations/${r5.id}/photos-stub?kind=after`, { staff: ZHAO });
  assert.equal(stub.status, 201);
  assert.deepEqual(Object.keys(stub.data).sort(), ['front', 'left', 'rear', 'right']);
  // 照片可下载
  const fres = await fetch(`${base}/api/photos/${stub.data.front}/file`);
  assert.equal(fres.status, 200);
  assert.match(fres.headers.get('content-type'), /svg/);

  // 无异常对照 → checked
  r = await call('POST', `/api/reservations/${r5.id}/checkin`, {
    staff: ZHAO, body: { afterPhotos: stub.data, newDamages: [] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.abnormal, false);

  // 销售不能清除车况（对当前正常车调用也应 403）
  r = await call('POST', '/api/vehicles/veh_r1_01/clear-condition', { staff: LIN });
  assert.equal(r.status, 403);

  // 留观 0 小时 → tick 结束 → 清洁 → 上线
  r = await call('POST', `/api/reservations/${r5.id}/observation`, { staff: ZHAO, body: { hours: 0 } });
  assert.equal(r.status, 200);
  r = await call('POST', '/api/scheduler/tick');
  assert.ok(r.data.observationsEnded.includes(r5.id));
  r = await call('POST', '/api/vehicles/veh_r1_01/clean', { staff: ZHAO });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'available');

  // 详情包含版本链与时间线数据
  const detail = await call('GET', `/api/reservations/${r5.id}`);
  assert.ok(detail.data.versions.length >= 2);
  assert.ok(detail.data.photos.length >= 8);
});

test('事故样例：销售复核被拒，主管维持封锁后维修结案', async () => {
  const list = (await call('GET', '/api/reservations', { staff: SUP })).data;
  const r7 = list.find((x) => x.code === 'TD-26092907');
  assert.equal(r7.status, 'exception');

  // 销售给结论 → 403
  let r = await call('POST', `/api/reservations/${r7.id}/incident-review`, {
    staff: SU, body: { conclusion: 'no_fault', clearCondition: true },
  });
  assert.equal(r.status, 403);

  // 主管确认客户责任，不清除 → 车辆仍 blocked
  r = await call('POST', `/api/reservations/${r7.id}/incident-review`, {
    staff: SUP, body: { conclusion: 'customer_fault', clearCondition: false, note: '送修钣喷' },
  });
  assert.equal(r.status, 201);
  const board = await call('GET', '/api/board');
  const x703 = board.data.flatMap((m) => m.vehicles).find((v) => v.id === 'veh_x7_03');
  assert.equal(x703.status, 'blocked');
  assert.equal(x703.bookable, false);

  // 销售不能维修结案
  r = await call('POST', '/api/vehicles/veh_x7_03/resolve-repair', { staff: SU, body: {} });
  assert.equal(r.status, 403);
  // 主管结案后异常清除
  r = await call('POST', '/api/vehicles/veh_x7_03/resolve-repair', { staff: SUP, body: { note: '复检合格' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.condition_flag, 'none');
});

test('留观/清洁样例车辆：M8-01 未到期不可清洁，M8-02 可直接清洁上线', async () => {
  // M8-02 留观已到期处于 cleaning
  let r = await call('POST', '/api/vehicles/veh_m8_02/clean', { staff: LIN });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'available');

  // M8-01 留观 12 小时后才到期
  r = await call('POST', '/api/vehicles/veh_m8_01/clean', { staff: LIN });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /留观/);
});
