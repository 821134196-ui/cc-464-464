// 模拟外部适配器：驾照核验 / 里程读数 / 付款
// 全部为虚构数据；真实门店可替换为对应供应商 SDK。

// 驾照核验适配器
// 规则（虚构）：
//   证号以 "X" 开头        -> 无效证件
//   证号以 "E" 开头        -> 已过期
//   出生日期显示年龄<18   -> 未成年
//   其余                   -> 有效；证号末两位作为初始安全分
export function verifyLicense({ idNumber, name }) {
  const normalized = (idNumber || '').toUpperCase().trim();
  if (!/^[A-Z0-9]{6,20}$/.test(normalized)) {
    return { ok: false, status: 'invalid', reason: '证件号码格式不正确', name: name || null };
  }
  if (normalized.startsWith('X')) {
    return { ok: false, status: 'invalid', reason: '证件无效（暂扣/伪造）', name: name || null };
  }
  if (normalized.startsWith('E')) {
    return { ok: false, status: 'expired', reason: '驾照已过期，请先换证', name: name || null };
  }
  // 末位字母映射为年龄，便于样例构造未成年（末位 "Y"）
  if (normalized.endsWith('Y')) {
    return { ok: false, status: 'underage', reason: '申请人未满 18 周岁', name: name || null };
  }
  const scoreBase = parseInt(normalized.slice(-2).replace(/\D/g, ''), 10);
  return {
    ok: true,
    status: 'valid',
    reason: '核验通过',
    name: name || `客户${normalized.slice(0, 4)}`,
    classes: ['C1'],
    safetyScore: Number.isFinite(scoreBase) ? 80 + (scoreBase % 20) : 90,
    checkedAt: Date.now(),
  };
}

// 车载里程/油量读取适配器（虚构）
// 用车辆状态表中已记录的最后读数做基准，叠加请求中的“实测增量”，
// 模拟车机回传；未记录时从车辆初始里程起步。
export function readTelemetry(vehicle, extraKm = 0, fuelDeltaPct = 0) {
  const lastKm = Number(vehicle.last_odometer_km || vehicle.initial_odometer_km || 0);
  const lastFuel = Number.isFinite(Number(vehicle.last_fuel_pct)) ? Number(vehicle.last_fuel_pct) : 80;
  return {
    odometerKm: Math.max(0, lastKm + Number(extraKm || 0)),
    fuelPct: Math.min(100, Math.max(0, lastFuel + Number(fuelDeltaPct || 0))),
    readAt: Date.now(),
    source: 'mock-obd-ii',
  };
}

// 付款适配器（试驾押金/费用，虚构）
//   预约号末位为 "9" -> 余额不足
export function chargeDeposit({ reservationCode, amountCny }) {
  const code = reservationCode || '';
  if (code.endsWith('9')) {
    return { ok: false, status: 'insufficient_funds', reason: '绑定账户余额不足', amountCny, paidAt: null };
  }
  return {
    ok: true,
    status: 'paid',
    reason: '押金冻结成功',
    amountCny,
    transactionNo: `MOCK${code.replace(/\W/g, '').slice(0, 10)}${Date.now().toString(36).slice(-4)}`.toUpperCase(),
    paidAt: Date.now(),
  };
}

export function refundDeposit(transactionNo) {
  return {
    ok: true,
    status: 'refunded',
    transactionNo: transactionNo || null,
    refundedAt: Date.now(),
  };
}
