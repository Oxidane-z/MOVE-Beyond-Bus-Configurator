// 模型加载（STEP 转出的 GLB）与板卡、背板的实例化。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { hitMat, flatMat, cadMat, makeCadMat, fatLines, lineMat, lineMatLight, classifyColor, isDark, MATERIALS } from './render.js';

const templates = new Map();   // 板卡 key、'backplane'、'acc:<附件 key>' 或 'exp:<扩展板 key>' → { parts, bounds }
export const hasModel = key => templates.has(key);

const posKey = (a, i) => a[i] + ',' + a[i + 1] + ',' + a[i + 2];

// 把网格的 CAD 顶点色换成材质编号（存在红色通道里），并记下哪些顶点位置在深色表面上
const darkCache = new WeakMap();
function classifyMesh(geometry) {
  if (darkCache.has(geometry)) return darkCache.get(geometry);
  const dark = new Map(), col = geometry.attributes.color, pos = geometry.attributes.position.array;
  if (col) {
    const scale = col.normalized ? 255 : 1, n = col.itemSize;
    for (let i = 0; i < col.count; i++) {
      const m = classifyColor(col.getX(i), col.getY(i), col.getZ(i));
      col.array[i * n] = Math.round(m / 3 * scale * 1000) / 1000;
      const k = posKey(pos, i * 3), e = dark.get(k) || 0;
      dark.set(k, e + (m === MATERIALS.dark ? 1 : -1));
    }
  }
  darkCache.set(geometry, dark);
  return dark;
}

// 把棱线按所在表面的深浅分成两组：深色表面上的用浅色线画
const splitCache = new WeakMap();
function splitLines(lines, dark) {
  if (splitCache.has(lines)) return splitCache.get(lines);
  const a = lines.attributes.position.array, onLight = [], onDark = [];
  for (let i = 0; i + 5 < a.length; i += 6) {
    const d = dark && dark.get(posKey(a, i)) >= 0 && dark.get(posKey(a, i + 3)) >= 0;
    const out = d ? onDark : onLight;
    for (let k = 0; k < 6; k++) out.push(a[i + k]);
  }
  const res = { onLight: new Float32Array(onLight), onDark: new Float32Array(onDark) };
  splitCache.set(lines, res);
  return res;
}

async function loadGlb(loader, url) {
  const v = __MODEL_VERSIONS__[url];
  const gltf = await loader.loadAsync(import.meta.env.BASE_URL + url + (v ? '?v=' + v : ''));
  gltf.scene.updateMatrixWorld(true);
  const parts = [], darkOf = new Map(), lineNodes = [];
  gltf.scene.traverse(o => {
    // 同一份几何可能被多个节点引用（实例），所以每个节点都带上自己的变换
    if (o.isLineSegments) lineNodes.push(o);
    else if (o.isMesh) {
      const board = o.name === 'board';
      if (!board) darkOf.set(o.name, classifyMesh(o.geometry));
      parts.push({ board, geometry: o.geometry, matrix: o.matrixWorld.clone(), iface: o.userData.interface || null });
    }
  });
  // 棱线节点叫 <网格节点名>_edges
  for (const o of lineNodes) {
    const matrix = o.matrixWorld.clone();
    if (o.name === 'board_edges') { parts.push({ board: true, lines: o.geometry.attributes.position.array, matrix }); continue; }
    const s = splitLines(o.geometry, darkOf.get(o.name.replace(/_edges$/, '')));
    if (s.onLight.length) parts.push({ lines: s.onLight, matrix });
    if (s.onDark.length) parts.push({ lines: s.onDark, onDark: true, matrix });
  }
  return { parts, bounds: new THREE.Box3().setFromObject(gltf.scene) };
}

// 预加载 system.json 里所有板卡、背板和附件的模型
export async function loadModels(sys) {
  const loader = new GLTFLoader();
  const jobs = Object.entries(sys.boards).map(([key, T]) => [key, T.model]);
  jobs.push(['backplane', sys.backplane.model]);
  Object.entries(sys.accessories || {}).forEach(([key, A]) => jobs.push(['acc:' + key, A.model]));
  Object.entries(sys.expansions || {}).forEach(([key, E]) => jobs.push(['exp:' + key, E.model]));
  await Promise.all(jobs.map(async ([key, url]) => {
    try { templates.set(key, await loadGlb(loader, url)); }
    catch (err) { console.error('模型加载失败: ' + url, err); }
  }));
}

