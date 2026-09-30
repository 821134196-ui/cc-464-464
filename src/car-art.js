'use strict';
// 车身四个方位的矢量"照片"生成器。虚构示意图，用于固定方位的出车/回车照片对比。

function esc(s) { return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

// side: front | rear | left | right
function carSVG({ side, color = '#2f6bd8', damage = false, stamp = '', plate = '' } = {}) {
  const mark = damage ? damageMark() : '';
  const label = { front: '车头正面 FRONT', rear: '车尾正面 REAR', left: '车身左侧 LEFT', right: '车身右侧 RIGHT' }[side];
  const shape = bodyShape(side, color);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" width="640" height="400" font-family="ui-monospace,Menlo,Consolas,monospace">
  <rect width="640" height="400" fill="#f4f6fa"/>
  <rect x="0" y="330" width="640" height="70" fill="#e6eaf1"/>
  <g stroke="#d3d9e4" stroke-width="1">
    <line x1="0" y1="352" x2="640" y2="352"/><line x1="0" y1="378" x2="640" y2="378"/>
  </g>
  <text x="20" y="36" font-size="15" fill="#2b3038" font-weight="700">${label}</text>
  <text x="20" y="58" font-size="12" fill="#6a7280">${plate ? esc(plate) + ' · ' : ''}车身影像（模拟）</text>
  ${shape}
  ${mark}
  <text x="20" y="384" font-size="12" fill="#6a7280">${esc(stamp)}</text>
  <text x="620" y="36" font-size="12" fill="#6a7280" text-anchor="end">SHOT-MOCK v1</text>
</svg>`;
}

function damageMark() {
  // 随机但简单：固定一个红色圈注区域（由调用方决定损伤时出现）
  return `<g>
    <ellipse cx="452" cy="230" rx="46" ry="30" fill="none" stroke="#d92d20" stroke-width="4" stroke-dasharray="8 6"/>
    <path d="M430 214 l44 32 M474 214 l-44 32" stroke="#d92d20" stroke-width="3"/>
    <rect x="402" y="176" width="100" height="22" rx="4" fill="#d92d20"/>
    <text x="452" y="192" font-size="13" fill="#fff" text-anchor="middle" font-weight="700">疑似新损伤</text>
  </g>`;
}

function bodyShape(side, color) {
  if (side === 'front' || side === 'rear') {
    const isFront = side === 'front';
    return `<g>
      <path d="M170 250 q10 -86 70 -104 q80 -26 160 0 q60 18 70 104 l-6 52 q-2 14 -18 14 l-228 0 q-16 0 -18 -14 z"
            fill="${color}" stroke="#1d2530" stroke-width="2"/>
      <path d="M214 158 q106 -34 212 0 l10 38 -232 0 z" fill="#a9c4ee" opacity="0.85" stroke="#1d2530"/>
      <rect x="236" y="252" width="168" height="34" rx="8" fill="#222a35"/>
      <rect x="262" y="258" width="116" height="22" rx="4" fill="#eef2f8"/>
      <text x="320" y="275" font-size="15" fill="#2b3038" text-anchor="middle" font-weight="700">${isFront ? '前牌' : '后牌'}</text>
      <circle cx="212" cy="306" r="30" fill="#151a21"/><circle cx="212" cy="306" r="15" fill="#5a6573"/>
      <circle cx="428" cy="306" r="30" fill="#151a21"/><circle cx="428" cy="306" r="15" fill="#5a6573"/>
      <rect x="${isFront ? 208 : 392}" y="214" width="40" height="16" rx="6" fill="#fff3bf" stroke="#1d2530"/>
    </g>`;
  }
  // left / right 侧视
  return `<g>
    <path d="M110 268 q8 -70 64 -92 l56 -30 q70 -14 150 4 l52 30 q42 20 52 88 l-4 40 q-2 14 -18 14 l-334 0 q-16 0 -18 -14 z"
          fill="${color}" stroke="#1d2530" stroke-width="2"/>
    <path d="M188 182 l50 -26 q64 -10 128 2 l46 24 z" fill="#a9c4ee" opacity="0.85" stroke="#1d2530"/>
    <line x1="292" y1="158" x2="288" y2="182" stroke="#1d2530" stroke-width="2"/>
    <rect x="250" y="214" width="140" height="10" rx="4" fill="#1d2530" opacity="0.35"/>
    <circle cx="196" cy="312" r="34" fill="#151a21"/><circle cx="196" cy="312" r="17" fill="#5a6573"/>
    <circle cx="446" cy="312" r="34" fill="#151a21"/><circle cx="446" cy="312" r="17" fill="#5a6573"/>
  </g>`;
}

module.exports = { carSVG };
