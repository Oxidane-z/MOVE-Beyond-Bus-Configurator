import * as THREE from 'three';
import sys from '../system.json';
import { wireBox, ghostMat, hitMat, applyTheme, setResolution } from './render.js';
import { buildStructure, buildCard as buildCardGeo, loadModels, hasModel } from './models.js';

const SLOTS = sys.slots, PITCH = sys.pitch, SEAT_Y = sys.seatY, TYPES = sys.boards, INITIAL = sys.initial;
const slotZ = i => (i - (SLOTS - 1) / 2) * PITCH;
const buildCard = key => buildCardGeo(key, TYPES[key], PITCH);
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// 每块板的人工标注（boards/<板卡 key>.json），目前只有接口
const NOTES = {};
for (const [path, mod] of Object.entries(import.meta.glob('../boards/*.json', { eager: true }))) {
  NOTES[path.split('/').pop().replace('.json', '')] = mod.default;
}
const ifaceNotes = key => (NOTES[key] && NOTES[key].interfaces) || [];

/* ---------- 渲染器与相机 ---------- */
const stage = document.getElementById('stage'), cv = document.getElementById('cv');
const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
const HOME = { tx: 0, ty: 52, tz: 0 };
const view = { yaw: Math.PI / 4, zoom: 1, tx: HOME.tx, ty: HOME.ty, tz: HOME.tz };
const TARGET = new THREE.Vector3(), PITCH_A = Math.atan(1 / Math.SQRT2);

const frame = buildStructure(scene, sys, slotZ);

/* ---------- 槽位拾取体与落位预览 ---------- */
const slotHits = [];
for (let i = 0; i < SLOTS; i++) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(106, 96, PITCH), hitMat);
  m.position.set(0, SEAT_Y + 48, slotZ(i));
  m.userData.slot = i;
  scene.add(m);
  slotHits.push(m);
}
const ghosts = { 1: wireBox(scene, 100, 94, PITCH - 1, 0, SEAT_Y + 47, 0, ghostMat),
                 2: wireBox(scene, 100, 94, PITCH * 2 - 1, 0, SEAT_Y + 47, 0, ghostMat) };
ghosts[1].visible = ghosts[2].visible = false;
function showGhost(w, slot) {
  ghosts[1].visible = ghosts[2].visible = false;
  if (slot < 0) return;
  ghosts[w].visible = true;
  ghosts[w].position.z = slotZ(slot) + (w === 2 ? PITCH / 2 : 0);
}

/* ---------- 补间 ---------- */
const tweens = new Set();
const easeOut = t => 1 - Math.pow(1 - t, 3), easeIn = t => t * t, easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
function killTween(o, k) { for (const t of tweens) if (t.o === o && t.k === k) { tweens.delete(t); t.res(); } }
function tween(o, k, to, ms, ease) {
  return new Promise(res => {
    killTween(o, k);
    if (reduced || ms <= 0) { o[k] = to; res(); return; }
    tweens.add({ o: o, k: k, from: o[k], to: to, ms: ms, ease: ease || easeOut, t0: performance.now(), res: res });
  });
}

/* ---------- 配置状态 ---------- */
const slots = new Array(SLOTS).fill(null);
const placements = new Map();
let nextId = 1, sel = null;

const isFree = (i, ignore) => i >= 0 && i < SLOTS && (slots[i] === null || slots[i] === ignore);
function fit(w, i, ignore) {
  if (w === 1) return isFree(i, ignore) ? i : -1;
  if (isFree(i, ignore) && isFree(i + 1, ignore)) return i;
  if (isFree(i - 1, ignore) && isFree(i, ignore)) return i - 1;
  return -1;
}
function anyFit(w, ignore) { for (let i = 0; i < SLOTS; i++) if (fit(w, i, ignore) >= 0) return true; return false; }
function armed() {
  if (!sel) return null;
  if (sel.kind === 'lib') return { w: TYPES[sel.type].w, ignore: null };
  const p = placements.get(sel.id);
  return p ? { w: TYPES[p.type].w, ignore: p.id } : null;
}
function occupy(p, v) { for (let k = 0; k < TYPES[p.type].w; k++) slots[p.slot + k] = v; }

