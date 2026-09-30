import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, expectError } from './harness.js';

// 1. 时段互斥：同一车辆不能存在重叠预约（建单 / 审批两道拦截）
test('时段互斥：同车重叠预约在审批时被拒绝，相邻时段允许', () => {
  const h = makeHarness();
  const start = h.clock() + 3600_000;
  const r1 = h.book({ code: 'OVERLAP1', vehicle: h.ids.v1, at: start, end: start + 3600_000 });
  h.approve(r1);

  // 完全重叠
  const r2 = h.book({ code: 'OVERLAP2', vehicle: h.ids.v1, at: start + 600_000, end: start + 4200_000 });
  expectError(() => h.approve(r2), 'vehicle_overlap');

  // 恰好衔接（前单 end == 后单 start）允许
  const r3 = h.book({ code: 'OVERLAP3', vehicle: h.ids.v1, at: start + 3600_000, end: start + 5400_000 });
  h.approve(r3, h.ids.sup, { advisor: h.ids.b });
  assert.equal(h.svc.getReservation(r3.id).status, 'approved');

  // 顾问占用：同一顾问同时段带另一辆车也拒绝
  const r4 = h.book({ code: 'OVERLAP4', vehicle: h.ids.v2, at: start + 600_000, end: start + 4200_000 });
  expectError(() => h.approve(r4, h.ids.sup, { advisor: h.ids.a }), 'advisor_overlap');
  // 换另一顾问即可通过
  h.approve(r4, h.ids.sup, { advisor: h.ids.c });
  assert.equal(h.svc.getReservation(r4.id).status, 'approved');
  h.cleanup();
});

// 2. 建单即指定车辆时，pending 状态也参与互斥提示（createReservation 直接拦）
test('时段互斥：建单指定车与已锁定单重叠直接拒绝', () => {
  const h = makeHarness();
  const start = h.clock() + 7200_000;
  const r1 = h.book({ code: 'DIRECT1', vehicle: h.ids.v2, at: start, end: start + 3600_000 });
  h.approve(r1, h.ids.sup, { advisor: h.ids.b });
  expectError(() => h.create({ code: 'DIRECT2', vehicle: h.ids.v2, at: start + 300_000, end: start + 3900_000 }),
    '重叠');
  h.cleanup();
});

// 3. 换车约束：同车型改派保持通过；换车型解除锁定回待审核；目标车冲突拒绝
test('换车：同车型改派 / 换车型重审 / 冲突与异常拦截', () => {
  const h = makeHarness();
  const start = h.clock() + 3600_000;
  const r1 = h.book({ code: 'SWAP1', vehicle: h.ids.v1, at: start, end: start + 2700_000 });
  h.approve(r1);
  assert.equal(h.svc.getReservation(r1.id).vehicle_id, h.ids.v1);

  // 同车型改派到 v2（空闲）→ 仍 approved
  h.svc.reassignVehicle(r1.id, h.ids.a, { newVehicleId: h.ids.v2 });
  assert.equal(h.svc.getReservation(r1.id).status, 'approved');
  assert.equal(h.svc.getReservation(r1.id).vehicle_id, h.ids.v2);
  assert.equal(h.svc.getVehicle(h.ids.v1).status, 'available');

  // 换车型 m2 自动派车 → 回 pending，顾问锁定解除
  const moved = h.svc.reassignVehicle(r1.id, h.ids.a, { newModelId: h.ids.v3 ? 'm2' : 'm2' });
  assert.equal(moved.status, 'pending');
  assert.equal(moved.advisor_id, null);
  assert.equal(moved.requested_model_id, 'm2');

  // 目标车存在车况异常 -> 拒绝
  const r2 = h.book({ code: 'SWAP2', at: start, end: start + 2700_000 });
  h.approve(r2, h.ids.sup, { advisor: h.ids.b });
  expectError(() => h.svc.reassignVehicle(r2.id, h.ids.b, { newVehicleId: h.ids.v5 }), '车况异常');

  // 已发车后不能换车（v2 当前空闲）
  h.advance(61);
  const r3 = h.book({ code: 'SWAP3', vehicle: h.ids.v2, at: h.clock(), end: h.clock() + 2700_000 });
  h.approve(r3, h.ids.sup, { advisor: h.ids.c });
  h.dispatch(r3, null, null, h.ids.c);
  expectError(() => h.svc.reassignVehicle(r3.id, h.ids.c, { newVehicleId: h.ids.v1 }), '未出车');
  h.cleanup();
});

