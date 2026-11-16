// 功耗层叠在三维视图上的电源分布图：粗线，画在压暗的模型上面。
// 这里只管线；节点上的文字标签是 HTML，由 main.js 每帧投影到屏幕上。
//
// 每条线画两遍：一遍不做深度测试、半透明（被板卡挡住的部分也隐约看得见），一遍做深度测试、不透明（露在外面的部分是实的）。
// 两遍下面各垫一条略宽的描边色线，浅色主题下浅色的电源轨才不会融进背景。
//
// 脉动：每个顶点带着“从电池沿线路走到这里的距离”，片元里用 距离 ÷ 波长 − 相位 算亮度，
// 所以光点从电池出发、在分叉处自然分流，所有线是同一个波。这个距离借用 LineMaterial 画虚线用的那组属性传进去。
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const WAVELENGTH = 46;       // 相邻两个光点沿线路的间距（mm）
const HIDDEN = 0.38;         // 被挡住的部分的不透明度
const DASH = 2.6, GAP = 2.2; // 没有电流的支路的虚线（mm）

export function makeFlow() {
  const scene = new THREE.Scene(), res = new THREE.Vector2(1, 1), uPhase = { value: 0 };
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
    const uPulse = { value: opts.pulse ? 1 : 0 };
    m.onBeforeCompile = shader => {
      shader.uniforms.uPhase = uPhase; shader.uniforms.uPulse = uPulse;
      shader.fragmentShader = shader.fragmentShader
        .replace('uniform float opacity;', 'uniform float opacity;\nuniform float uPhase;\nuniform float uPulse;')
        .replace('gl_FragColor = vec4( diffuseColor.rgb, alpha );',
          `float wave = 0.5 + 0.5 * cos( 6.2831853 * ( vLineDistance / ${WAVELENGTH.toFixed(1)} - uPhase ) );
           gl_FragColor = vec4( diffuseColor.rgb * mix( 1.0, 0.6 + 0.4 * wave * wave, uPulse ), alpha );`);
    };
    return m;
  }
  // 一条折线。pts 是 [[x, y, z], …]，dist 是各点离电池的线路距离（mm）。
  // o.width 屏幕上的线宽（像素）；o.casing 描边色；o.dead 没有电流（画成虚线，不脉动）；o.pulse 是否脉动
  function line(pts, dist, color, o) {
    const seg = [], d = [];
    for (let i = 0; i + 1 < pts.length; i++) { seg.push(...pts[i], ...pts[i + 1]); d.push(dist[i], dist[i + 1]); }
    const g = new LineSegmentsGeometry();
    g.setPositions(seg);
    const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(d), 2, 1);
    g.setAttribute('instanceDistanceStart', new THREE.InterleavedBufferAttribute(buf, 1, 0));
    g.setAttribute('instanceDistanceEnd', new THREE.InterleavedBufferAttribute(buf, 1, 1));
    const pulse = !!o.pulse && !o.dead;
    if (pulse) live++;
    [[o.casing, o.width + 2.4, false, false], [color, o.width, false, pulse], [o.casing, o.width + 2.4, true, false], [color, o.width, true, pulse]]
      .forEach(([c, w, depth, p], n) => {
        const mesh = new LineSegments2(g, material(c, w, { depth, dead: o.dead, pulse: p, opacity: (depth ? 1 : HIDDEN) * (o.dead ? 0.7 : 1) }));
        mesh.renderOrder = n;
        scene.add(mesh); objs.push(mesh);
      });
  }
  function setResolution(w, h) { res.set(w, h); objs.forEach(o => o.material.resolution.set(w, h)); }
  return { scene, clear, line, setResolution, setPhase: v => { uPhase.value = v; }, get live() { return live; } };
}