function place(type, slot, animate) {
  const built = buildCard(type);
  const p = { id: nextId++, type: type, slot: slot, group: built.group, hit: built.hit, busy: false, shared: !!built.shared, interfaces: [] };
  // 把标注和模型里的接口件按位号对上；编号沿用标注文件里的顺序
  ifaceNotes(type).forEach((note, n) => {
    const geo = (built.interfaces || []).find(i => i.ref === note.ref);
    if (geo) p.interfaces.push({ n: n + 1, note, mat: geo.mat, center: geo.center, side: geo.side });
  });
  built.hit.userData.id = p.id;
  p.group.position.set(0, SEAT_Y, slotZ(slot));
  placements.set(p.id, p);
  occupy(p, p.id);
  scene.add(p.group);
  if (animate) {
    p.busy = true;
    p.group.position.y = SEAT_Y + 140;
    tween(p.group.position, 'y', SEAT_Y + 7, 520, easeOut)
      .then(() => tween(p.group.position, 'y', SEAT_Y, 200, easeIn))
      .then(() => { p.busy = false; });
  }
  renderUI();
}
function move(p, slot) {
  if (slot === p.slot) return;
  occupy(p, null); p.slot = slot; occupy(p, p.id);
  p.busy = true; sel = null;
  tween(p.group.position, 'y', SEAT_Y + 110, 320, easeInOut)
    .then(() => tween(p.group.position, 'z', slotZ(slot), 360, easeInOut))
    .then(() => tween(p.group.position, 'y', SEAT_Y + 7, 380, easeOut))
    .then(() => tween(p.group.position, 'y', SEAT_Y, 200, easeIn))
    .then(() => { p.busy = false; });
  renderUI();
}
function removeCard(p) {
  occupy(p, null); placements.delete(p.id);
  p.busy = true; if (sel && sel.id === p.id) sel = null;
  // 先从连接器里拔出一小段，再加速上升直到离开画面
  const exit = SEAT_Y + 140 + 2 * camera.top / view.zoom / Math.cos(PITCH_A);
  tween(p.group.position, 'y', SEAT_Y + 7, 220, easeInOut)
    .then(() => tween(p.group.position, 'y', exit, 900, easeIn))
    .then(() => {
    scene.remove(p.group);
    if (!p.shared) p.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  });
  renderUI();
}
function setSel(next) {
  const prev = sel && sel.kind === 'placed' ? placements.get(sel.id) : null;
  sel = next;
  const cur = sel && sel.kind === 'placed' ? placements.get(sel.id) : null;
  if (prev && prev !== cur && !prev.busy) tween(prev.group.position, 'y', SEAT_Y, 220, easeInOut);
  if (cur && cur !== prev && !cur.busy) tween(cur.group.position, 'y', SEAT_Y + 10, 220, easeOut);
  showGhost(1, -1);
  renderUI();
}
/* ---------- 单板查看 ---------- */
const LIFT = 118;
const marks = document.getElementById('marks'), libPanel = document.getElementById('libPanel'),
      ifacePanel = document.getElementById('ifacePanel'), ifaceTitle = document.getElementById('ifaceTitle'),
      ifaceList = document.getElementById('ifaceList');
let inspect = null;   // { p, s: { spin, flip }, zoom, hover, pinned, marks: [], items: [] }
const typeOf = i => sys.interfaceTypes[i.note.type] || { label: i.note.type, color: '#cccccc' };

