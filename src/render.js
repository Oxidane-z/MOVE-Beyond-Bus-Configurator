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

// 材质分类和深浅判断在 color.js 里（纯函数）
export { MATERIALS, classifyColor, isDark } from './color.js';
const uDark = { value: new THREE.Color('#383a40') };    // 深色塑料
const uLight = { value: new THREE.Color('#d6d8dc') };   // 浅色金属
const uKapton = { value: new THREE.Color('#9a7836') };  // 暗金：铜线圈、缠了 Kapton 胶带的电芯
const uGold = { value: new THREE.Color('#c9a35a') };    // 金

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

/* ---------- 剪影高亮 ---------- */
// 光标指着的板卡：把它单独画成一张蒙版，再在整幅画面上叠一层——蒙版内淡淡铺一层强调色，蒙版边缘描一圈实线。
// 叠在所有东西上面，所以被别的板挡住的部分也看得出轮廓。
export const SIL_LAYER = 1;   // 要高亮的网格临时加到这一层
const maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
const silMat = new THREE.ShaderMaterial({
  uniforms: { tMask: { value: null }, uPx: { value: new THREE.Vector2() }, uColor: { value: new THREE.Color() }, uFill: { value: 0.16 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `
uniform sampler2D tMask;
uniform vec2 uPx;
uniform vec3 uColor;
uniform float uFill;
varying vec2 vUv;
void main() {
  float m = texture2D(tMask, vUv).a, mx = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    vec2 d = vec2(cos(a), sin(a)) * uPx;
    mx = max(mx, max(texture2D(tMask, vUv + d).a, texture2D(tMask, vUv + d * 0.5).a));
  }
  float alpha = max(mx * (1.0 - m), m * uFill);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(uColor, alpha);
  #include <colorspace_fragment>
}`,
  transparent: true, depthTest: false, depthWrite: false
});
const silScene = new THREE.Scene(), silCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), _size = new THREE.Vector2();
silScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), silMat));
let maskRT = null;
// 在主画面画完之后调用
export function drawSilhouette(renderer, scene, camera) {
  renderer.getDrawingBufferSize(_size);
  if (!maskRT) maskRT = new THREE.WebGLRenderTarget(_size.x, _size.y, { samples: 4 });
  else if (maskRT.width !== _size.x || maskRT.height !== _size.y) maskRT.setSize(_size.x, _size.y);
  const layers = camera.layers.mask, auto = renderer.autoClear;
  camera.layers.set(SIL_LAYER); scene.overrideMaterial = maskMat;
  renderer.setRenderTarget(maskRT); renderer.render(scene, camera); renderer.setRenderTarget(null);
  camera.layers.mask = layers; scene.overrideMaterial = null;
  silMat.uniforms.tMask.value = maskRT.texture;
  const w = 2 * renderer.getPixelRatio();   // 描边宽度，CSS 像素约 2px
  silMat.uniforms.uPx.value.set(w / _size.x, w / _size.y);
  renderer.autoClear = false; renderer.render(silScene, silCam); renderer.autoClear = auto;
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
  silMat.uniforms.uColor.value.set(v('--accent'));
}
