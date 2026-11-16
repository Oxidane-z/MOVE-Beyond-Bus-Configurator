// 模型加载（STEP 转出的 GLB），以及尚无模型的板卡和结构用的占位几何。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { box, cylinder, hitMat, flatMat, cadMat, makeCadMat, fatLines } from './render.js';

const templates = new Map();   // 板卡 key 或 'backplane' → { parts, bounds }
export const hasModel = key => templates.has(key);

async function loadGlb(loader, url) {
  const gltf = await loader.loadAsync(import.meta.env.BASE_URL + url);
  gltf.scene.updateMatrixWorld(true);
  const parts = [];
  gltf.scene.traverse(o => {
    // 同一份几何可能被多个节点引用（实例），所以每个节点都带上自己的变换
    if (o.isLineSegments) parts.push({ lines: o.geometry, matrix: o.matrixWorld.clone() });
    else if (o.isMesh) parts.push({ name: o.name, geometry: o.geometry, matrix: o.matrixWorld.clone(), iface: o.userData.interface || null });
  });
  return { parts, bounds: new THREE.Box3().setFromObject(gltf.scene) };
}

// 预加载 system.json 里所有带 model 字段的板卡，以及背板
export async function loadModels(sys) {
  const loader = new GLTFLoader();
  const jobs = Object.entries(sys.boards).filter(([, T]) => T.model).map(([key, T]) => [key, T.model]);
  if (sys.backplane && sys.backplane.model) jobs.push(['backplane', sys.backplane.model]);
  Object.entries(sys.accessories || {}).forEach(([key, A]) => jobs.push(['acc:' + key, A.model]));
  await Promise.all(jobs.map(async ([key, url]) => {
    try { templates.set(key, await loadGlb(loader, url)); }
    catch (err) { console.error('模型加载失败: ' + url, err); }
  }));
}

// 把模板实例化成一组网格；boardColor 用于基板，其余用顶点色。onInterface 收到接口件的网格
function instantiate(tpl, boardColor, onInterface) {
  const g = new THREE.Group();
  for (const p of tpl.parts) {
    let o;
    if (p.lines) o = fatLines(p.lines);
    else if (p.iface && onInterface) { o = new THREE.Mesh(p.geometry, makeCadMat()); onInterface(p, o); }
    else o = new THREE.Mesh(p.geometry, p.name === 'board' ? flatMat(boardColor) : cadMat);
    o.applyMatrix4(p.matrix);
    g.add(o);
  }
  return g;
}

// 结构：group 是整张卡（落在槽位上），pivot 以板卡中心为轴（查看接口时绕它自转），body 是模型本身
function buildModelCard(key, T, pitch) {
  const tpl = templates.get(key), g = new THREE.Group(), pivot = new THREE.Group(), interfaces = [];
  const size = tpl.bounds.getSize(new THREE.Vector3()), c = tpl.bounds.getCenter(new THREE.Vector3());
  // front：PCB 正面朝模型的 +Z（1）还是 -Z（-1），由转换脚本给出
  const front = T.front || 1, seat = T.seat || 0, cx = c.x;

  const body = instantiate(tpl, T.color, (p, mesh) => {
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
    const bb = p.geometry.boundingBox, center = bb.getCenter(new THREE.Vector3());
    // side：接口朝模型的 +Z 还是 -Z（0 表示跨在板边两面都露出）；face：换算成 PCB 的正面（1）或背面（-1）
    const side = bb.min.z < -1.2 && bb.max.z > 1.2 ? 0 : center.z >= 0 ? 1 : -1;
    interfaces.push({ ref: p.iface, mat: mesh.material, center, side, face: side * front });
  });
  body.position.set(-cx, seat, 0);
  body.updateMatrix();
  interfaces.forEach(i => i.center.applyMatrix4(body.matrix));   // 换算到 pivot 坐标，用于投影标记

  // 可选支架：模型和板卡同一坐标系，板厚中心在 Z=0，所以换面只需沿 Z 镜像
  let bracket = null;
  const acc = T.bracket && templates.get('acc:' + T.bracket);
  if (acc) {
    const obj = instantiate(acc, T.color);
    body.add(obj);
    bracket = { obj, zsign: acc.bounds.getCenter(new THREE.Vector3()).z >= 0 ? 1 : -1, front };
  }

  pivot.position.x = cx;
  pivot.add(body);
  g.add(pivot);
  const hit = new THREE.Mesh(new THREE.BoxGeometry(size.x + 4, size.y + 4, pitch * T.w), hitMat);
  // 占两个槽的板卡，连接器可能在靠后的那个槽（connectorSlot 为 1）
  hit.position.set(cx, c.y + seat, T.w === 2 ? (T.connectorSlot ? -pitch / 2 : pitch / 2) : 0);
  g.add(hit);
  return { group: g, hit, shared: true, interfaces, pivot, bracket, faceOffset: front < 0 ? Math.PI : 0, cx, cy: c.y + seat };
}

