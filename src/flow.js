// 功耗层叠在三维视图上的电源分布图：粗线，画在压暗的模型上面。
// 这里只管线；节点上的圆点和悬浮标签是 HTML，由 main.js 每帧投影到屏幕上。
//
// 每条线画两遍：一遍不做深度测试、半透明（被板卡挡住的部分也隐约看得见），一遍做深度测试、不透明（露在外面的部分是实的）。
// 两遍下面各垫一条略宽的描边色线，浅色主题下浅色的电源轨才不会融进背景。
//
// 动效有两层，都按“从电源沿线路走到这里的距离”算相位（这个距离借用 LineMaterial 画虚线用的那组属性传进去）：
//   琴弦  整条线路是一根连续的弦（拐角是圆弧，波形顺着电流方向一路传过拐角），横向轻轻摆动。功率越大摆幅略大、振得越快，
//         但摆幅整体压得很小：功率大小主要靠下面的脉冲来表现
//         只在两端和有支线切出去的地方按住，按住的地方两侧平缓地过渡，不会一格一格地鼓起来
//   脉冲  线上一串顺着电流方向移动的亮光：头部朝下游、最亮，身后拖着渐暗的尾巴，一眼看得出电往哪边走。
//         功率越大脉冲越强：头部越接近白色，两个脉冲之间越暗；功率很小的线只有淡淡的起伏
// 悬空的末端（后面不再接东西的干线尾巴）渐隐到透明，不留一个方头。
// 系统开了“减少动态效果”时两层都不动：弦是直的，脉冲静止（方向仍然看得出来）
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const HIDDEN = 0.38;         // 被挡住的部分的不透明度
const DASH = 2.6, GAP = 2.2; // 没有电流的支路的虚线（mm）
const STEP = 1.2;            // 整条线路按这个间距重新取点（mm），够密才看不出折线
const WAVE = 30;             // 弦上波形的波长（mm）
const CHEVRON = 18;          // 相邻两个光斑的间距（mm）
const UP = new THREE.Vector3(0, 1, 0);
const RADIUS = 9;            // 拐角圆弧的半径（mm），短的段会自动缩小
const ARC_STEPS = 12;
const RAMP = 12;             // 按住的点两侧，摆幅从零过渡到满幅的距离（mm）
const FADE = 12;             // 悬空的末端渐隐的长度（mm）

