// 功耗层叠在三维视图上的电源分布图：粗线，画在压暗的模型上面。
// 这里只管线；节点上的圆点和悬浮标签是 HTML，由 main.js 每帧投影到屏幕上。
//
// 每条线画两遍：一遍不做深度测试、半透明（被板卡挡住的部分也隐约看得见），一遍做深度测试、不透明（露在外面的部分是实的）。
// 两遍下面各垫一条略宽的描边色线，浅色主题下浅色的电源轨才不会融进背景。
//
// 动效有两层，都按“从电源沿线路走到这里的距离”算相位（这个距离借用 LineMaterial 画虚线用的那组属性传进去）：
//   琴弦  每一段直线像一根两端按住的弦，横向缓缓摆动，波形顺着电流方向传过去。功率越大摆幅越大、振得越快
// 折线的拐角都改成圆弧（二次贝塞尔），弧上不摆
//   箭头  线上一串尖角朝着电流方向的亮纹，匀速向下游移动，一眼看得出电往哪边走
// 系统开了“减少动态效果”时两层都不动：弦是直的，箭头纹静止（方向仍然看得出来）
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const HIDDEN = 0.38;         // 被挡住的部分的不透明度
const DASH = 2.6, GAP = 2.2; // 没有电流的支路的虚线（mm）
const STEP = 2.2;            // 把直线切成这么长的小段，才弯得起来（mm）
const WAVE = 24;             // 弦上波形的波长（mm）
const CHEVRON = 13;          // 相邻两个箭头纹的间距（mm）
const UP = new THREE.Vector3(0, 1, 0);
const RADIUS = 6;           // 拐角圆弧的半径（mm），短的段会自动缩小
const ARC_STEPS = 8;

// 把折线拆成直段和圆角：返回 [{ a, b, swing }]，直段可以摆，圆角上的小段不摆
function rounded(pts) {
  const P = pts.map(q => new THREE.Vector3().fromArray(q)), out = [], n = P.length;
  const trim = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) trim[i] = Math.min(RADIUS, P[i].distanceTo(P[i - 1]) / 2, P[i].distanceTo(P[i + 1]) / 2);
  for (let i = 0; i + 1 < n; i++) {
    const d = P[i + 1].clone().sub(P[i]), L = d.length();
    if (L < 1e-6) continue;
    d.divideScalar(L);
    const a = P[i].clone().addScaledVector(d, trim[i]), b = P[i + 1].clone().addScaledVector(d, -trim[i + 1]);
    if (a.distanceTo(b) > 1e-6) out.push({ a, b, swing: true });
    if (i + 2 < n && trim[i + 1] > 0) {
      const d2 = P[i + 2].clone().sub(P[i + 1]).normalize(), c = P[i + 1], e = c.clone().addScaledVector(d2, trim[i + 1]);
      let prev = b;
      for (let k = 1; k <= ARC_STEPS; k++) {
        const u = k / ARC_STEPS, q = b.clone().multiplyScalar((1 - u) * (1 - u)).addScaledVector(c, 2 * u * (1 - u)).addScaledVector(e, u * u);
        out.push({ a: prev, b: q, swing: false }); prev = q;
      }
    }
  }
  return out;
}

