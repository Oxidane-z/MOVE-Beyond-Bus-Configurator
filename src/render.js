// 平面着色与描边：所有几何都通过这里的辅助函数创建，真实模型接入后沿用同一套材质。
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export const uShade = { value: new THREE.Color() };
export const lineMat = new LineMaterial({ color: 0x000000, linewidth: 1.6 });
export const ghostMat = new LineMaterial({ color: 0x000000, linewidth: 2.4, depthTest: false });
export const hullMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
export const hitMat = new THREE.MeshBasicMaterial({ visible: false });

const VERT = `
varying vec3 vN;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
// 按世界法线取三档亮度：顶面最亮，Z 向面居中，X 向面最暗
const FRAG = `
uniform vec3 uColor;
uniform vec3 uShade;
varying vec3 vN;
void main() {
  vec3 n = normalize(vN);
  vec3 w = n * n;
  float s = w.y * (n.y > 0.0 ? 1.0 : 0.45) + w.z * 0.84 + w.x * 0.62;
  gl_FragColor = vec4(mix(uShade, uColor, s), 1.0);
  #include <colorspace_fragment>
}`;

const matCache = new Map();
export function flatMat(color) {
  if (!matCache.has(color)) {
    matCache.set(color, new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uShade },
      vertexShader: VERT, fragmentShader: FRAG,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
    }));
  }
  return matCache.get(color);
}

export function addEdges(obj, geo, mat = lineMat) {
  const eg = new THREE.EdgesGeometry(geo, 25);
  const lg = new LineSegmentsGeometry();
  lg.setPositions(eg.attributes.position.array);
  const l = new LineSegments2(lg, mat);
  obj.add(l);
  return l;
}

export function box(parent, w, h, d, color, x, y, z) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(geo, flatMat(color));
  m.position.set(x, y, z);
  addEdges(m, geo);
  parent.add(m);
  return m;
}

export function wireBox(parent, w, h, d, x, y, z, mat) {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  addEdges(o, new THREE.BoxGeometry(w, h, d), mat);
  parent.add(o);
  return o;
}

export function cylinder(parent, r, h, color, x, y, z) {
  const geo = new THREE.CylinderGeometry(r, r, h, 32);
  const m = new THREE.Mesh(geo, flatMat(color));
  m.position.set(x, y, z);
  addEdges(m, geo);
  // 反向外壳：给曲面补上轮廓线
  m.add(new THREE.Mesh(new THREE.CylinderGeometry(r + 0.45, r + 0.45, h, 32), hullMat));
  parent.add(m);
  return m;
}

export function setResolution(w, h) {
  lineMat.resolution.set(w, h);
  ghostMat.resolution.set(w, h);
}

// 从 CSS 变量读取线条色、阴影色和强调色，随主题切换更新
export function applyTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  lineMat.color.set(v('--line3d'));
  hullMat.color.set(v('--line3d'));
  uShade.value.set(v('--shade3d'));
  ghostMat.color.set(v('--accent'));
}