function enterInspect(p) {
  if (inspect || p.busy || !p.interfaces.length) return;
  sel = null; showGhost(1, -1);
  inspect = { p, s: { spin: 0, flip: 0 }, zoom: view.zoom, hover: null, pinned: null, marks: [], items: [] };
  p.busy = true; p.spin = inspect.s;

  marks.textContent = ''; ifaceList.textContent = '';
  ifaceTitle.textContent = TYPES[p.type].name + ' 的接口';
  p.interfaces.forEach(i => {
    const T = typeOf(i);
    i.mat.uniforms.uTint.value.set(T.color);
    tween(i.mat.uniforms.uMix, 'value', 0.85, 400, easeOut);

    const m = document.createElement('button');
    m.type = 'button'; m.className = 'mark'; m.style.background = T.color; m.hidden = true;
    m.setAttribute('aria-label', i.n + '：' + i.note.label);
    m.innerHTML = '<span></span><span class="t"></span>';
    m.firstChild.textContent = i.n; m.lastChild.textContent = i.note.label;

    const it = document.createElement('button');
    it.type = 'button'; it.className = 'iface'; it.id = 'iface-' + i.n;
    it.innerHTML = '<span class="no"></span><span><span class="nm"></span><span class="sd"></span><br><span class="mt"></span><br><span class="ds"></span></span>';
    it.querySelector('.no').textContent = i.n; it.querySelector('.no').style.background = T.color;
    it.querySelector('.nm').textContent = i.note.label;
    it.querySelector('.sd').textContent = i.side === 0 ? '两面' : i.side > 0 ? '正面' : '背面';
    it.querySelector('.mt').textContent = [T.label, i.note.connector, i.note.ref].filter(Boolean).join(' · ');
    it.querySelector('.ds').textContent = i.note.desc || '';

    [m, it].forEach(el => {
      el.addEventListener('mouseenter', () => { inspect.hover = i.n; syncActive(); });
      el.addEventListener('mouseleave', () => { inspect.hover = null; syncActive(); });
      el.addEventListener('click', () => {
        inspect.pinned = inspect.pinned === i.n ? null : i.n;
        // 从列表点到另一面的接口时自动翻面
        if (inspect.pinned && i.side !== 0 && (i.side > 0) === (inspect.s.flip > 0.5)) flipInspect();
        syncActive();
      });
    });
    marks.appendChild(m); ifaceList.appendChild(it);
    inspect.marks.push(m); inspect.items.push(it);
  });

  tween(view, 'tx', 0, 520, easeInOut); tween(view, 'tz', slotZ(p.slot), 520, easeInOut);
  tween(view, 'ty', SEAT_Y + LIFT + 42, 520, easeInOut); tween(view, 'zoom', Math.max(view.zoom, 1.9), 520, easeInOut);
  tween(p.group.position, 'y', SEAT_Y + LIFT, 420, easeInOut)
    .then(() => tween(p.spin, 'spin', 1, 420, easeInOut));
  renderUI();
}
function flipInspect() {
  if (inspect) tween(inspect.s, 'flip', inspect.s.flip > 0.5 ? 0 : 1, 520, easeInOut);
}
function exitInspect() {
  if (!inspect) return;
  const { p, zoom } = inspect;
  inspect = null; marks.textContent = '';
  p.interfaces.forEach(i => tween(i.mat.uniforms.uMix, 'value', 0, 300, easeOut));
  tween(view, 'tx', HOME.tx, 620, easeInOut); tween(view, 'ty', HOME.ty, 620, easeInOut);
  tween(view, 'tz', HOME.tz, 620, easeInOut); tween(view, 'zoom', zoom, 620, easeInOut);
  tween(p.spin, 'flip', 0, 360, easeInOut);
  tween(p.spin, 'spin', 0, 360, easeInOut)
    .then(() => tween(p.group.position, 'y', SEAT_Y + 7, 380, easeOut))
    .then(() => tween(p.group.position, 'y', SEAT_Y, 200, easeIn))
    .then(() => { p.spin = null; p.group.rotation.y = 0; p.busy = false; });
  renderUI();
}
function syncActive() {
  if (!inspect) return;
  const act = inspect.hover || inspect.pinned;
  inspect.p.interfaces.forEach((i, k) => {
    const on = act === i.n;
    inspect.marks[k].classList.toggle('on', on);
    inspect.items[k].classList.toggle('on', on);
    tween(i.mat.uniforms.uMix, 'value', act ? (on ? 1 : 0.35) : 0.85, 160, easeOut);
  });
}
// 每帧：让被查看的板正对镜头，并把接口标记投影到屏幕上
const _v = new THREE.Vector3(), _n = new THREE.Vector3();
function updateInspect() {
  placements.forEach(p => {
    if (p.spin) p.group.rotation.y = p.spin.spin * Math.atan2(Math.sin(view.yaw), Math.cos(view.yaw)) + p.spin.flip * Math.PI;
  });
  if (!inspect) return;
  const p = inspect.p, w = stage.clientWidth, h = stage.clientHeight;
  p.group.updateMatrixWorld();
  p.interfaces.forEach((i, k) => {
    _n.set(0, 0, i.side).applyQuaternion(p.group.quaternion);
    const facing = i.side === 0 || _n.x * (camera.position.x - TARGET.x) + _n.z * (camera.position.z - TARGET.z) > 0;
    const m = inspect.marks[k];
    m.hidden = !(facing && p.spin.spin > 0.6);
    if (m.hidden) return;
    _v.copy(i.center).applyMatrix4(p.group.matrixWorld).project(camera);
    m.style.left = ((_v.x * 0.5 + 0.5) * w).toFixed(1) + 'px';
    m.style.top = ((-_v.y * 0.5 + 0.5) * h).toFixed(1) + 'px';
  });
}