// 4. 里程连续：出车里程不得小于车上次记录；回店里程不得小于出车里程；版本链递增
test('里程连续：出车/回店里程校验与车况版本链', () => {
  const h = makeHarness();
  const r1 = h.book({ code: 'ODO1', vehicle: h.ids.v1 });
  h.approve(r1);
  // v1 上次里程 10000，填 9999 拒绝
  expectError(() => h.dispatch(r1, 9999, 80), '里程不连续');
  // 正常发车 10012.5
  const d = h.dispatch(r1, 10012.5, 80);
  assert.equal(d.reservation.status, 'dispatched');

  h.advance(30);
  // 回店里程倒退拒绝
  expectError(() => h.svc.returnVehicle(r1.id, h.ids.a, { odometerKm: 10010, fuelPct: 70 }), '里程不连续');
  const ret = h.svc.returnVehicle(r1.id, h.ids.a, { odometerKm: 10028.0, fuelPct: 66 });
  assert.equal(ret.reservation.return_odometer_km, 10028);
  assert.equal(ret.lowFuel, false);

  // 版本链 seq 递增
  const versions = h.db.prepare('SELECT seq,kind,odometer_km FROM condition_versions WHERE vehicle_id=? ORDER BY seq').all(h.ids.v1);
  assert.deepEqual(versions.map((v) => v.seq), [1]);
  assert.equal(versions[0].odometer_km, 10012.5);

  // 下一次用车从 10028 起继续，形成跨单连续链
  h.svc.checkIn(r1.id, h.ids.a, {
    afterPhotos: h.photos4(), newDamages: [], mechanicalIssue: null, incident: null,
  });
  h.svc.startObservation(r1.id, h.ids.a, { hours: 0 }); // 0 小时 → 立即到期
  h.svc.expireObservations();
  h.svc.markCleaned(h.ids.v1, h.ids.a);
  assert.equal(h.svc.getVehicle(h.ids.v1).status, 'available');

  const start2 = h.clock() + 3600_000;
  const r2 = h.book({ code: 'ODO2', vehicle: h.ids.v1, at: start2, end: start2 + 2700_000 });
  h.approve(r2, h.ids.sup, { advisor: h.ids.b });
  h.dispatch(r2, 10028, 66, h.ids.b); // 恰好等于上次回店，允许
  const vs2 = h.db.prepare('SELECT seq FROM condition_versions WHERE vehicle_id=? ORDER BY seq').all(h.ids.v1);
  // 出车#1 → 回车对照#2 → 再次出车#3，跨单连续
  assert.deepEqual(vs2.map((v) => v.seq), [1, 2, 3]);
  h.cleanup();
});

