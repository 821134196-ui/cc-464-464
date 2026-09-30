import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, createReadStream, rmSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { openDb } from './db.js';
import { Service, DomainError } from './service.js';
import { seed, carSvg as carSvgForRouter } from './seed.js';
import { json as sendJson, badRequest, notFound, forbidden, parseLocal, fmtDate, uid } from './util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json',
};

export async function createApp({ dbPath = process.env.TD_DB_PATH || join(ROOT, 'data', 'app.db'),
                            photoDir = process.env.TD_PHOTO_DIR || join(ROOT, 'data', 'photos'),
                            reset = false, scheduler = true, clock = Date.now } = {}) {
  if (reset && existsSync(dbPath)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
    }
  }
  const db = openDb(dbPath);
  const svc = new Service(db, { photoDir, clock });

  const count = db.prepare('SELECT COUNT(*) AS n FROM car_models').get().n;
  if (count === 0) seed(db, photoDir, clock());

  // 进程内定时任务：每 10 秒释放迟到预约、结束到期留观
  let timer = null;
  const tick = () => {
    try {
      const late = svc.releaseLateReservations(15);
      const obs = svc.expireObservations();
      if (late.length || obs.length) {
        console.log(`[scheduler] 释放迟到预约 ${late.length} 单，结束留观 ${obs.length} 单`);
      }
    } catch (e) { console.error('[scheduler]', e); }
  };
  if (scheduler) {
    timer = setInterval(tick, 10_000);
    timer.unref?.();
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 20 * 1024 * 1024) { reject(new DomainError('上传内容过大', 'too_large', 413)); req.destroy(); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const readJson = async (req) => {
    const buf = await readBody(req);
    if (!buf.length) return {};
    try { return JSON.parse(buf.toString('utf-8')); } catch { throw new DomainError('请求体不是合法 JSON'); }
  };

  // 简单包装：从请求头取操作员
  const actor = (req) => req.headers['x-staff-id'] || null;

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      // ---------- 静态资源 ----------
      if (req.method === 'GET' && !p.startsWith('/api/')) {
        return serveStatic(p, res);
      }

      // ---------- API ----------
      if (p === '/api/meta' && req.method === 'GET') {
        return sendJson(res, 200, {
          staff: db.prepare('SELECT id,name,role FROM staff WHERE active=1 ORDER BY role,name').all(),
          models: db.prepare('SELECT * FROM car_models WHERE active=1 ORDER BY category,code').all(),
          routes: db.prepare('SELECT * FROM routes WHERE active=1 ORDER BY planned_minutes').all(),
        });
      }

      if (p === '/api/board' && req.method === 'GET') {
        return sendJson(res, 200, svc.board());
      }

      if (p === '/api/calendar' && req.method === 'GET') {
        const date = url.searchParams.get('date') || fmtDate(clock());
        const dayStart = parseLocal(`${date} 00:00`);
        return sendJson(res, 200, { date, ...svc.calendar(dayStart, dayStart + 86400000) });
      }

      if (p === '/api/customers' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body.code || !body.idNumber) throw new DomainError('客户代号与证件号必填');
        const result = svc.registerCustomer(body);
        return sendJson(res, 201, result);
      }

      if (p === '/api/reservations' && req.method === 'GET') {
        const staffId = actor(req);
        if (url.searchParams.get('view') === 'pending') return sendJson(res, 200, svc.pendingApprovals());
        if (!staffId) return sendJson(res, 200, svc.listForStaff ? [] : []);
        return sendJson(res, 200, svc.listForStaff(staffId));
      }

      if (p === '/api/reservations' && req.method === 'POST') {
        const body = await readJson(req);
        const r = svc.createReservation({
          code: body.code || `TD-${String(clock()).slice(-8)}${Math.floor(Math.random() * 90 + 10)}`,
          modelId: body.modelId, customerId: body.customerId,
          startTs: parseLocal(body.start), endTs: parseLocal(body.end),
          routeId: body.routeId || null, companion: body.companion || null,
          preferredVehicleId: body.preferredVehicleId || null,
        });
        return sendJson(res, 201, r);
      }

      const mRes = p.match(/^\/api\/reservations\/([^/]+)(\/(.+))?$/);
      if (mRes) {
        const id = decodeURIComponent(mRes[1]);
        const action = mRes[3] || null;
        const staffId = actor(req);

        if (!action && req.method === 'GET') {
          const detail = svc.reservationDetail(id);
          if (!detail) throw new DomainError('预约不存在', 'not_found', 404);
          return sendJson(res, 200, detail);
        }
        const body = ['GET', 'HEAD'].includes(req.method) ? {} : await readJson(req);
        const requireActor = () => { if (!staffId) throw new DomainError('缺少操作员身份（X-Staff-Id）', 'no_staff', 401); };

        switch (action) {
          case 'approve': {
            requireActor();
            const r = svc.approveReservation(id, staffId, { advisorId: body.advisorId, depositCny: body.depositCny });
            return sendJson(res, 200, r);
          }
          case 'reject': {
            requireActor();
            return sendJson(res, 200, svc.rejectReservation(id, staffId, body.reason));
          }
          case 'overnight': {
            requireActor();
            return sendJson(res, 201, svc.requestOvernightApproval(id, staffId, body));
          }
          case 'reassign': {
            requireActor();
            return sendJson(res, 200, svc.reassignVehicle(id, staffId,
              { newVehicleId: body.newVehicleId || null, newModelId: body.newModelId || null }));
          }
          case 'dispatch': {
            requireActor();
            const result = svc.dispatch(id, staffId, {
              odometerKm: body.odometerKm ?? null, fuelPct: body.fuelPct ?? null,
              photos: resolvePhotoMap(svc, body.photos, id, 'before'),
              companion: body.companion ?? null,
            });
            return sendJson(res, 200, result);
          }
          case 'route-end': {
            requireActor();
            return sendJson(res, 200, svc.endRoute(id, staffId));
          }
          case 'return': {
            requireActor();
            if (body.odometerKm == null) throw new DomainError('回店里程必填');
            return sendJson(res, 200, svc.returnVehicle(id, staffId,
              { odometerKm: body.odometerKm, fuelPct: body.fuelPct ?? null }));
          }
          case 'checkin': {
            requireActor();
            return sendJson(res, 200, svc.checkIn(id, staffId, {
              afterPhotos: resolvePhotoMap(svc, body.afterPhotos, id, 'after'),
              newDamages: body.newDamages || [],
              mechanicalIssue: body.mechanicalIssue || null,
              incident: body.incident || null, note: body.note || null,
            }));
          }
          case 'observation': {
            requireActor();
            return sendJson(res, 200, svc.startObservation(id, staffId, { hours: body.hours ?? 24 }));
          }
          case 'incident-review': {
            requireActor();
            return sendJson(res, 201, svc.reviewIncident(id, staffId, body));
          }
          case 'photos-stub': {
            // 生成虚构四方位占位照片，便于无文件演示
            requireActor();
            const kind = url.searchParams.get('kind') || 'before';
            const damage = url.searchParams.get('damage') === '1';
            return sendJson(res, 201, await generateStubPhotos(svc, id, kind, damage));
          }
          default:
            throw new DomainError('未知操作', 'not_found', 404);
        }
      }

      const mVeh = p.match(/^\/api\/vehicles\/([^/]+)\/(.+)$/);
      if (mVeh && req.method === 'POST') {
        const staffId = actor(req);
        if (!staffId) throw new DomainError('缺少操作员身份（X-Staff-Id）', 'no_staff', 401);
        const [, vid, action] = mVeh;
        const body = await readJson(req);
        if (action === 'clean') return sendJson(res, 200, svc.markCleaned(vid, staffId));
        if (action === 'resolve-repair') return sendJson(res, 200, svc.resolveRepair(vid, staffId, body));
        if (action === 'clear-condition') {
          // 显式演示：普通销售不能清除车况异常，主管也须走事故复核
          svc.clearConditionAttempt(vid, staffId);
        }
        throw new DomainError('未知操作', 'not_found', 404);
      }

      // 原始字节上传照片：X-Photo-Position / X-Photo-Kind / X-Reservation-Id
      if (p === '/api/photos' && req.method === 'POST') {
        const staffId = actor(req);
        if (!staffId) throw new DomainError('缺少操作员身份（X-Staff-Id）', 'no_staff', 401);
        const position = req.headers['x-photo-position'];
        const kind = req.headers['x-photo-kind'] || 'before';
        const reservationId = req.headers['x-reservation-id'] || null;
        if (!['front', 'rear', 'left', 'right', 'extra'].includes(position)) {
          throw new DomainError('照片方位必须是 front/rear/left/right/extra');
        }
        const buf = await readBody(req);
        if (!buf.length) throw new DomainError('照片内容为空');
        const r = reservationId ? svc.getReservation(reservationId) : null;
        const vehicleId = r?.vehicle_id || req.headers['x-vehicle-id'];
        if (!vehicleId) throw new DomainError('无法确定车辆：请先锁定车辆后再上传照片');
        const ct = (req.headers['content-type'] || '').split(';')[0].trim();
        const extMap = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
        const ext = extMap[ct] || ((ct.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '').slice(0, 4));
        const dir = join(photoDir, vehicleId);
        await mkdir(dir, { recursive: true });
        const file = join(dir, `${reservationId || 'free'}_${kind}_${position}_${uid('p').slice(-6)}.${ext}`);
        await writeFile(file, buf);
        const photo = svc.addPhoto({
          vehicleId, reservationId, position, kind, filePath: file,
          contentType: req.headers['content-type'] || 'application/octet-stream',
          sizeBytes: buf.length, uploadedBy: staffId,
        });
        return sendJson(res, 201, photo);
      }

      const mPhoto = p.match(/^\/api\/photos\/([^/]+)\/file$/);
      if (mPhoto && req.method === 'GET') {
        const photo = db.prepare('SELECT * FROM photos WHERE id=?').get(mPhoto[1]);
        if (!photo || !existsSync(photo.file_path)) throw new DomainError('照片不存在', 'not_found', 404);
        res.writeHead(200, { 'Content-Type': photo.content_type || 'application/octet-stream', 'Cache-Control': 'no-store' });
        return createReadStream(photo.file_path).pipe(res);
      }

      if (p === '/api/scheduler/tick' && req.method === 'POST') {
        const late = svc.releaseLateReservations(15);
        const obs = svc.expireObservations();
        return sendJson(res, 200, { releasedLate: late.map((r) => r.code), observationsEnded: obs });
      }

      if (p === '/api/audit' && req.method === 'GET') {
        const limit = Math.min(200, Number(url.searchParams.get('limit')) || 100);
        return sendJson(res, 200,
          db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit));
      }

      notFound(res, '接口不存在');
    } catch (e) {
      if (e instanceof DomainError) return sendJson(res, e.status, { error: e.message, code: e.code });
      console.error(e);
      sendJson(res, 500, { error: '服务器内部错误', detail: String(e?.message || e) });
    }
  };

  const server = createServer(handler);
  return {
    server, db, svc,
    tick,
    close: () => {
      if (timer) clearInterval(timer);
      server.closeAllConnections?.();
      server.close();
      try { db.close(); } catch { /* already closed */ }
    },
    listen: (port) => new Promise((resolve) => server.listen(port, () => resolve(server.address()))),
  };
}