export function makeFlow() {
  const scene = new THREE.Scene(), res = new THREE.Vector2(1, 1), uTime = { value: 0 }, uPhase = { value: 0 };
  let objs = [], live = 0;
  function clear() {
    const geos = new Set();
    objs.forEach(o => { scene.remove(o); geos.add(o.geometry); o.material.dispose(); });
    geos.forEach(g => g.dispose());
    objs = []; live = 0;
  }
  function material(color, width, opts) {
    const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity: opts.opacity, depthTest: opts.depth, depthWrite: false,
                                 dashed: true, dashScale: 1, dashSize: DASH, gapSize: opts.dead ? GAP : 0 });
    m.resolution.copy(res);
    const uArrows = { value: opts.arrows ? 1 : 0 }, uOmega = { value: opts.omega };
    m.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, { uTime, uPhase, uArrows, uOmega });
      const sway = d => `sin( ${(2 * Math.PI / WAVE).toFixed(5)} * ${d} - uOmega * uTime )`;
      shader.vertexShader = shader.vertexShader
        .replace('attribute vec3 instanceStart;', 'attribute vec3 instanceStart;\nattribute vec3 instanceSwayStart;\nattribute vec3 instanceSwayEnd;\nuniform float uTime;\nuniform float uOmega;')
        .replace('vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );', `vec4 start = modelViewMatrix * vec4( instanceStart + instanceSwayStart * ${sway('instanceDistanceStart')}, 1.0 );`)
        .replace('vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );', `vec4 end = modelViewMatrix * vec4( instanceEnd + instanceSwayEnd * ${sway('instanceDistanceEnd')}, 1.0 );`);
      shader.fragmentShader = shader.fragmentShader
        .replace('uniform float opacity;', 'uniform float opacity;\nuniform float uPhase;\nuniform float uArrows;')
        .replace('gl_FragColor = vec4( diffuseColor.rgb, alpha );',
          `// 尖角朝下游：线中心的那一点比两边靠前
           float fr = fract( ( vLineDistance + abs( vUv.x ) * 1.7 ) / ${CHEVRON.toFixed(1)} - uPhase );
           float band = smoothstep( 0.0, 0.07, fr ) * ( 1.0 - smoothstep( 0.30, 0.37, fr ) );
           gl_FragColor = vec4( diffuseColor.rgb * mix( 1.0, 0.5 + 0.5 * band, uArrows ), alpha );`);
    };
    return m;
  }
  // 一条折线。pts 是 [[x, y, z], …]（每一段直线是一根两端按住的弦），dist 是各点离电源的线路距离（mm）。
  // o.width 屏幕上的线宽（像素）；o.casing 描边色；o.dead 没有电流（虚线，不动，没有箭头纹）；
  // o.level 0–1，相对功率，决定摆幅和快慢；o.still 不做动画（减少动态效果）
  function line(pts, dist, color, o) {
    const seg = [], d = [], sw = [], level = Math.max(0, Math.min(1, o.level || 0)), moving = !o.dead && !o.still;
    const dir = new THREE.Vector3(), perp = new THREE.Vector3();
    // 距离按圆角以后的实际长度均匀分配到首尾两个距离之间
    const pieces = rounded(pts), total = pieces.reduce((t, q) => t + q.a.distanceTo(q.b), 0) || 1, d0 = dist[0], d1 = dist[dist.length - 1];
    let run = 0;
    for (const { a, b, swing } of pieces) {
      const L = a.distanceTo(b);
      dir.subVectors(b, a).normalize();
      // 摆动的方向：竖着的线（板内的支线）在板面里左右摆，躺着的线在背板面里摆
      if (Math.abs(dir.y) > 0.9) perp.set(1, 0, 0); else perp.crossVectors(dir, UP).normalize();
      const amp = moving && swing ? Math.min(0.35 + 1.9 * Math.sqrt(level), L * 0.16) : 0, n = swing ? Math.max(1, Math.round(L / STEP)) : 1;
      for (let k = 0; k < n; k++) {
        const u0 = k / n, u1 = (k + 1) / n;
        seg.push(a.x + (b.x - a.x) * u0, a.y + (b.y - a.y) * u0, a.z + (b.z - a.z) * u0, a.x + (b.x - a.x) * u1, a.y + (b.y - a.y) * u1, a.z + (b.z - a.z) * u1);
        d.push(d0 + (d1 - d0) * (run + L * u0) / total, d0 + (d1 - d0) * (run + L * u1) / total);
        const e0 = amp * Math.sin(Math.PI * u0), e1 = amp * Math.sin(Math.PI * u1);   // 两端按住，中间摆得最开
        sw.push(perp.x * e0, perp.y * e0, perp.z * e0, perp.x * e1, perp.y * e1, perp.z * e1);
      }
      run += L;
    }
    if (!seg.length) return;
    const g = new LineSegmentsGeometry();
    g.setPositions(seg);
    const dbuf = new THREE.InstancedInterleavedBuffer(new Float32Array(d), 2, 1), sbuf = new THREE.InstancedInterleavedBuffer(new Float32Array(sw), 6, 1);
    g.setAttribute('instanceDistanceStart', new THREE.InterleavedBufferAttribute(dbuf, 1, 0));
    g.setAttribute('instanceDistanceEnd', new THREE.InterleavedBufferAttribute(dbuf, 1, 1));
    g.setAttribute('instanceSwayStart', new THREE.InterleavedBufferAttribute(sbuf, 3, 0));
    g.setAttribute('instanceSwayEnd', new THREE.InterleavedBufferAttribute(sbuf, 3, 3));
    if (moving) live++;
    const omega = 2 * Math.PI * (0.16 + 0.4 * Math.sqrt(level));   // 0.16–0.56 Hz
    [[o.casing, o.width + 2.4, false, false], [color, o.width, false, true], [o.casing, o.width + 2.4, true, false], [color, o.width, true, true]]
      .forEach(([c, w, depth, arrows], n) => {
        const mesh = new LineSegments2(g, material(c, w, { depth, dead: o.dead, omega, arrows: arrows && !o.dead, opacity: (depth ? 1 : HIDDEN) * (o.dead ? 0.7 : 1) }));
        mesh.renderOrder = n;
        mesh.frustumCulled = false;   // 包围盒是按没摆动的位置算的
        scene.add(mesh); objs.push(mesh);
      });
  }
  function setResolution(w, h) { res.set(w, h); objs.forEach(o => o.material.resolution.set(w, h)); }
  // seconds：现在的时间（秒）。箭头纹每秒走半个间距
  function setTime(seconds) { uTime.value = seconds % 3600; uPhase.value = (seconds * 0.5) % 1; }
  return { scene, clear, line, setResolution, setTime, get live() { return live; } };
}