// 5. 异常放行：普通销售不能清除车况异常；事故必须主管复核；主管清除/维持两路径
test('异常放行：销售无权清除，主管复核两路径，维修完工解除', () => {
  const h = makeHarness();
  const r1 = h.book({ code: 'INC1', vehicle: h.ids.v3, model: 'm2' });
  h.approve(r1, h.ids.sup, { advisor: h.ids.a });
  h.dispatch(r1, 30000, 70);
  h.advance(40);
  h.svc.returnVehicle(r1.id, h.ids.a, { odometerKm: 30020, fuelPct: 60 });

  // 回车对照上报事故 -> exception + 车辆 blocked
  const ci = h.svc.checkIn(r1.id, h.ids.a, {
    afterPhotos: h.photos4(),
    newDamages: [{ position: 'right', desc: '右后门划痕' }],
    incident: { reported: true, note: '刮擦隔离桩' },
  });
  assert.equal(ci.abnormal, true);
  assert.equal(h.svc.getVehicle(h.ids.v3).status, 'blocked');
  assert.equal(h.svc.getVehicle(h.ids.v3).condition_flag, 'damage');

  // 销售尝试直接清除 -> 403
  expectError(() => h.svc.clearConditionAttempt(h.ids.v3, h.ids.a), 'forbidden');
  // 销售尝试提交事故结论 -> 403（requireStaff 角色校验）
  expectError(() => h.svc.reviewIncident(r1.id, h.ids.a, { conclusion: 'no_fault', clearCondition: true }), 'forbidden');
  // 异常车不能通过新预约审核
  const start2 = h.clock() + 7200_000;
  const r2 = h.book({ code: 'INC2', vehicle: h.ids.v3, model: 'm2', at: start2, end: start2 + 2700_000 });
  expectError(() => h.approve(r2, h.ids.sup, { advisor: h.ids.b }), '车况');

  // 路径 A：主管判定客户责任且不清除 -> 仍 blocked
  h.svc.reviewIncident(r1.id, h.ids.sup, { conclusion: 'customer_fault', clearCondition: false, note: '送修' });
  assert.equal(h.svc.getVehicle(h.ids.v3).status, 'blocked');
  assert.equal(h.svc.getReservation(r1.id).status, 'checked');

  // 维修完工主管解除 -> observation -> 留观到期 -> cleaning -> clean
  h.svc.resolveRepair(h.ids.v3, h.ids.sup, { note: '钣喷完工' });
  assert.equal(h.svc.getVehicle(h.ids.v3).condition_flag, 'none');
  assert.equal(h.svc.getVehicle(h.ids.v3).status, 'observation');
  h.svc.expireObservations();
  assert.equal(h.svc.getVehicle(h.ids.v3).status, 'observation'); // r1 未开过留观
  h.svc.startObservation(r1.id, h.ids.sup, { hours: 0 });
  h.svc.expireObservations();
  assert.equal(h.svc.getVehicle(h.ids.v3).status, 'cleaning');
  h.svc.markCleaned(h.ids.v3, h.ids.sup);
  assert.equal(h.svc.getVehicle(h.ids.v3).status, 'available');

  // 路径 B：主管判定无责并直接清除 -> observation
  const r3 = h.book({ code: 'INC3', vehicle: h.ids.v1 });
  h.approve(r3, h.ids.sup, { advisor: h.ids.c });
  h.dispatch(r3, 10000, 80, h.ids.c);
  h.advance(20);
  h.svc.returnVehicle(r3.id, h.ids.c, { odometerKm: 10010, fuelPct: 75 });
  h.svc.checkIn(r3.id, h.ids.c, {
    afterPhotos: h.photos4(), mechanicalIssue: '刹车异响',
  });
  h.svc.reviewIncident(r3.id, h.ids.sup, { conclusion: 'no_fault', clearCondition: true });
  assert.equal(h.svc.getVehicle(h.ids.v1).status, 'observation');
  assert.equal(h.svc.getVehicle(h.ids.v1).condition_flag, 'none');
  h.cleanup();
});

// 6. 数据权限：销售只见自己的单 + 待审池；不能操作他人单；主管全权
test('数据权限：可见范围与操作归属', () => {
  const h = makeHarness();
  const start = h.clock() + 3600_000;
  const mine = h.book({ code: 'PERM1', vehicle: h.ids.v1, at: start, end: start + 2700_000 });
  h.approve(mine, h.ids.sup, { advisor: h.ids.a });
  const yours = h.book({ code: 'PERM2', vehicle: h.ids.v2, at: start, end: start + 2700_000 });
  h.approve(yours, h.ids.sup, { advisor: h.ids.b });
  const pending = h.book({ code: 'PERM3', at: start + 7200_000, end: start + 9000_000 });

  const listA = h.svc.listForStaff(h.ids.a);
  const codesA = listA.map((r) => r.code);
  assert.ok(codesA.includes('PERM1'));
  assert.ok(!codesA.includes('PERM2'), '销售看不到他人已锁单');
  assert.ok(codesA.includes('PERM3'), '待审核池对销售可见');

  const listSup = h.svc.listForStaff(h.ids.sup).map((r) => r.code);
  assert.ok(listSup.includes('PERM1') && listSup.includes('PERM2'));

  // 顾问乙不能给顾问甲的单发车：先为单补齐照片，再以乙身份尝试
  expectError(() => {
    // 为 mine 构造照片但以乙身份发车
    const map = {};
    for (const pos of ['front', 'rear', 'left', 'right']) {
      const id = `x_${pos}_${mine.id}`;
      h.db.prepare(`INSERT INTO photos (id,vehicle_id,reservation_id,position,kind,file_path,created_at)
                    VALUES (?,?,?,?,?,?,?)`).run(id, mine.vehicle_id, mine.id, pos, 'before', '/tmp/x.svg', h.clock());
      map[pos] = id;
    }
    h.svc.dispatch(mine.id, h.ids.b, { photos: map });
  }, 'forbidden');

  // 甲自己发车成功后，乙不能结束路线 / 回店
  h.dispatch(mine);
  h.advance(10);
  expectError(() => h.svc.endRoute(mine.id, h.ids.b), 'forbidden');
  expectError(() => h.svc.returnVehicle(mine.id, h.ids.b, { odometerKm: 10020 }), 'forbidden');
  // 主管可以操作任意单
  const out = h.svc.returnVehicle(mine.id, h.ids.sup, { odometerKm: 10020, fuelPct: 70 });
  assert.equal(out.reservation.status, 'returned');
  h.cleanup();
});

