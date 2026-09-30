'use strict';
// 模拟适配器：驾照核验、里程读取、付款。均为虚构实现，不接入真实服务。

// 驾照核验：根据 customers.license_valid 与驾照号尾号规则模拟
async function verifyLicense(customer) {
  await sleep(40 + Math.random() * 80);
  const licenseNo = customer.license_no || '';
  // 尾号 X 模拟"证件无效"样本
  if (licenseNo.toUpperCase().endsWith('X')) {
    return { ok: false, valid: false, reason: '驾照状态异常：已过期或不存在（模拟）', provider: 'mock-dmv' };
  }
  if (customer.license_valid === 0) {
    return { ok: true, valid: false, reason: customer.license_note || '驾照核验未通过（模拟）', provider: 'mock-dmv' };
  }
  if (!/^\d{6,}$/.test(licenseNo.replace(/[A-Za-z]$/, ''))) {
    return { ok: false, valid: false, reason: '证件号格式无法识别（模拟）', provider: 'mock-dmv' };
  }
  return { ok: true, valid: true, reason: '驾照在有效期内（模拟）', provider: 'mock-dmv' };
}

// 里程读取：优先采用车机读数，回传 currentMileage。
// 这里直接回退到数据库当前值，并注入一个极小的"设备噪声"标记，由业务层做连续性校验。
async function readMileage(vehicle) {
  await sleep(30 + Math.random() * 50);
  return {
    ok: true,
    mileage: vehicle.mileage,
    deviceTs: new Date().toISOString(),
    deviceId: `OBD-${vehicle.plate.slice(-4)}`,
  };
}

// 付款：customers.pay_fail=1 模拟失败
async function chargeReservation(customer, amountCents) {
  await sleep(50 + Math.random() * 80);
  if (customer.pay_fail === 1) {
    return {
      ok: true, status: 'failed', amount: amountCents,
      providerRef: null, raw: { code: 'INSUFFICIENT_FUND', msg: '余额不足（模拟）' },
    };
  }
  return {
    ok: true, status: 'success', amount: amountCents,
    providerRef: `PAY${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase(),
    raw: { code: 'OK', msg: '支付成功（模拟）' },
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { verifyLicense, readMileage, chargeReservation };