// 把前端提交的 {front: photoId} 映射为 {front: photoId}，并校验归属与 kind
function resolvePhotoMap(svc, map, reservationId, expectKind) {
  if (!map || typeof map !== 'object') return undefined;
  const out = {};
  for (const [pos, photoId] of Object.entries(map)) {
    if (!photoId) continue;
    const photo = svc.db.prepare('SELECT * FROM photos WHERE id=?').get(photoId);
    if (!photo) throw new DomainError(`照片 ${photoId} 不存在`);
    if (photo.reservation_id !== reservationId) throw new DomainError('照片不属于该预约');
    if (photo.kind !== expectKind) throw new DomainError(`该照片类型为 ${photo.kind}，应为 ${expectKind}`);
    out[pos] = photoId;
  }
  return out;
}

async function generateStubPhotos(svc, reservationId, kind, damage) {
  const r = svc.getReservation(reservationId);
  if (!r) throw new DomainError('预约不存在', 'not_found', 404);
  if (!r.vehicle_id) throw new DomainError('预约尚未锁定车辆');
  const v = svc.getVehicle(r.vehicle_id);
  const dir = join(svc.photoDir, v.id);
  await mkdir(dir, { recursive: true });
  const result = {};
  for (const position of ['front', 'rear', 'left', 'right']) {
    const file = join(dir, `${reservationId}_${kind}_${position}.svg`);
    const odo = kind === 'after' ? (r.return_odometer_km ?? v.last_odometer_km) : (r.dispatch_odometer_km ?? v.last_odometer_km);
    await writeFile(file, carSvgForRouter(position, { damage: damage && position === 'right', plate: v.plate, odo }));
    const photo = svc.addPhoto({
      vehicleId: v.id, reservationId, position, kind, filePath: file,
      contentType: 'image/svg+xml', sizeBytes: 0, uploadedBy: 'stub',
    });
    result[position] = photo.id;
  }
  return result;
}

async function serveStatic(p, res) {
  let rel = p === '/' ? '/index.html' : p;
  const filePath = normalize(join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  if (!existsSync(filePath)) {
    // SPA 回退
    const fallback = join(PUBLIC, 'index.html');
    if (existsSync(fallback)) { res.writeHead(200, { 'Content-Type': MIME['.html'] }); return createReadStream(fallback).pipe(res); }
    res.writeHead(404); return res.end('not found');
  }
  const s = await stat(filePath);
  if (s.isDirectory()) return serveStatic('/', res);
  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
}
