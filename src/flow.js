// 功耗层叠在三维视图上的电源分布图：一组不参与深度测试的粗线，画在压暗的模型上面。
// 这里只管线；节点上的文字标签是 HTML，由 main.js 每帧投影到屏幕上。
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export function makeFlow() {
  const scene = new THREE.Scene(), res = new THREE.Vector2(1, 1);
  let objs = [];
  function clear() {
    objs.forEach(o => { scene.remove(o); o.geometry.dispose(); o.material.dispose(); });
    objs = [];
  }
  // 一条折线。pts 是 [[x, y, z], …]；width 是屏幕上的线宽（像素）；dashed 画成虚线（没有电流的支路）
  function line(pts, color, width, dashed) {
    const seg = [];
    for (let i = 0; i + 1 < pts.length; i++) seg.push(...pts[i], ...pts[i + 1]);
    const g = new LineSegmentsGeometry();
    g.setPositions(seg);
    const m = new LineMaterial({ color, linewidth: width, depthTest: false, depthWrite: false, transparent: true,
                                 opacity: dashed ? 0.55 : 1, dashed: !!dashed, dashSize: 2.5, gapSize: 2 });
    m.resolution.copy(res);
    const o = new LineSegments2(g, m);
    if (dashed) o.computeLineDistances();
    scene.add(o); objs.push(o);
  }
  function setResolution(w, h) { res.set(w, h); objs.forEach(o => o.material.resolution.set(w, h)); }
  return { scene, clear, line, setResolution };
}
