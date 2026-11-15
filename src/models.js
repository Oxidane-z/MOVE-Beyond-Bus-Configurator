// 占位几何：真实 STEP 转换出 GLB 后，这个文件由模型加载器取代。
import * as THREE from 'three';
import { box, wireBox, cylinder, hitMat } from './render.js';

const C = { base: '#d9d5e8', post: '#c9c4de', backplane: '#6fae8f', conn: '#3a3652', stiff: '#e4e1ef',
            comp: '#4a4664', cell: '#f3ead0', module: '#5d8f6e', sink: '#bfc3d6' };

// 底板、背板和连接器直接加入场景；返回可隐藏的框架组
export function buildStructure(scene, sys, slotZ) {
  box(scene, 136, 4, 124, C.base, 0, -2, 0);
  [[-46, -44], [46, -44], [-46, 44], [46, 44]].forEach(p => box(scene, 5, 5, 5, C.post, p[0], 2.5, p[1]));
  box(scene, 104, 1.6, 100, C.backplane, 0, 5.8, 0);
  for (let i = 0; i < sys.slots; i++) box(scene, 60, 5, 4, C.conn, 0, 9.1, slotZ(i));

  const frame = new THREE.Group();
  scene.add(frame);
  [[-62, -56], [62, -56], [-62, 56], [62, 56]].forEach(p => box(frame, 8, 112, 8, C.post, p[0], 56, p[1]));
  [-62, 62].forEach(x => { box(frame, 8, 6, 104, C.post, x, 109, 0); wireBox(frame, 3, 80, 104, x, 62, 0); });
  return frame;
}

// 板卡原点在背板连接器顶面、所占第一个槽的中心
export function buildCard(key, T, pitch) {
  const g = new THREE.Group();
  const W = T.gen === 1 ? 80 : 92, H = T.gen === 1 ? 74 : 88, cy = 5 + H / 2;
  box(g, 58, 5, 3.2, C.conn, 0, 2.5, 0);
  box(g, W, H, 1.6, T.color, 0, cy, 0);

  if (T.kind === 'bat') {
    box(g, 86, 9, 20, C.stiff, 0, 15, 10.8);
    box(g, 86, 9, 20, C.stiff, 0, 5 + H - 8, 10.8);
    const ch = H - 27;
    for (let k = 0; k < 4; k++) cylinder(g, 9, ch, C.cell, -31.5 + k * 21, 19.5 + ch / 2, 10.8);
  } else {
    [-1, 1].forEach(s => box(g, 6, H, 4, C.stiff, s * (W / 2 - 3), cy, 2.8));
    [-1, 1].forEach(s => box(g, W - 12, 5, 4, C.stiff, 0, cy + s * (H / 2 - 2.5), 2.8));
    // 两代的安装耳位置不同
    if (T.gen === 2) [-1, 1].forEach(sx => [-1, 1].forEach(sy => box(g, 7, 8, 4, C.stiff, sx * (W / 2 + 3.5), cy + sy * (H / 2 - 4), 2.8)));
    else [-1, 1].forEach(sx => box(g, 7, 12, 4, C.stiff, sx * (W / 2 + 3.5), cy, 2.8));

    if (T.kind === 'cm5') {
      box(g, 55, 40, 4, C.module, 0, cy + 6, 2.8);
      box(g, 42, 42, 3, C.sink, 0, cy + 6, 6.3);
      for (let k = 0; k < 6; k++) box(g, 3, 42, 9, C.sink, -19.5 + k * 7.8, cy + 6, 12.3);
    } else {
      const rib = box(g, Math.hypot(W - 12, H - 10), 4, 3, C.stiff, 0, cy, 2.3);
      rib.rotation.z = Math.atan2(H - 10, W - 12);
    }
    // 背面元器件：每种板一个固定的伪随机布局
    let seed = 0;
    for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const cw = (W - 20) / 3, chh = (H - 20) / 3;
    for (let gx = 0; gx < 3; gx++) for (let gy = 0; gy < 3; gy++) {
      if (rnd() < 0.4) continue;
      const w = 6 + rnd() * (cw - 9), h = 5 + rnd() * (chh - 9), d = 1.2 + rnd() * 2;
      box(g, w, h, d, C.comp, (gx - 1) * cw, cy + (gy - 1) * chh, -0.8 - d / 2);
    }
  }
  const hit = new THREE.Mesh(new THREE.BoxGeometry(W + 14, H + 6, pitch * T.w), hitMat);
  hit.position.set(0, cy, T.w === 2 ? pitch / 2 : 0);
  g.add(hit);
  return { group: g, hit };
}