// 把模板实例化成一组网格；boardColor 是基板颜色，元器件用材质色。onInterface 收到接口件的网格
function instantiate(tpl, boardColor, onInterface) {
  const g = new THREE.Group(), darkBoard = isDark(boardColor);
  for (const p of tpl.parts) {
    let o;
    if (p.lines) o = fatLines(p.lines, (p.board ? darkBoard : p.onDark) ? lineMatLight : lineMat);
    else if (p.iface && onInterface) { o = new THREE.Mesh(p.geometry, makeCadMat()); onInterface(p, o); }
    else o = new THREE.Mesh(p.geometry, p.board ? flatMat(boardColor) : cadMat);
    o.applyMatrix4(p.matrix);
    g.add(o);
  }
  return g;
}

// 收集接口件：side 是接口朝模型的 +Z 还是 -Z（0 表示跨在板边两面都露出）；face 换算成 PCB 的正面（1）或背面（-1）；
// normal 是接口朝向，用来判断它是否对着镜头。背板是平放的（flat），板面朝上，正反面沿 Y 分
const collect = (list, front, flat) => (p, mesh) => {
  if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
  const bb = p.geometry.boundingBox, center = bb.getCenter(new THREE.Vector3());
  const side = flat ? (center.y >= flat.mid ? 1 : -1) : bb.min.z < -1.2 && bb.max.z > 1.2 ? 0 : center.z >= 0 ? 1 : -1;
  list.push({ ref: p.iface, mat: mesh.material, center, side, face: side * front,
              normal: flat ? new THREE.Vector3(0, side, 0) : new THREE.Vector3(0, 0, side) });
};

// 板卡原点在背板连接器顶面、连接器所在槽的中心。
// 结构：group 是整张卡（落在槽位上），pivot 以板卡中心为轴（查看接口时绕它自转），body 是模型本身
export function buildCard(key, T, pitch) {
  const tpl = templates.get(key), g = new THREE.Group(), pivot = new THREE.Group(), interfaces = [];
  const size = tpl.bounds.getSize(new THREE.Vector3()), c = tpl.bounds.getCenter(new THREE.Vector3());
  // front：PCB 正面朝模型的 +Z（1）还是 -Z（-1），由转换脚本给出
  const front = T.front || 1, seat = T.seat || 0, cx = c.x;

  const body = instantiate(tpl, T.color, collect(interfaces, front));
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
  return { group: g, hit, interfaces, pivot, body, front, bracket, faceOffset: front < 0 ? Math.PI : 0, cx, cy: c.y + seat };
}

// 扩展板：模型和主板同一坐标系，直接挂在主板的 body 下。返回 { obj, interfaces }
export function buildExpansion(card, key, E) {
  const tpl = templates.get('exp:' + key);
  if (!tpl) return null;
  const interfaces = [];
  const obj = instantiate(tpl, E.color, collect(interfaces, card.front));
  card.body.add(obj);
  interfaces.forEach(i => i.center.applyMatrix4(card.body.matrix));
  return { obj, interfaces };
}

// 支架装在 PCB 的哪一面：'back'、'front' 或 'none'
export function setBracket(bracket, mode) {
  bracket.obj.visible = mode !== 'none';
  if (mode !== 'none') bracket.obj.scale.z = (mode === 'front' ? 1 : -1) * bracket.front * bracket.zsign;
}

// 背板。返回结构中心、半宽、板面高度，以及背板的模型组和接口件；背板上的槽位连接器不在板宽正中
export function buildStructure(scene, sys) {
  const tpl = templates.get('backplane'), interfaces = [], topY = sys.backplane.y + 1.6;
  if (!tpl) return { cx: 0, cz: 0, hx: 52, topY, group: null, interfaces };
  const bp = instantiate(tpl, sys.backplane.color, collect(interfaces, 1, { mid: 0.8 }));
  bp.position.y = sys.backplane.y;
  scene.add(bp);
  const c = tpl.bounds.getCenter(new THREE.Vector3()), size = tpl.bounds.getSize(new THREE.Vector3());
  return { cx: c.x, cz: c.z, hx: size.x / 2, topY, group: bp, interfaces };
}
