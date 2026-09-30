'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PHOTO_DIR } = require('./db');
const { uid, nowISO } = require('./util');
const S = require('./store');

// 保存一次拍摄（SVG 矢量车身图），返回可访问的相对路径
function saveShot(reservationId, phase, side, svg) {
  if (!['out', 'return'].includes(phase)) throw new Error('非法照片阶段');
  if (!['front', 'rear', 'left', 'right'].includes(side)) throw new Error('非法方位');
  if (typeof svg !== 'string' || svg.length < 20 || !svg.includes('<svg'))
    throw new Error('照片内容不合法（需要 SVG）');
  if (svg.length > 200 * 1024) throw new Error('照片过大（>200KB）');

  const dir = path.join(PHOTO_DIR, reservationId, phase);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${side}.svg`;
  fs.writeFileSync(path.join(dir, file), svg, 'utf8');
  const rel = `/photos/${reservationId}/${phase}/${file}`;
  S.photos.upsert({
    id: uid('ph'), reservation_id: reservationId, phase, side,
    path: rel, taken_at: nowISO(),
  });
  return rel;
}

// 种子：直接落文件 + 记录
function seedShot(reservationId, phase, side, svg, takenAt) {
  const dir = path.join(PHOTO_DIR, reservationId, phase);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${side}.svg`), svg, 'utf8');
  const rel = `/photos/${reservationId}/${phase}/${side}.svg`;
  const existing = S.photos.find(reservationId, phase, side);
  if (!existing) {
    S.photos.upsert({
      id: uid('ph'), reservation_id: reservationId, phase, side,
      path: rel, taken_at: takenAt || nowISO(),
    });
  }
  return rel;
}

// 防目录穿越地读取照片文件
function resolvePhotoPath(urlPath) {
  const rel = urlPath.replace(/^\/photos\//, '');
  const abs = path.join(PHOTO_DIR, rel);
  if (!abs.startsWith(PHOTO_DIR)) return null;
  if (!/\.(svg|png|jpg|jpeg)$/i.test(abs)) return null;
  return abs;
}

module.exports = { saveShot, seedShot, resolvePhotoPath, PHOTO_DIR };