function applyAt(slot) {
  if (!sel || slot < 0) return;
  if (sel.kind === 'lib') place(sel.type, slot, true);
  else { const p = placements.get(sel.id); if (p && !p.busy) move(p, slot); }
  showGhost(1, -1);
}

/* ---------- 界面 ---------- */
const libList = document.getElementById('libList'), strip = document.getElementById('strip'),
      hint = document.getElementById('hint'), stats = document.getElementById('stats');

Object.keys(TYPES).forEach(key => {
  const T = TYPES[key], b = document.createElement('button');
  b.type = 'button'; b.className = 'item'; b.id = 'lib-' + key; b.dataset.type = key;
  b.innerHTML = '<span class="sw" style="background:' + T.color + '"></span><span><span class="nm"></span><br><span class="mt"></span></span>';
  b.querySelector('.nm').textContent = T.name;
  b.querySelector('.mt').textContent = (sys.levels[T.level] || T.level) + ' · 占 ' + T.w + ' 槽 · ' + (T.wh ? T.wh + ' Wh' : T.typ == null ? '功耗未填' : T.typ.toFixed(1) + ' W')
    + (ifaceNotes(key).length ? ' · ' + ifaceNotes(key).length + ' 个接口' : '');
  b.addEventListener('click', () => setSel(sel && sel.kind === 'lib' && sel.type === key ? null : { kind: 'lib', type: key }));
  libList.appendChild(b);
});