const C = { base: '#d9d5e8', post: '#c9c4de', backplane: '#6fae8f', conn: '#3a3652', stiff: '#e4e1ef',
            comp: '#4a4664', cell: '#f3ead0', module: '#5d8f6e', sink: '#bfc3d6' };

// 支架装在 PCB 的哪一面：'back'、'front' 或 'none'
export function setBracket(bracket, mode) {
  bracket.obj.visible = mode !== 'none';
  if (mode !== 'none') bracket.obj.scale.z = (mode === 'front' ? 1 : -1) * bracket.front * bracket.zsign;
}

// 结构中心相对槽位连接器的偏移。背板上的槽位连接器不在板宽正中，占位板卡据此居中
const layout = { cx: 0, cz: 0 };

// 背板。有模型时用模型，否则用占位几何。返回结构中心、半宽和板面高度
export function buildStructure(scene, sys, slotZ) {
  const tpl = templates.get('backplane');
  let hx = 52, topY = 6.6;
  if (tpl) {
    const bp = instantiate(tpl, sys.backplane.color || C.backplane);
    bp.position.y = sys.backplane.y;
    scene.add(bp);
    const c = tpl.bounds.getCenter(new THREE.Vector3()), size = tpl.bounds.getSize(new THREE.Vector3());
    layout.cx = c.x; layout.cz = c.z; hx = size.x / 2; topY = sys.backplane.y + 1.6;
  } else {
    box(scene, 104, 1.6, 100, C.backplane, 0, 5.8, 0);
    for (let i = 0; i < sys.slots; i++) box(scene, 60, 5, 4, C.conn, 0, 9.1, slotZ(i));
  }
  return { cx: layout.cx, cz: layout.cz, hx, topY };
}

// 板卡原点在背板连接器顶面、所占第一个槽的中心
export function buildCard(key, T, pitch) {
  if (T.kind === 'model') return buildModelCard(key, T, pitch);
  const root = new THREE.Group(), g = new THREE.Group();   // g：除连接器外的部分，居中到结构中心
  g.position.x = layout.cx;
  root.add(g);
  const old = T.level !== 'iter2';   // 占位几何里，早期版本用更小的外形和不同的安装耳
  const W = old ? 80 : 92, H = old ? 74 : 88, cy = 5 + H / 2;
  box(root, 30, 5, 3.2, C.conn, 0, 2.5, 0);
  box(g, W, H, 1.6, T.color, 0, cy, 0);

  if (T.kind === 'bat') {
    box(g, 86, 9, 20, C.stiff, 0, 15, 10.8);
    box(g, 86, 9, 20, C.stiff, 0, 5 + H - 8, 10.8);
    const ch = H - 27;
    for (let k = 0; k < 4; k++) cylinder(g, 9, ch, C.cell, -31.5 + k * 21, 19.5 + ch / 2, 10.8);
  } else {
    [-1, 1].forEach(s => box(g, 6, H, 4, C.stiff, s * (W / 2 - 3), cy, 2.8));
    [-1, 1].forEach(s => box(g, W - 12, 5, 4, C.stiff, 0, cy + s * (H / 2 - 2.5), 2.8));
    // 不同迭代的安装耳位置不同
    if (!old) [-1, 1].forEach(sx => [-1, 1].forEach(sy => box(g, 7, 8, 4, C.stiff, sx * (W / 2 + 3.5), cy + sy * (H / 2 - 4), 2.8)));
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
  hit.position.set(layout.cx, cy, T.w === 2 ? pitch / 2 : 0);
  root.add(hit);
  return { group: root, hit };
}