// 7. 发车一次性：并发/重复发车只接受一次（CAS）
test('发车一次性：重复发车被拒', () => {
  const h = makeHarness();
  const r1 = h.book({ code: 'ONCE1', vehicle: h.ids.v1 });
  h.approve(r1);
  h.dispatch(r1, 10000, 80);
  assert.equal(h.svc.getReservation(r1.id).status, 'dispatched');
  expectError(() => h.dispatch(r1, 10000, 80), 'double_dispatch');
  // 车辆已出，不允许再锁给重叠新单
  const start = h.clock();
  const r2 = h.book({ code: 'ONCE2', vehicle: h.ids.v1, at: start, end: start + 2700_000 });
  expectError(() => h.approve(r2, h.ids.sup, { advisor: h.ids.b }), 'vehicle_overlap');
  h.cleanup();
});

// 8. 迟到释放：超过宽限期自动释放车辆/顾问；释放后可再约；押金退款留痕
test('定时任务：迟到预约自动释放，释放后车辆可约', () => {
  const h = makeHarness();
  // 预约开始时间设在 20 分钟前，已通过
  const r1 = h.book({ code: 'LATE1', vehicle: h.ids.v2, at: h.clock() - 20 * 60000, end: h.clock() + 25 * 60000 });
  h.approve(r1, h.ids.sup, { advisor: h.ids.a });
  assert.equal(h.svc.getVehicle(h.ids.v2).status, 'reserved');

  const released = h.svc.releaseLateReservations(15);
  assert.equal(released.length, 1);
  assert.equal(h.svc.getReservation(r1.id).status, 'released');
  assert.equal(h.svc.getVehicle(h.ids.v2).status, 'available');

  // 再次执行不应重复释放
  assert.equal(h.svc.releaseLateReservations(15).length, 0);

  // 车辆与顾问都可用于新单
  const r2 = h.book({ code: 'LATE2', vehicle: h.ids.v2, at: h.clock(), end: h.clock() + 2700_000 });
  h.approve(r2, h.ids.sup, { advisor: h.ids.a });
  assert.equal(h.svc.getReservation(r2.id).status, 'approved');
  h.cleanup();
});

// 9. 留观到期自动转清洁；未到期不能清洁；清洁后才能再约
test('定时任务：违章留观到期转清洁，清洁是再预约的前置', () => {
  const h = makeHarness();
  const r1 = h.book({ code: 'OBS1', vehicle: h.ids.v2 });
  h.approve(r1);
  h.dispatch(r1, 20000, 60);
  h.advance(35);
  h.svc.returnVehicle(r1.id, h.ids.a, { odometerKm: 20015, fuelPct: 50 });
  h.svc.checkIn(r1.id, h.ids.a, { afterPhotos: h.photos4() });
  h.svc.startObservation(r1.id, h.ids.a, { hours: 2 });

  assert.equal(h.svc.getVehicle(h.ids.v2).status, 'observation');
  // 未到期：清洁拒绝；定时任务什么也不做
  expectError(() => h.svc.markCleaned(h.ids.v2, h.ids.a), '留观');
  assert.deepEqual(h.svc.expireObservations(), []);
  assert.equal(h.svc.getVehicle(h.ids.v2).status, 'observation');

  // 到期后：自动转 cleaning，再人工清洁上线
  h.advance(121);
  const ended = h.svc.expireObservations();
  assert.deepEqual(ended, [r1.id]);
  assert.equal(h.svc.getVehicle(h.ids.v2).status, 'cleaning');
  h.svc.markCleaned(h.ids.v2, h.ids.a);
  assert.equal(h.svc.getVehicle(h.ids.v2).status, 'available');
  h.cleanup();
});

