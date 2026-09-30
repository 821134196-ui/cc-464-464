'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const db = require('./db');
const S = require('./store');
const svc = require('./services');
const photos = require('./photos');

const PORT = Number(process.env.TD_PORT || 5173);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': typeof obj === 'string' || Buffer.isBuffer(obj)
      ? (headers['Content-Type'] || 'text/plain; charset=utf-8')
      : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new svc.ApiError(413, 'too_large', '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new svc.ApiError(400, 'bad_json', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  if (urlPath.startsWith('/photos/')) {
    const abs = photos.resolvePhotoPath(decodeURIComponent(urlPath));
    if (!abs || !fs.existsSync(abs)) return send(res, 404, 'not found');
    return send(res, 200, fs.readFileSync(abs), { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  }
  const abs = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!abs.startsWith(PUBLIC_DIR) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory())
    return send(res, 404, 'not found');
  send(res, 200, fs.readFileSync(abs), { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
}

// ---------- 业务序列化 ----------
function board() {
  const models = S.models.list();
  const vehicles = S.vehicles.list();
  return models.map(m => ({
    ...m,
    vehicles: vehicles.filter(v => v.model_id === m.id),
  }));
}

function calendar(dateStr) {
  const d = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
  const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(d); dayEnd.setHours(24, 0, 0, 0);
  const s0 = dayStart.toISOString(), s1 = dayEnd.toISOString();

  const rows = S.all(`SELECT r.id, r.code, r.status, r.start_at, r.end_at, r.customer_code,
    r.vehicle_id, v.plate AS vehicle_plate, m.brand, m.name AS model_name,
    r.advisor_id, st.name AS advisor_name, r.cross_day
    FROM reservations r
    JOIN models m ON m.id=r.model_id
    JOIN staff st ON st.id=r.advisor_id
    LEFT JOIN vehicles v ON v.id=r.vehicle_id
    WHERE r.start_at < ? AND r.end_at > ?
    AND r.status NOT IN ('rejected','cancelled','released_late')
    ORDER BY r.start_at`, s1, s0);

  const lanesV = {}, lanesA = {};
  for (const r of rows) {
    const vk = r.vehicle_id ? `v:${r.vehicle_id}` : 'm:unassigned';
    (lanesV[vk] = lanesV[vk] || []).push(r);
    (lanesA[`a:${r.advisor_id}`] = lanesA[`a:${r.advisor_id}`] || []).push(r);
  }
  return {
    date: dayStart.toISOString().slice(0, 10),
    tzNote: '时间按本地时区展示，重叠判断使用 UTC 存储',
    vehicleLanes: S.vehicles.list().map(v => ({
      key: `v:${v.id}`, vehicle_id: v.id, plate: v.plate,
      model: `${v.brand} ${v.model_name}`, status: v.status,
      items: (lanesV[`v:${v.id}`] || []),
    })),
    advisorLanes: S.staff.list().filter(s => s.role === 'advisor').map(a => ({
      key: `a:${a.id}`, advisor_id: a.id, name: a.name,
      items: (lanesA[`a:${a.id}`] || []),
    })),
  };
}

// ---------- 路由 ----------
async function handleApi(req, res, url) {
  const actorId = req.headers['x-staff-id'] || null;
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
  const q = id => url.searchParams.get(id);

  // 以 async 包装，统一错误处理
  const run = async (fn) => {
    try { send(res, 200, await fn()); }
    catch (e) {
      if (e instanceof svc.ApiError) return send(res, e.status, { error: e.code, message: e.message });
      console.error('[api]', e);
      send(res, 500, { error: 'internal', message: e.message });
    }
  };

  // GET 集合
  if (req.method === 'GET' && url.pathname === '/api/meta') return run(async () => ({
    actor: actorId ? S.staff.get(actorId) : null,
    staff: S.staff.list(), models: S.models.list(), routes: S.routes.list(),
    customers: S.customers.list(), config: svc.CFG,
  }));
  if (req.method === 'GET' && url.pathname === '/api/board') return run(() => ({ groups: board() }));
  if (req.method === 'GET' && url.pathname === '/api/calendar')
    return run(() => calendar(q('date')));
  if (req.method === 'GET' && url.pathname === '/api/reservations')
    return run(() => ({ items: S.reservations.list() }));
  if (req.method === 'GET' && url.pathname === '/api/open-dispatches')
    return run(() => ({ items: S.dispatches.open() }));
  if (req.method === 'GET' && url.pathname === '/api/watches')
    return run(() => ({ items: S.watches.list() }));
  if (req.method === 'GET' && url.pathname === '/api/incidents')
    return run(() => ({ items: S.incidents.list() }));
  if (req.method === 'GET' && url.pathname === '/api/versions')
    return run(() => ({ items: S.all('SELECT * FROM vehicle_condition_versions ORDER BY created_at DESC LIMIT 100') }));

  // POST 集合
  if (req.method === 'POST' && url.pathname === '/api/reservations')
    return run(() => svc.createReservation(actorId, body));
  if (req.method === 'POST' && url.pathname === '/api/incidents')
    return run(() => svc.reportIncident(actorId, body));
  if (req.method === 'POST' && url.pathname === '/api/photos')
    return run(() => {
      const rel = photos.saveShot(body.reservation_id, body.phase, body.side, body.svg);
      return { ok: true, path: rel };
    });

  // /api/reservations/:id/...
  const resMatch = url.pathname.match(/^\/api\/reservations\/([^/]+)(?:\/(.+))?$/);
  if (resMatch) {
    const [, id, sub] = resMatch;
    if (req.method === 'GET' && !sub) return run(() => svc.reservationDetail(id));
    if (req.method === 'POST') {
      switch (sub) {
        case 'approve': return run(() => svc.approveReservation(actorId, id));
        case 'reject': return run(() => svc.rejectReservation(actorId, id, body.reason));
        case 'cancel': return run(() => svc.cancelReservation(actorId, id, body.reason));
        case 'swap': return run(() => svc.swapVehicle(actorId, id, body.to_vehicle_id, body.reason));
        case 'dispatch': return run(() => svc.dispatch(actorId, id));
        case 'route/start': return run(() => svc.startRoute(actorId, id));
        case 'return': return run(() => svc.finishReturn(actorId, id, body));
        case 'cleaning': return run(() => svc.completeCleaning(actorId, id));
        case 'approvals': return run(() =>
          svc.createSpecialApproval(actorId, id, body.type, body.decision || 'approved', body.note));
        default: break;
      }
    }
  }

  // /api/watches/:id/resolve
  const wm = url.pathname.match(/^\/api\/watches\/([^/]+)\/resolve$/);
  if (wm && req.method === 'POST')
    return run(() => svc.resolveWatch(actorId, wm[1], body.status, body.note));

  // /api/incidents/:id/confirm|clear
  const im = url.pathname.match(/^\/api\/incidents\/([^/]+)\/(confirm|clear)$/);
  if (im && req.method === 'POST') {
    const [, id, act] = im;
    return run(() => act === 'confirm'
      ? svc.confirmIncident(actorId, id, body.conclusion, body.severity)
      : svc.clearIncident(actorId, id, body.note));
  }

  // /api/vehicles/:id/...
  const vm = url.pathname.match(/^\/api\/vehicles\/([^/]+)(?:\/(versions|refuel))?$/);
  if (vm) {
    const [, id, sub] = vm;
    if (req.method === 'GET' && sub === 'versions')
      return run(() => ({ items: S.versions.forVehicle(id) }));
    if (req.method === 'POST' && sub === 'refuel')
      return run(() => svc.refuel(actorId, id, body.fuel_pct));
  }

  send(res, 404, { error: 'not_found', message: '接口不存在' });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof svc.ApiError) return send(res, e.status, { error: e.code, message: e.message });
      console.error('[server]', e);
      send(res, 500, { error: 'internal', message: e.message });
    }
  });
}

function start() {
  db.open();
  const seedFlag = path.join(db.DATA_DIR, '.seeded');
  if (!fs.existsSync(seedFlag)) {
    require('./seed').runSeed({ quiet: true });
    fs.writeFileSync(seedFlag, new Date().toISOString());
  }
  const timer = svc.scheduler.start(Number(process.env.TD_TICK_MS || 10000));
  const server = createServer().listen(PORT, () => {
    console.log('');
    console.log('  试驾车预约与车况交接平台 已启动');
    console.log(`  → http://localhost:${PORT}`);
    console.log(`  数据库: ${db.DB_PATH}`);
    console.log(`  照片目录: ${db.PHOTO_DIR}`);
    console.log('  提示：右上角切换员工身份（含主管 邵澜 / 销售顾问）');
    console.log('');
  });
  return { server, timer };
}

if (require.main === module) start();

module.exports = { createServer, start, board, calendar };