function renderUI() {
  libPanel.hidden = !!inspect; ifacePanel.hidden = !inspect;
  libList.querySelectorAll('.item').forEach(b => b.setAttribute('aria-pressed', String(!!sel && sel.kind === 'lib' && sel.type === b.dataset.type)));

  strip.textContent = '';
  for (let i = 0; i < SLOTS; i++) {
    const id = slots[i], p = id === null ? null : placements.get(id);
    if (p && p.slot !== i) continue;
    const c = document.createElement('button');
    c.type = 'button'; c.className = 'cell'; c.id = 'slot-' + (i + 1);
    const no = document.createElement('span'); no.className = 'no';
    if (p) {
      const T = TYPES[p.type];
      c.classList.add('full'); c.style.gridColumn = 'span ' + T.w; c.style.background = T.color;
      if (sel && sel.kind === 'placed' && sel.id === p.id) c.classList.add('sel');
      no.textContent = T.w === 2 ? (i + 1) + '–' + (i + 2) : String(i + 1);
      const lb = document.createElement('span'); lb.className = 'lb';
      lb.textContent = T.name + (T.level === 'iter1' ? ' (Iter 1)' : T.level === 'proto' ? ' (Proto)' : '');
      c.appendChild(lb);
      c.setAttribute('aria-label', '槽位 ' + no.textContent + '：' + lb.textContent);
      c.addEventListener('click', () => { if (!p.busy && !inspect) setSel(sel && sel.id === p.id ? null : { kind: 'placed', id: p.id }); });
    } else {
      no.textContent = String(i + 1);
      c.setAttribute('aria-label', '槽位 ' + (i + 1) + '：空');
      c.addEventListener('click', () => { const a = armed(); if (a && !inspect) applyAt(fit(a.w, i, a.ignore)); });
      c.addEventListener('mouseenter', () => { const a = armed(); if (a) showGhost(a.w, fit(a.w, i, a.ignore)); });
      c.addEventListener('mouseleave', () => showGhost(1, -1));
    }
    c.appendChild(no);
    strip.appendChild(c);
  }

  hint.textContent = '';
  const span = document.createElement('span');
  const btn = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (cls) b.className = cls; b.addEventListener('click', fn); return b; };
  if (inspect) {
    span.textContent = '正在查看「' + TYPES[inspect.p.type].name + '」的接口。悬停或点击编号查看说明。';
    hint.appendChild(span);
    hint.appendChild(btn('翻面', '', flipInspect));
    hint.appendChild(btn('返回', 'ghost', exitInspect));
  } else if (!sel) {
    span.textContent = '从板卡库选一块板，再点一个空槽位。拖动画面可旋转。';
    hint.appendChild(span);
  } else if (sel.kind === 'lib') {
    const T = TYPES[sel.type];
    span.textContent = anyFit(T.w, null)
      ? '点击空槽位放置「' + T.name + '」' + (T.w === 2 ? '，需要相邻两个空槽。' : '。')
      : '没有足够的空槽放置「' + T.name + '」' + (T.w === 2 ? '，它需要相邻两个空槽。' : '。');
    hint.appendChild(span);
    hint.appendChild(btn('取消', 'ghost', () => setSel(null)));
  } else {
    const p = placements.get(sel.id);
    span.textContent = '已选中「' + TYPES[p.type].name + '」。点击其他空槽位可移动。';
    hint.appendChild(span);
    if (p.interfaces.length) hint.appendChild(btn('查看接口', '', () => enterInspect(p)));
    hint.appendChild(btn('拔出', p.interfaces.length ? 'ghost' : '', () => removeCard(p)));
    hint.appendChild(btn('取消', 'ghost', () => setSel(null)));
  }
  if (placements.size && !inspect) hint.appendChild(btn('清空', 'ghost', () => { [...placements.values()].forEach(removeCard); }));

  let typ = 0, peak = 0, wh = 0;
  let missing = 0;
  placements.forEach(p => { const T = TYPES[p.type]; if (T.typ == null) missing++; typ += T.typ || 0; peak += T.peak || 0; wh += T.wh || 0; });
  const used = slots.filter(s => s !== null).length;
  const rows = [['已用槽位', used + ' / ' + SLOTS], ['典型功耗', typ.toFixed(2) + ' W'], ['峰值功耗', peak.toFixed(2) + ' W'],
                ['电池容量', wh.toFixed(1) + ' Wh'], ['续航', typ > 0 && wh > 0 ? (wh / typ).toFixed(1) + ' h' : '—']];
  stats.textContent = '';
  rows.forEach(r => { const d = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = r[0]; dd.textContent = r[1]; d.appendChild(dt); d.appendChild(dd); stats.appendChild(d); });
  const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = '示例数据'; stats.appendChild(tag);
  if (missing) { const m = document.createElement('span'); m.className = 'tag'; m.textContent = missing + ' 块板未填功耗，未计入'; stats.appendChild(m); }
}