// 10. 跨日审批：跨日单无审批拒绝，主管补审批后通过；当日单无需审批
test('跨日试驾必须有主管单独审批记录', () => {
  const h = makeHarness();
  const day = new Date(h.clock()); day.setHours(18, 0, 0, 0);
  const start = day.getTime();
  const end = start + 16 * 3600_000; // 次日 10:00
  const r1 = h.book({ code: 'NIGHT1', vehicle: h.ids.v1, at: start, end });
  expectError(() => h.approve(r1), 'overnight_required');

  // 销售不能创建跨日审批
  expectError(() => h.svc.requestOvernightApproval(r1.id, h.ids.a, { reason: 'x' }), 'forbidden');
  // 主管审批
  h.svc.requestOvernightApproval(r1.id, h.ids.sup, { reason: '深度体验', riskNote: '指定地库', depositExtraCny: 3000 });
  h.approve(r1);
  assert.equal(h.svc.getReservation(r1.id).status, 'approved');

  // 当日单不需要
  const r2 = h.book({ code: 'DAY1', vehicle: h.ids.v2, at: start + 86400000, end: start + 86400000 + 2700_000 });
  h.approve(r2, h.ids.sup, { advisor: h.ids.b });
  assert.equal(h.svc.getReservation(r2.id).status, 'approved');
  h.cleanup();
});

// 11. 证件无效 / 付款失败 / 低油量 / 超时 / 照片缺失 分别处理
test('边界处理：证件、付款、低油、超时、照片', () => {
  const h = makeHarness();
  // 证件无效客户不能建单（createReservation 即拦截）
  expectError(() => h.create({ customer: h.ids.cinv }), '驾照');
  expectError(() => h.create({ customer: h.ids.cout }), '驾照');
  expectError(() => h.create({ customer: h.ids.cage }), '驾照');

  // 付款失败：预约号末位 9
  const r1 = h.book({ code: 'PAYFAIL9', vehicle: h.ids.v1 });
  expectError(() => h.approve(r1), 'payment_failed');

  // 低油量车 v4(10%，m2 车型)：出车成功但返回低油警告；回店低油标记
  const r2 = h.book({ code: 'LOWFUEL1', vehicle: h.ids.v4, model: 'm2' });
  h.approve(r2, h.ids.sup, { advisor: h.ids.c });
  const d = h.dispatch(r2, 40000, 10, h.ids.c);
  assert.equal(d.lowFuelWarning, true);
  h.advance(30);
  const ret = h.svc.returnVehicle(r2.id, h.ids.c, { odometerKm: 40012, fuelPct: 6 });
  assert.equal(ret.lowFuel, true);

  // 路线超时：rt 计划 40 分钟
  const r3 = h.book({ code: 'OVERTIME1', vehicle: h.ids.v2 });
  h.approve(r3, h.ids.sup, { advisor: h.ids.a });
  h.dispatch(r3, 20000, 60);
  h.advance(46);
  const e = h.svc.endRoute(r3.id, h.ids.a);
  assert.equal(e.overtime, true);
  assert.equal(e.minutes, 46);

  // 照片缺失不能发车 / 不能对照
  const r4 = h.book({ code: 'PHOTO1', vehicle: h.ids.v1 });
  h.approve(r4, h.ids.sup, { advisor: h.ids.b });
  expectError(() => h.svc.dispatch(r4.id, h.ids.b, { odometerKm: 10000, fuelPct: 80, photos: { front: 'a' } }), '照片');
  h.cleanup();
});
