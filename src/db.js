import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 员工（销售顾问 / 主管）。role: advisor | supervisor
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'advisor',
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- 车型
CREATE TABLE IF NOT EXISTS car_models (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,           -- 轿车 / SUV / MPV / 性能车
  color_name TEXT,
  low_fuel_threshold_pct INTEGER NOT NULL DEFAULT 20,
  max_route_minutes INTEGER NOT NULL DEFAULT 45,
  deposit_cny INTEGER NOT NULL DEFAULT 2000,
  active INTEGER NOT NULL DEFAULT 1
);

-- 试驾车（具体车辆，按车型分组）
CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES car_models(id),
  plate TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,               -- 内部呼号，如「03 号白车」
  vin TEXT,
  initial_odometer_km REAL NOT NULL DEFAULT 0,
  last_odometer_km REAL NOT NULL DEFAULT 0,
  last_fuel_pct REAL NOT NULL DEFAULT 80,
  -- available | reserved | out | checking | observation | cleaning | blocked
  status TEXT NOT NULL DEFAULT 'available',
  -- 车况异常标记：none | damage | mechanical，主管确认事故后可清除/转换
  condition_flag TEXT NOT NULL DEFAULT 'none',
  condition_note TEXT,
  photo_dir TEXT,
  updated_at INTEGER NOT NULL
);

-- 客户（仅用代号；真实证件信息不落库，仅留核验摘要）
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,        -- 客户代号，如 C-1024
  display_name TEXT,                -- 核验返回的称呼（可空）
  license_last4 TEXT,
  license_status TEXT,              -- valid | invalid | expired | underage
  license_reason TEXT,
  safety_score INTEGER,
  created_at INTEGER NOT NULL
);

-- 试驾路线
CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  distance_km REAL NOT NULL,
  planned_minutes INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- 预约
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,        -- 预约号
  vehicle_id TEXT REFERENCES vehicles(id),
  requested_model_id TEXT NOT NULL REFERENCES car_models(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  advisor_id TEXT REFERENCES staff(id),        -- 通过后锁定
  route_id TEXT REFERENCES routes(id),
  companion TEXT,                              -- 随车人员（客户方/门店方）
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  -- pending | approved | rejected | released(迟到释放) | cancelled |
  -- dispatched | returned | checked | exception
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  approved_by TEXT REFERENCES staff(id),
  approved_at INTEGER,
  -- 出车
  dispatched_at INTEGER,
  dispatch_odometer_km REAL,
  dispatch_fuel_pct REAL,
  -- 回店
  returned_at INTEGER,
  return_odometer_km REAL,
  return_fuel_pct REAL,
  low_fuel_flag INTEGER NOT NULL DEFAULT 0,
  -- 路线计时
  route_start_ts INTEGER,
  route_end_ts INTEGER,
  route_minutes INTEGER,
  route_overtime_flag INTEGER NOT NULL DEFAULT 0,
  -- 违章留观
  observation_until INTEGER,
  observation_released_at INTEGER,
  -- 事故
  incident_reported_at INTEGER,
  incident_note TEXT,
  -- 清洁
  cleaned_at INTEGER,
  deposit_txn TEXT,                          -- 押金交易号（付款适配器返回）
  deposit_amount_cny INTEGER DEFAULT 0,
  -- 换车记录（从原车辆改派）
  reassigned_from_vehicle_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

-- 车况版本：每次出车/回车生成一个版本，形成里程链
CREATE TABLE IF NOT EXISTS condition_versions (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  reservation_id TEXT REFERENCES reservations(id),
  seq INTEGER NOT NULL,                         -- 同一车辆内递增
  kind TEXT NOT NULL,                           -- dispatch | return | incident | supervisor_clear
  odometer_km REAL,
  fuel_pct REAL,
  new_damages TEXT,                             -- JSON 数组：方位+描述
  mechanical_issue TEXT,
  photos TEXT,                                  -- JSON: {front, rear, left, right, extra:[...]}
  note TEXT,
  created_by TEXT REFERENCES staff(id),
  created_by_role TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(vehicle_id, seq)
);

-- 照片元数据（文件保存在本地目录）
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  reservation_id TEXT REFERENCES reservations(id),
  position TEXT NOT NULL,                       -- front | rear | left | right | extra
  kind TEXT NOT NULL,                           -- before | after | incident
  file_path TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER,
  uploaded_by TEXT,
  created_at INTEGER NOT NULL
);

-- 跨日试驾单独审批记录
CREATE TABLE IF NOT EXISTS overnight_approvals (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  approver_id TEXT NOT NULL REFERENCES staff(id),
  approver_role TEXT NOT NULL,
  reason TEXT,
  risk_note TEXT,
  deposit_extra_cny INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'approved',      -- approved | revoked
  created_at INTEGER NOT NULL
);

-- 事故复核（主管确认结论；普通销售不可清除异常）
CREATE TABLE IF NOT EXISTS incident_reviews (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  supervisor_id TEXT NOT NULL REFERENCES staff(id),
  conclusion TEXT NOT NULL,                     -- customer_fault | store_fault | third_party | no_fault
  damage_confirmed TEXT,                        -- JSON
  clear_condition INTEGER NOT NULL DEFAULT 0,   -- 是否清除车况异常
  note TEXT,
  created_at INTEGER NOT NULL
);

-- 状态机审计日志
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  actor TEXT,
  actor_role TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reservations_vehicle_time
  ON reservations(vehicle_id, start_ts, end_ts);
CREATE INDEX IF NOT EXISTS idx_reservations_customer ON reservations(customer_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
CREATE INDEX IF NOT EXISTS idx_condition_versions_vehicle ON condition_versions(vehicle_id, seq);
CREATE INDEX IF NOT EXISTS idx_photos_reservation ON photos(reservation_id);
`;

let _dbPath;

export function openDb(dbPath = process.env.TD_DB_PATH || 'data/app.db') {
  _dbPath = dbPath;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  // node:sqlite 默认开启外键
  return db;
}

export function currentDbPath() {
  return _dbPath;
}
