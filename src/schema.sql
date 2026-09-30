-- 试驾车预约与车况交接平台 schema（SQLite）
PRAGMA foreign_keys = ON;

-- 员工：销售顾问 / 主管
CREATE TABLE IF NOT EXISTS staff (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('advisor', 'supervisor')),
  phone       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

-- 车型
CREATE TABLE IF NOT EXISTS models (
  id          TEXT PRIMARY KEY,
  brand       TEXT NOT NULL,
  name        TEXT NOT NULL,
  segment     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- 试驾车
CREATE TABLE IF NOT EXISTS vehicles (
  id              TEXT PRIMARY KEY,
  model_id        TEXT NOT NULL REFERENCES models(id),
  plate           TEXT NOT NULL UNIQUE,
  nickname        TEXT,
  year            INTEGER,
  status          TEXT NOT NULL CHECK (status IN
                    ('available','booked','out','watching','incident_locked')),
  mileage         INTEGER NOT NULL,          -- 当前总里程 km
  fuel_pct        INTEGER NOT NULL,          -- 油量 0-100
  condition_flag  TEXT NOT NULL DEFAULT 'normal' CHECK (condition_flag IN ('normal','abnormal')),
  issue_note      TEXT,
  updated_at      TEXT NOT NULL
);

-- 客户代号（实名信息不落库，仅保留代号与模拟驾照号）
CREATE TABLE IF NOT EXISTS customers (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  license_no    TEXT NOT NULL,
  license_valid INTEGER NOT NULL DEFAULT 1,  -- 适配器判定结果也可覆盖
  license_note  TEXT,
  pay_fail      INTEGER NOT NULL DEFAULT 0,  -- 模拟支付失败样本
  created_at    TEXT NOT NULL
);

-- 试驾路线
CREATE TABLE IF NOT EXISTS routes (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  planned_minutes INTEGER NOT NULL,
  distance_km     REAL NOT NULL,
  note            TEXT
);

-- 预约
CREATE TABLE IF NOT EXISTS reservations (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  vehicle_id      TEXT REFERENCES vehicles(id),
  model_id        TEXT NOT NULL REFERENCES models(id),
  advisor_id      TEXT NOT NULL REFERENCES staff(id),
  customer_code   TEXT NOT NULL,
  license_no      TEXT,
  route_id        TEXT REFERENCES routes(id),
  companion       TEXT,                       -- 随车人员
  start_at        TEXT NOT NULL,
  end_at          TEXT NOT NULL,
  cross_day       INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN
                    ('requested','approved','rejected','dispatched',
                     'returned','watching','completed',
                     'released_late','cancelled','swapped_out')),
  note            TEXT,
  reject_reason   TEXT,
  late_grace_min  INTEGER NOT NULL DEFAULT 15,
  created_by      TEXT REFERENCES staff(id),
  created_at      TEXT NOT NULL,
  decided_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_res_vehicle_time ON reservations(vehicle_id, start_at);
CREATE INDEX IF NOT EXISTS idx_res_advisor_time ON reservations(advisor_id, start_at);
CREATE INDEX IF NOT EXISTS idx_res_status ON reservations(status);

-- 换车记录
CREATE TABLE IF NOT EXISTS swaps (
  id               TEXT PRIMARY KEY,
  reservation_id   TEXT NOT NULL REFERENCES reservations(id),
  from_vehicle_id  TEXT REFERENCES vehicles(id),
  to_vehicle_id    TEXT NOT NULL REFERENCES vehicles(id),
  changed_model    INTEGER NOT NULL DEFAULT 0,
  approver_id      TEXT REFERENCES staff(id),
  reason           TEXT,
  created_at       TEXT NOT NULL
);

-- 单独审批记录（跨日试驾 / 换车型 / 路线超时）
CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  reservation_id  TEXT NOT NULL REFERENCES reservations(id),
  type            TEXT NOT NULL CHECK (type IN ('cross_day','swap_model','route_overtime')),
  decision        TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  approver_id     TEXT NOT NULL REFERENCES staff(id),
  note            TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (reservation_id, type)
);