// 把折线的拐角改成圆弧（二次贝塞尔），再沿整条线路等距取点。返回 { P: [Vector3], S: [离起点的距离], L: 总长 }
// 首尾两段只挨着一个拐角，可以整段让给圆弧（中间的段两头各让一半）。某个点带第四个数时，那是这个拐角自己的圆弧半径
function sample(pts) {
  const P = pts.map(q => { const v = new THREE.Vector3().fromArray(q); if (q.length > 3) v.r = q[3]; return v; }).filter((q, i, a) => !i || q.distanceTo(a[i - 1]) > 1e-6), n = P.length;
  if (n < 2) return null;
  const room = (i, j) => P[i].distanceTo(P[j]) * (j === 0 || j === n - 1 ? 1 : 0.5);
  const trim = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) trim[i] = Math.min(P[i].r != null ? P[i].r : RADIUS, room(i, i - 1), room(i, i + 1));
  const poly = [P[0].clone()];
  for (let i = 1; i < n; i++) {
    const d = P[i].clone().sub(P[i - 1]).normalize(), b = P[i].clone().addScaledVector(d, -trim[i]);
    if (b.distanceTo(poly[poly.length - 1]) > 1e-6) poly.push(b);
    if (i < n - 1 && trim[i] > 0) {
      const e = P[i].clone().addScaledVector(P[i + 1].clone().sub(P[i]).normalize(), trim[i]);
      for (let k = 1; k <= ARC_STEPS; k++) {
        const u = k / ARC_STEPS;
        poly.push(b.clone().multiplyScalar((1 - u) * (1 - u)).addScaledVector(P[i], 2 * u * (1 - u)).addScaledVector(e, u * u));
      }
    }
  }
  if (poly.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + poly[i].distanceTo(poly[i - 1]));
  const L = cum[cum.length - 1], m = Math.max(1, Math.round(L / STEP)), out = [], S = [];
  for (let k = 0, i = 0; k <= m; k++) {
    const s = L * k / m;
    while (i < poly.length - 2 && cum[i + 1] < s) i++;
    const u = cum[i + 1] > cum[i] ? (s - cum[i]) / (cum[i + 1] - cum[i]) : 0;
    out.push(poly[i].clone().lerp(poly[i + 1], u)); S.push(s);
  }
  return { P: out, S, L };
}
const smooth = (a, b, x) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u); };

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
    const uArrows = { value: opts.arrows ? 1 : 0 }, uOmega = { value: opts.omega }, uPulse = { value: opts.pulse }, uBreath = { value: opts.breath ? 1 : 0 };
    m.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, { uTime, uPhase, uArrows, uOmega, uPulse, uBreath });
      const sway = d => `sin( ${(2 * Math.PI / WAVE).toFixed(5)} * ${d} - uOmega * uTime )`;
      shader.vertexShader = shader.vertexShader
        .replace('attribute vec3 instanceStart;', 'attribute vec3 instanceStart;\nattribute vec3 instanceSwayStart;\nattribute vec3 instanceSwayEnd;\nattribute float instanceFadeStart;\nattribute float instanceFadeEnd;\nvarying float vFade;\nuniform float uTime;\nuniform float uOmega;')
        .replace('void main() {', 'void main() {\n\tvFade = ( position.y < 0.5 ) ? instanceFadeStart : instanceFadeEnd;')
        .replace('vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );', `vec4 start = modelViewMatrix * vec4( instanceStart + instanceSwayStart * ${sway('instanceDistanceStart')}, 1.0 );`)
        .replace('vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );', `vec4 end = modelViewMatrix * vec4( instanceEnd + instanceSwayEnd * ${sway('instanceDistanceEnd')}, 1.0 );`);
      shader.fragmentShader = shader.fragmentShader
        .replace('uniform float opacity;', 'uniform float opacity;\nuniform float uPhase;\nuniform float uArrows;\nuniform float uPulse;\nuniform float uBreath;\nvarying float vFade;')
        .replace('gl_FragColor = vec4( diffuseColor.rgb, alpha );',
          `// 脉冲：头部在下游一侧（线中心比两边略靠前），身后的亮度平缓地落下去。
           // uPulse（0–1，随功率）决定强弱：两个脉冲之间压暗多少、头部往白色提多少
           float fr = fract( ( vLineDistance - abs( vUv.x ) * 1.2 ) / ${CHEVRON.toFixed(1)} - uPhase );
           float glow = clamp( fr * fr * ( 1.0 - smoothstep( 0.86, 1.0, fr ) ) / 0.72, 0.0, 1.0 );
           // 说不清电往哪边走的线段（三岔口中间那一段）不走脉冲，整段一起明暗起伏
           glow = mix( glow, 0.5 + 0.5 * sin( 6.2832 * uPhase ), uBreath );
           float pulse = uArrows * uPulse;
           vec3 lit = diffuseColor.rgb * ( 1.0 - 0.5 * pulse * ( 1.0 - glow ) );
           lit += ( vec3( 1.0 ) - lit ) * 0.6 * pulse * glow * glow;
           gl_FragColor = vec4( lit, alpha * vFade );`);
    };
    return m;
  }
  // 一条线路。pts 是 [[x, y, z], …]，拐角会改成圆弧；dist 是首尾两点离电源的线路距离（mm）。
  // o.width 屏幕上的线宽（像素）；o.casing 描边色；o.dead 没有电流（虚线，不动，没有脉冲）；
  // o.level 0–1，相对功率，决定脉冲的强弱、摆幅和快慢；o.still 不做动画（减少动态效果）；
  // o.pins 线路中途要按住的点（离起点的距离，mm），有支线从那里切出去；
  // o.fade [起点, 终点]，为 true 的那一端是悬空的：渐隐，也不按住；
  // o.breath 不走脉冲，整段一起明暗起伏（电流方向不确定的线段）
  function line(pts, dist, color, o) {
    const path = sample(pts);
    if (!path) return;
    const { P, S, L } = path, m = P.length;
    const seg = [], d = [], sw = [], fd = [], level = Math.max(0, Math.min(1, o.level || 0)), moving = !o.dead && !o.still;
    const fade = o.fade || [false, false], pins = o.pins || [], ramp = Math.min(RAMP, L / 3);
    const amp = moving ? Math.min(0.2 + 0.7 * Math.sqrt(level), L * 0.1) : 0;   // 最多约 0.9 mm
    const d0 = dist[0], d1 = dist[dist.length - 1], tan = new THREE.Vector3(), perp = new THREE.Vector3(1, 0, 0), q = new THREE.Vector3();
    const off = [], alpha = [];
    for (let i = 0; i < m; i++) {
      // 摆动的方向垂直于线路：躺着的线在背板面里摆，竖着的线（板内的支线）在板面里左右摆；沿线保持同一侧，过拐角时不会突然翻面
      tan.subVectors(P[Math.min(i + 1, m - 1)], P[Math.max(i - 1, 0)]).normalize();
      if (Math.abs(tan.y) < 0.9) { q.crossVectors(tan, UP).normalize(); if (i && q.dot(perp) < 0) q.negate(); perp.copy(q); }
      let e = amp;
      if (!fade[0]) e *= smooth(0, ramp, S[i]);
      if (!fade[1]) e *= smooth(0, ramp, L - S[i]);
      pins.forEach(at => { e *= smooth(2, 2 + ramp, Math.abs(S[i] - at)); });
      off.push(perp.clone().multiplyScalar(e));
      alpha.push((fade[0] ? smooth(0, Math.min(FADE, L), S[i]) : 1) * (fade[1] ? smooth(0, Math.min(FADE, L), L - S[i]) : 1));
    }
    for (let i = 0; i + 1 < m; i++) {
      const a = P[i], b = P[i + 1];
      seg.push(a.x, a.y, a.z, b.x, b.y, b.z);
      d.push(d0 + (d1 - d0) * S[i] / L, d0 + (d1 - d0) * S[i + 1] / L);
      sw.push(off[i].x, off[i].y, off[i].z, off[i + 1].x, off[i + 1].y, off[i + 1].z);
      fd.push(alpha[i], alpha[i + 1]);
    }
    if (!seg.length) return;
    const g = new LineSegmentsGeometry();
    g.setPositions(seg);
    const dbuf = new THREE.InstancedInterleavedBuffer(new Float32Array(d), 2, 1), sbuf = new THREE.InstancedInterleavedBuffer(new Float32Array(sw), 6, 1);
    g.setAttribute('instanceDistanceStart', new THREE.InterleavedBufferAttribute(dbuf, 1, 0));
    g.setAttribute('instanceDistanceEnd', new THREE.InterleavedBufferAttribute(dbuf, 1, 1));
    g.setAttribute('instanceSwayStart', new THREE.InterleavedBufferAttribute(sbuf, 3, 0));
    g.setAttribute('instanceSwayEnd', new THREE.InterleavedBufferAttribute(sbuf, 3, 3));
    const fbuf = new THREE.InstancedInterleavedBuffer(new Float32Array(fd), 2, 1);
    g.setAttribute('instanceFadeStart', new THREE.InterleavedBufferAttribute(fbuf, 1, 0));
    g.setAttribute('instanceFadeEnd', new THREE.InterleavedBufferAttribute(fbuf, 1, 1));
    if (moving) live++;
    const omega = 2 * Math.PI * (0.16 + 0.4 * Math.sqrt(level));   // 0.16–0.56 Hz
    [[o.casing, o.width + 2.4, false, false], [color, o.width, false, true], [o.casing, o.width + 2.4, true, false], [color, o.width, true, true]]
      .forEach(([c, w, depth, arrows], n) => {
        const mesh = new LineSegments2(g, material(c, w, { depth, dead: o.dead, omega, breath: o.breath, pulse: 0.25 + 0.75 * Math.sqrt(level), arrows: arrows && !o.dead, opacity: (depth ? 1 : HIDDEN) * (o.dead ? 0.7 : 1) }));
        mesh.renderOrder = n;
        mesh.frustumCulled = false;   // 包围盒是按没摆动的位置算的
        scene.add(mesh); objs.push(mesh);
      });
  }
  // 画布暂时没有尺寸（窗口被收起）时不更新：分辨率是 0 的话线宽会变成无穷大，画面上全是乱飞的色带
  function setResolution(w, h) { if (!(w > 0 && h > 0)) return; res.set(w, h); objs.forEach(o => o.material.resolution.set(w, h)); }
  // seconds：现在的时间（秒）。脉冲每秒走半个间距
  function setTime(seconds) { uTime.value = seconds % 3600; uPhase.value = (seconds * 0.5) % 1; }
  return { scene, clear, line, setResolution, setTime, get live() { return live; } };
}
