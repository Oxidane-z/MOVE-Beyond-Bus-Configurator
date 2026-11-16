// 平面着色与描边：所有几何都通过这里的辅助函数创建。
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export const uShade = { value: new THREE.Color() };
// 粗线是屏幕空间里的四边形，镜像（支架换面）会让它们变成背面，所以要双面渲染
export const lineMat = new LineMaterial({ color: 0x000000, linewidth: 1.6, side: THREE.DoubleSide });
// 深色表面上的描边用浅色，否则深色元器件在深色板上糊成一片
export const lineMatLight = new LineMaterial({ color: 0xffffff, linewidth: 1.3, side: THREE.DoubleSide });
export const hitMat = new THREE.MeshBasicMaterial({ visible: false });

// 元器件只用这几种材质色，不带 CAD 原色
export const MATERIALS = { dark: 0, light: 1, kapton: 2, gold: 3 };
const uDark = { value: new THREE.Color('#383a40') };    // 深色塑料
const uLight = { value: new THREE.Color('#d6d8dc') };   // 浅色金属
const uKapton = { value: new THREE.Color('#9a7836') };  // 暗金：铜线圈、缠了 Kapton 胶带的电芯
const uGold = { value: new THREE.Color('#c9a35a') };    // 金

// CAD 原色（线性空间，0–1）归到几种材质之一
export function classifyColor(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (max - min >= 0.25 * max && max > 0.08) {
    let hue;
    if (max === r) hue = ((g - b) / (max - min) + 6) % 6;
    else if (max === g) hue = (b - r) / (max - min) + 2;
    else hue = (r - g) / (max - min) + 4;
    hue *= 60;
    // 黄是金，棕是暗金；饱和的亮橙红是 CAD 给外壳的默认色，不算
    if (hue >= 40 && hue <= 70) return MATERIALS.gold;
    if (hue >= 20 && hue < 40 && max <= 0.85) return MATERIALS.kapton;
    // 蓝色是 CAD 给结构件（支架、散热器）的默认色，按金属处理
    if (hue >= 190 && hue <= 260) return MATERIALS.light;
  }
  return lum < 0.25 ? MATERIALS.dark : MATERIALS.light;
}
export const isDark = hex => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255) < 70;
};

const VERT = `
varying vec3 vN;
#ifdef USE_COLOR
varying float vMat;
#endif
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  #ifdef USE_COLOR
  vMat = color.r;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
// 按世界法线取三档亮度：顶面最亮，Z 向面居中，X 向面最暗
const FRAG = `
uniform vec3 uColor;
uniform vec3 uShade;
uniform vec3 uDark;
uniform vec3 uLight;
uniform vec3 uKapton;
uniform vec3 uGold;
uniform vec3 uTint;
uniform float uMix;
varying vec3 vN;
#ifdef USE_COLOR
varying float vMat;
#endif
void main() {
  vec3 n = normalize(vN);
  vec3 w = n * n;
  float s = w.y * (n.y > 0.0 ? 1.0 : 0.45) + w.z * 0.84 + w.x * 0.62;
  vec3 base = uColor;
  #ifdef USE_COLOR
  // 顶点色的红色通道存的是材质编号除以 3（见 models.js）
  base = vMat < 0.17 ? uDark : vMat < 0.5 ? uLight : vMat < 0.83 ? uKapton : uGold;
  #endif
  base = mix(base, uTint, uMix);   // 接口高亮
  gl_FragColor = vec4(mix(uShade, base, s), 1.0);
  #include <colorspace_fragment>
}`;

function shaderMat(color, vertexColors) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uShade, uDark, uLight, uKapton, uGold,
                uTint: { value: new THREE.Color('#ffffff') }, uMix: { value: 0 } },
    vertexShader: VERT, fragmentShader: FRAG, vertexColors,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
  });
}

// PCB 基板用：单一颜色
const matCache = new Map();
export function flatMat(color) {
  if (!matCache.has(color)) matCache.set(color, shaderMat(color, false));
  return matCache.get(color);
}

// 元器件用：颜色来自材质编号。每次调用得到一个可单独着色的材质（uTint、uMix 各自独立，其余 uniform 共享）
export const makeCadMat = () => shaderMat('#ffffff', true);
export const cadMat = makeCadMat();

// 把线段端点数组变成可设线宽的粗线；同一份数组只转换一次
const fatCache = new WeakMap();
export function fatLines(positions, mat = lineMat) {
  let lg = fatCache.get(positions);
  if (!lg) {
    lg = new LineSegmentsGeometry();
    lg.setPositions(positions);
    fatCache.set(positions, lg);
  }
  return new LineSegments2(lg, mat);
}

export function setResolution(w, h) {
  lineMat.resolution.set(w, h);
  lineMatLight.resolution.set(w, h);
}

// 从 CSS 变量读取线条色和阴影色，随主题切换更新
export function applyTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  lineMat.color.set(v('--line3d'));
  lineMatLight.color.set(v('--line3d-light'));
  uShade.value.set(v('--shade3d'));
}