-- 出车 / 回车（一次预约最多一条）
CREATE TABLE IF NOT EXISTS dispatches (
  id                TEXT PRIMARY KEY,
  reservation_id    TEXT NOT NULL UNIQUE REFERENCES reservations(id),
  vehicle_id        TEXT NOT NULL REFERENCES vehicles(id),
  advisor_id        TEXT NOT NULL REFERENCES staff(id),
  companion         TEXT,
  license_checked   INTEGER NOT NULL DEFAULT 0,
  license_result    TEXT,
  license_valid     INTEGER,
  out_mileage       INTEGER NOT NULL,
  out_fuel          INTEGER NOT NULL,
  low_fuel_alert    INTEGER NOT NULL DEFAULT 0,
  route_id          TEXT REFERENCES routes(id),
  route_started_at  TEXT,
  route_due_at      TEXT,
  route_ended_at    TEXT,
  overtime_minutes  INTEGER NOT NULL DEFAULT 0,
  end_mileage       INTEGER,
  end_fuel          INTEGER,
  new_damage        TEXT,                    -- JSON：{front:[...],rear:[...],left:[...],right:[...]}
  return_note       TEXT,
  dispatched_at     TEXT NOT NULL,
  returned_at       TEXT
);
-- 同一车辆同时只允许一条未结束的出车单（两名顾问同时发车只接受一次）
CREATE UNIQUE INDEX IF NOT EXISTS ux_open_dispatch_vehicle
  ON dispatches(vehicle_id) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dispatch_advisor ON dispatches(advisor_id);

-- 车身照片（前/后/左/右 固定方位）
CREATE TABLE IF NOT EXISTS photo_shots (
  id              TEXT PRIMARY KEY,
  reservation_id  TEXT NOT NULL REFERENCES reservations(id),
  phase           TEXT NOT NULL CHECK (phase IN ('out','return')),
  side            TEXT NOT NULL CHECK (side IN ('front','rear','left','right')),
  path            TEXT NOT NULL,
  taken_at        TEXT NOT NULL,
  UNIQUE (reservation_id, phase, side)
);

-- 违章留观
CREATE TABLE IF NOT EXISTS violation_watches (
  id              TEXT PRIMARY KEY,
  reservation_id  TEXT NOT NULL UNIQUE REFERENCES reservations(id),
  vehicle_id      TEXT NOT NULL REFERENCES vehicles(id),
  starts_at       TEXT NOT NULL,
  ends_at         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('observing','cleared','violation_found')),
  result_note     TEXT,
  ended_by        TEXT,                       -- system / staff id
  created_at      TEXT NOT NULL
);

-- 清洁状态
CREATE TABLE IF NOT EXISTS cleanings (
  id              TEXT PRIMARY KEY,
  reservation_id  TEXT NOT NULL UNIQUE REFERENCES reservations(id),
  vehicle_id      TEXT NOT NULL REFERENCES vehicles(id),
  status          TEXT NOT NULL CHECK (status IN ('pending','done')),
  done_by         TEXT REFERENCES staff(id),
  done_at         TEXT,
  created_at      TEXT NOT NULL
);

-- 事故 / 车况异常复核
CREATE TABLE IF NOT EXISTS incidents (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  reservation_id  TEXT REFERENCES reservations(id),
  vehicle_id      TEXT NOT NULL REFERENCES vehicles(id),
  reporter_id     TEXT REFERENCES staff(id),
  severity        TEXT NOT NULL CHECK (severity IN ('minor','major')),
  description     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('reported','confirmed','cleared')),
  conclusion      TEXT,
  confirmed_by    TEXT REFERENCES staff(id),
  confirmed_at    TEXT,
  created_at      TEXT NOT NULL
);

-- 车况版本（里程 / 油量 / 异常标记 全历史链）
CREATE TABLE IF NOT EXISTS vehicle_condition_versions (
  id              TEXT PRIMARY KEY,
  vehicle_id      TEXT NOT NULL REFERENCES vehicles(id),
  version         INTEGER NOT NULL,
  mileage         INTEGER NOT NULL,
  fuel_pct        INTEGER NOT NULL,
  condition_flag  TEXT NOT NULL,
  issue_note      TEXT,
  source          TEXT NOT NULL,              -- baseline/dispatch/return/incident/refuel/clear
  ref_id          TEXT,
  photos          TEXT,                       -- JSON
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (vehicle_id, version)
);

-- 模拟付款结果
CREATE TABLE IF NOT EXISTS payments (
  id              TEXT PRIMARY KEY,
  reservation_id  TEXT NOT NULL REFERENCES reservations(id),
  amount          INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('success','failed')),
  provider_ref    TEXT,
  raw             TEXT,
  created_at      TEXT NOT NULL
);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  actor_name  TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