/* ---------- 画面交互 ---------- */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(e) {
  const r = cv.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const ch = ray.intersectObjects([...placements.values()].map(p => p.hit))[0] || null;
  const a = armed();
  let slot = -1;
  if (a) {
    const sh = ray.intersectObjects(slotHits).filter(h => fit(a.w, h.object.userData.slot, a.ignore) >= 0)[0];
    if (sh && (!ch || sh.distance < ch.distance)) slot = fit(a.w, sh.object.userData.slot, a.ignore);
  }
  return { card: ch ? placements.get(ch.object.userData.id) : null, slot: slot, a: a };
}
let pd = null, dragging = false;
const snapYaw = () => tween(view, 'yaw', Math.round((view.yaw - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2) + Math.PI / 4, 300, easeOut);
cv.addEventListener('pointerdown', e => { pd = { x: e.clientX, yaw: view.yaw }; dragging = false; try { cv.setPointerCapture(e.pointerId); } catch (_) {} });
cv.addEventListener('pointermove', e => {
  if (pd) {
    const dx = e.clientX - pd.x;
    if (!dragging && Math.abs(dx) > 6) { dragging = true; killTween(view, 'yaw'); showGhost(1, -1); cv.style.cursor = 'grabbing'; }
    if (dragging) view.yaw = pd.yaw - dx * 0.008;
  } else if (!inspect) {
    const h = pick(e);
    if (h.a) showGhost(h.a.w, h.slot);
    cv.style.cursor = h.slot >= 0 || h.card ? 'pointer' : 'grab';
  }
});
cv.addEventListener('pointerup', e => {
  if (!pd) return;
  if (dragging) snapYaw();
  else if (!inspect) {
    const h = pick(e);
    if (h.slot >= 0) applyAt(h.slot);
    else if (h.card && !h.card.busy) setSel(sel && sel.id === h.card.id ? null : { kind: 'placed', id: h.card.id });
    else if (!h.card) setSel(null);
  }
  pd = null; dragging = false; cv.style.cursor = 'grab';
});
cv.addEventListener('pointercancel', () => { if (dragging) snapYaw(); pd = null; dragging = false; });
cv.addEventListener('pointerleave', () => { if (!pd) showGhost(1, -1); });
cv.addEventListener('wheel', e => { e.preventDefault(); view.zoom = Math.min(2.5, Math.max(0.6, view.zoom * (e.deltaY < 0 ? 1.08 : 0.926))); }, { passive: false });
document.getElementById('rotL').addEventListener('click', () => tween(view, 'yaw', Math.round((view.yaw - Math.PI / 4) / (Math.PI / 2) - 1) * (Math.PI / 2) + Math.PI / 4, 420, easeInOut));
document.getElementById('rotR').addEventListener('click', () => tween(view, 'yaw', Math.round((view.yaw - Math.PI / 4) / (Math.PI / 2) + 1) * (Math.PI / 2) + Math.PI / 4, 420, easeInOut));
const frameBtn = document.getElementById('frameBtn');
frameBtn.addEventListener('click', () => { frame.visible = !frame.visible; frameBtn.setAttribute('aria-pressed', String(frame.visible)); });
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (inspect) exitInspect(); else setSel(null); }
  if (inspect) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel && sel.kind === 'placed') { const p = placements.get(sel.id); if (p && !p.busy) removeCard(p); }
});

/* ---------- 主题、尺寸、循环 ---------- */
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

let aspect = 1;
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  aspect = w / h;
  setResolution(w, h);
}
new ResizeObserver(resize).observe(stage);

function frameLoop() {
  const now = performance.now();   // 与补间起点用同一个时钟
  for (const t of tweens) {
    const u = Math.min(1, (now - t.t0) / t.ms);
    t.o[t.k] = t.from + (t.to - t.from) * t.ease(u);
    if (u >= 1) { tweens.delete(t); t.res(); }
  }
  const S = 118;
  if (aspect >= 1) { camera.top = S; camera.bottom = -S; camera.right = S * aspect; camera.left = -S * aspect; }
  else { camera.right = S; camera.left = -S; camera.top = S / aspect; camera.bottom = -S / aspect; }
  camera.zoom = view.zoom;
  TARGET.set(view.tx, view.ty, view.tz);
  const cp = Math.cos(PITCH_A);
  camera.position.set(TARGET.x + 600 * cp * Math.sin(view.yaw), TARGET.y + 600 * Math.sin(PITCH_A), TARGET.z + 600 * cp * Math.cos(view.yaw));
  camera.lookAt(TARGET);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  updateInspect();
  renderer.render(scene, camera);
  requestAnimationFrame(frameLoop);
}

applyTheme();
resize();
renderUI();
requestAnimationFrame(frameLoop);
loadModels(TYPES)
  .catch(err => { console.error(err); hint.textContent = '模型加载失败：' + err.message; })
  .then(() => { INITIAL.forEach(c => { if (TYPES[c[0]].kind !== 'model' || hasModel(c[0])) place(c[0], c[1], false); }); });
