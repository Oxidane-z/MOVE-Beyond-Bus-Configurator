import * as THREE from 'three';
import sys from '../system.json';
import { t, applyStatic } from './i18n.js';
import { applyTheme, setResolution } from './render.js';
import { buildStructure, buildCard as buildCardGeo, buildExpansion, loadBackplane, loadBoard, hasModel, setBracket } from './models.js';

const SLOTS = sys.slots, PITCH = sys.pitch, SEAT_Y = sys.seatY, TYPES = sys.boards, LAYOUTS = sys.layouts;
const slotZ = i => (i - (SLOTS - 1) / 2) * PITCH;
const buildCard = key => buildCardGeo(key, TYPES[key], PITCH);
// 板卡原点（连接器）所在的 Z。占两个槽的板卡，连接器可能在靠后的那个槽
const cardZ = (type, slot) => slotZ(slot + (TYPES[type].connectorSlot || 0));
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const BRACKET_MODES = ['back', 'front', 'none'];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 色块上的文字按底色深浅取黑或白
function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16), l = 0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255);
  return l < 140 ? '#ffffff' : '#25262b';
}
// 槽位条和编号标记用分系统颜色（PCB 颜色在 MOVE-IIIa 里几乎都是绿的，区分不了板卡）；没写分系统的退回 PCB 颜色
const SUBS = sys.subsystems || {};
const tagColor = T => (SUBS[T.subsystem] || T).color;
const levelSuffix = T => T.level === 'rev1' ? t('level.rev1') : T.level === 'proto' ? t('level.proto') : '';

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
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 3000);
const ISO = Math.atan(1 / Math.SQRT2);
const HOME = { tx: 0, ty: 48, tz: 0 };
// 默认视角：1 号槽在画面左前方，编号从左到右，与下方的槽位条方向一致
const HOME_YAW = Math.PI * 5 / 4;
const view = { yaw: HOME_YAW, pitch: ISO, zoom: 1, tx: HOME.tx, ty: HOME.ty, tz: HOME.tz };
const TARGET = new THREE.Vector3();
let S = { cx: 0, cz: 0, hx: 52, topY: 7 };   // 结构尺寸，模型加载完后由 buildStructure 给出

/* ---------- 落位预览 ---------- */
// 光标指向可落位的槽时：背景里浮出槽位号，对应的编号标记变成强调色
const banner = document.getElementById('slotBanner'), slotMarks = [];
function showTarget(w, slot) {
  const on = slot >= 0;
  banner.classList.toggle('on', on);
  if (on) banner.textContent = t('banner.slot', { n: w === 2 ? (slot + 1) + '–' + (slot + 2) : slot + 1 });
  slotMarks.forEach((b, i) => b.classList.toggle('target', on && i >= slot && i < slot + w));
}

/* ---------- 补间 ---------- */
const tweens = new Set();
const easeOut = x => 1 - Math.pow(1 - x, 3), easeIn = x => x * x, easeInOut = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
function killTween(o, k) { for (const w of tweens) if (w.o === o && w.k === k) { tweens.delete(w); w.res(); } }
function tween(o, k, to, ms, ease) {
  return new Promise(res => {
    killTween(o, k);
    if (reduced || ms <= 0) { o[k] = to; res(); return; }
    tweens.add({ o, k, from: o[k], to, ms, ease: ease || easeOut, t0: performance.now(), res });
  });
}

/* ---------- 配置状态 ---------- */
const slots = new Array(SLOTS).fill(null);
const placements = new Map();
const loaded = new Set();   // 模型（连同支架和扩展板）已就绪的板卡
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
  if (!sel || sel.swap) return null;
  if (sel.kind === 'lib') return { w: TYPES[sel.type].w, ignore: null };
  const p = placements.get(sel.id);
  return p ? { w: TYPES[p.type].w, ignore: p.id } : null;
}
function occupy(p, v) { for (let k = 0; k < TYPES[p.type].w; k++) slots[p.slot + k] = v; }

function place(type, slot, animate) {
  // 模型还没加载完，或者目标槽位已被占用时不放。加载期间抢先放板会和随后落下的默认布局叠在一起
  if (!ready || !loaded.has(type) || !hasModel(type)) return;
  for (let k = 0; k < TYPES[type].w; k++) if (!isFree(slot + k, null)) return;
  const built = buildCard(type);
  const p = { id: nextId++, type, slot, group: built.group, hit: built.hit, busy: false, interfaces: [], ownInterfaces: built.interfaces,
              pivot: built.pivot, body: built.body, front: built.front, faceOffset: built.faceOffset, cx: built.cx, cy: built.cy,
              bracket: built.bracket, bracketMode: TYPES[type].bracketSide || 'back', exps: sitesOf(type).map(() => ({ key: null, exp: null, by: -1 })) };
  if (p.bracket) setBracket(p.bracket, p.bracketMode);
  sitesOf(type).forEach((site, i) => { if (site.default) setExpansion(p, i, site.default); });
  rebuildInterfaces(p);
  built.hit.userData.id = p.id;
  p.group.position.set(0, SEAT_Y, cardZ(type, slot));
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
// 板卡上的扩展位（system.json 里的 expansionSites）。一块扩展板通常占一个位；expansions 里写了 "sites": 2 的占相邻两个
const sitesOf = type => TYPES[type].expansionSites || [];
const spanOf = key => sys.expansions[key].sites || 1;
function clearSite(p, i) {
  const e = p.exps[i];
  if (e.by >= 0) { clearSite(p, e.by); return; }   // 这个位被前一个位上的双位扩展板占着：取下那块板
  if (e.exp) p.body.remove(e.exp.obj);
  if (e.key && spanOf(e.key) === 2) p.exps[i + 1] = { key: null, exp: null, by: -1 };
  p.exps[i] = { key: null, exp: null, by: -1 };
}
// 在第 i 个扩展位换上扩展板（key 为 null 是取下）
function setExpansion(p, i, key) {
  clearSite(p, i);
  if (!key) return;
  const wide = spanOf(key) === 2;
  if (wide && i + 1 >= p.exps.length) return;
  if (wide) clearSite(p, i + 1);
  const exp = buildExpansion(p, key, sys.expansions[key]);
  if (!exp) return;
  p.exps[i] = { key, exp, by: -1 };
  if (wide) p.exps[i + 1] = { key, exp: null, by: i };
}
// 重建接口列表：主板的接口在前，各扩展板的依次接在后面
function rebuildInterfaces(p) {
  p.interfaces = [];
  addInterfaces(p.interfaces, ifaceNotes(p.type), p.ownInterfaces);
  p.exps.forEach(e => { if (e.exp) addInterfaces(p.interfaces, ifaceNotes(e.key), e.exp.interfaces); });
}
// 把标注和模型里的接口件按 ref 对上；编号沿用标注文件里的顺序
function addInterfaces(list, notes, geos) {
  notes.forEach(note => {
    const geo = geos.find(i => i.ref === note.ref);
    if (geo) list.push({ n: list.length + 1, note, mat: geo.mat, center: geo.center, side: geo.side, face: geo.face, normal: geo.normal });
  });
}
// 抬起、平移到新槽位、落下。lift 是抬起的高度，互换时两块板用不同高度错开
function fly(p, lift) {
  p.busy = true;
  tween(p.group.position, 'y', SEAT_Y + lift, 320, easeInOut)
    .then(() => tween(p.group.position, 'z', cardZ(p.type, p.slot), 360, easeInOut))
    .then(() => tween(p.group.position, 'y', SEAT_Y + 7, 380, easeOut))
    .then(() => tween(p.group.position, 'y', SEAT_Y, 200, easeIn))
    .then(() => { p.busy = false; });
}
// 两块板互换后各自的起始槽位：靠前的位置给原来靠后的板，两块板合起来占的范围两端不变。放不下时返回 null
function swapPlan(A, B) {
  const [L, R] = A.slot < B.slot ? [A, B] : [B, A], wl = TYPES[L.type].w, wr = TYPES[R.type].w;
  const newR = L.slot, newL = R.slot + wr - wl;
  const free = i => i >= 0 && i < SLOTS && (slots[i] === null || slots[i] === A.id || slots[i] === B.id);
  for (let k = 0; k < wr; k++) if (!free(newR + k)) return null;
  for (let k = 0; k < wl; k++) if (!free(newL + k)) return null;
  if (newR + wr > newL) return null;
  return new Map([[L, newL], [R, newR]]);
}
function swap(A, B) {
  const plan = swapPlan(A, B);
  if (!plan) { sel = { kind: 'placed', id: A.id, swap: true, failed: TYPES[B.type].name }; renderUI(); return; }
  touched();
  occupy(A, null); occupy(B, null);
  A.slot = plan.get(A); B.slot = plan.get(B);
  occupy(A, A.id); occupy(B, B.id);
  sel = null;
  fly(A, 205); fly(B, 110);
  renderUI();
}
function move(p, slot) {
  if (slot === p.slot) return;
  occupy(p, null); p.slot = slot; occupy(p, p.id);
  sel = null;
  fly(p, 110);
  renderUI();
}
function removeCard(p) {
  if (!placements.has(p.id)) return;
  occupy(p, null); placements.delete(p.id);
  p.busy = true; if (sel && sel.id === p.id) sel = null;
  // 先从连接器里拔出一小段，再加速上升直到离开画面
  const exit = SEAT_Y + 140 + Math.min(700, 2 * camera.top / view.zoom / Math.cos(view.pitch));
  tween(p.group.position, 'y', SEAT_Y + 7, 220, easeInOut)
    .then(() => tween(p.group.position, 'y', exit, 900, easeIn))
    .then(() => scene.remove(p.group));   // 几何是各实例共享的模板，不释放
  renderUI();
}
function setSel(next) {
  const prev = sel && sel.kind === 'placed' ? placements.get(sel.id) : null;
  sel = next;
  const cur = sel && sel.kind === 'placed' ? placements.get(sel.id) : null;
  if (prev && prev !== cur && !prev.busy) tween(prev.group.position, 'y', SEAT_Y, 220, easeInOut);
  if (cur && cur !== prev && !cur.busy) tween(cur.group.position, 'y', SEAT_Y + 10, 220, easeOut);
  showTarget(1, -1);
  renderUI();
}
function applyAt(slot) {
  if (!sel || slot < 0) return;
  touched();
  if (sel.kind === 'lib') place(sel.type, slot, true);
  else { const p = placements.get(sel.id); if (p && !p.busy) move(p, slot); }
  showTarget(1, -1);
}
// 点槽位（3D 里的编号标记或下方槽位条）：选了板卡就落位，否则选中槽里的板
function slotClick(i) {
  if (inspect) return;
  if (sel && sel.swap) {
    const q = slots[i] === null ? null : placements.get(slots[i]), me = placements.get(sel.id);
    if (q && q !== me && !q.busy && !me.busy) swap(me, q);
    return;
  }
  const a = armed();
  if (a) { const f = fit(a.w, i, a.ignore); if (f >= 0) { applyAt(f); return; } }
  const p = slots[i] === null ? null : placements.get(slots[i]);
  if (p && !p.busy) setSel(sel && sel.id === p.id ? null : { kind: 'placed', id: p.id });
}
function slotHover(i) { const a = armed(); if (a && !inspect) showTarget(a.w, fit(a.w, i, a.ignore)); }

/* ---------- 查看接口 ---------- */
// 被查看的板卡升到堆叠上方、转到正面朝镜头后固定不动，拖动是镜头绕着它转（可以上下俯仰）。
// 背板原地不动，查看时把板卡都藏起来。
const LIFT = 118, TAU = Math.PI * 2, BP_PITCH = 1.1;
const marks = document.getElementById('marks'), libPanel = document.getElementById('libPanel'),
      ifacePanel = document.getElementById('ifacePanel'), ifaceTitle = document.getElementById('ifaceTitle'),
      ifaceList = document.getElementById('ifaceList');
let inspect = null;   // { p, back: 进入前的镜头, home: 查看时的初始镜头, hover, pinned, marks: [], items: [] }
let bpCard = null;    // 背板，形状上和板卡一样，供查看接口用
const typeOf = i => sys.interfaceTypes[i.note.type] || { label: i.note.type, color: '#cccccc' };
const normYaw = () => Math.atan2(Math.sin(view.yaw), Math.cos(view.yaw));
const nameOf = p => p.isBackplane ? t('backplane') : TYPES[p.type].name;
// 离当前角度最近的等价角，避免补间时多转一整圈
const nearAngle = (to, from) => to + Math.round((from - to) / TAU) * TAU;
const worldNormal = (p, i) => _n.copy(i.normal).applyQuaternion(p.pivot.quaternion);
const camDir = () => _v.copy(camera.position).sub(TARGET);

function enterInspect(p) {
  if (inspect || p.busy || !p.interfaces.length) return;
  sel = null; showTarget(1, -1);
  const back = { yaw: view.yaw, pitch: view.pitch, zoom: view.zoom };
  inspect = { p, back, home: null, hover: null, pinned: null, marks: [], items: [] };
  cv.style.touchAction = 'none';   // 查看时触屏也能上下俯仰

  marks.textContent = ''; ifaceList.textContent = '';
  ifaceTitle.textContent = t('interfacesOf', { name: nameOf(p) });
  p.interfaces.forEach(i => {
    const T = typeOf(i);
    i.mat.uniforms.uTint.value.set(T.color);
    tween(i.mat.uniforms.uMix, 'value', 0.85, 400, easeOut);

    const m = document.createElement('button');
    m.type = 'button'; m.className = 'mark'; m.style.background = T.color; m.hidden = true;
    m.setAttribute('aria-label', i.n + ': ' + i.note.label);
    m.innerHTML = '<span></span><span class="t"></span>';
    m.firstChild.textContent = i.n; m.lastChild.textContent = i.note.label;

    const it = document.createElement('button');
    it.type = 'button'; it.className = 'iface'; it.id = 'iface-' + i.n;
    it.innerHTML = '<span class="no"></span><span><span class="nm"></span><span class="sd"></span><br><span class="mt"></span><br><span class="ds"></span></span>';
    it.querySelector('.no').textContent = i.n; it.querySelector('.no').style.background = T.color;
    it.querySelector('.nm').textContent = i.note.label;
    it.querySelector('.sd').textContent = t(i.face === 0 ? 'face.both' : p.isBackplane ? (i.face > 0 ? 'face.top' : 'face.bottom') : i.face > 0 ? 'face.front' : 'face.back');
    it.querySelector('.mt').textContent = [T.label, i.note.connector, i.note.ref].filter(Boolean).join(' · ');
    it.querySelector('.ds').textContent = i.note.desc || '';

    [m, it].forEach(el => {
      el.addEventListener('mouseenter', () => { inspect.hover = i.n; syncActive(); });
      el.addEventListener('mouseleave', () => { inspect.hover = null; syncActive(); });
      el.addEventListener('click', () => {
        inspect.pinned = inspect.pinned === i.n ? null : i.n;
        if (inspect.pinned) faceTo(i);
        syncActive();
      });
    });
    marks.appendChild(m); ifaceList.appendChild(it);
    inspect.marks.push(m); inspect.items.push(it);
  });

  if (p.isBackplane) {
    placements.forEach(q => { q.group.visible = false; });
    inspect.home = { yaw: view.yaw, pitch: BP_PITCH, zoom: Math.max(view.zoom, 1.5) };
    tween(view, 'tx', S.cx, 520, easeInOut); tween(view, 'tz', S.cz, 520, easeInOut); tween(view, 'ty', S.topY, 520, easeInOut);
  } else {
    p.busy = true; p.spin = { spin: 0, yaw: normYaw() };
    inspect.home = { yaw: view.yaw, pitch: back.pitch, zoom: Math.max(view.zoom, 1.9) };
    tween(view, 'tx', p.cx, 520, easeInOut); tween(view, 'tz', cardZ(p.type, p.slot), 520, easeInOut);
    tween(view, 'ty', SEAT_Y + LIFT + p.cy, 520, easeInOut);
    tween(p.group.position, 'y', SEAT_Y + LIFT, 420, easeInOut)
      .then(() => tween(p.spin, 'spin', 1, 420, easeInOut));
  }
  tween(view, 'pitch', inspect.home.pitch, 520, easeInOut); tween(view, 'zoom', inspect.home.zoom, 520, easeInOut);
  renderUI();
}
// 把镜头转到能看见这个接口的一面；已经看得见就不动
function faceTo(i) {
  if (i.side === 0) return;
  const p = inspect.p, n = worldNormal(p, i).clone();
  if (n.dot(camDir()) > 0) return;
  if (p.isBackplane) tween(view, 'pitch', n.y > 0 ? BP_PITCH : -BP_PITCH, 520, easeInOut);
  else tween(view, 'yaw', nearAngle(Math.atan2(n.x, n.z), view.yaw), 520, easeInOut);
}
// 翻到另一面：板卡是镜头绕到背后，背板是镜头转到板底
function flipInspect() {
  if (!inspect) return;
  if (inspect.p.isBackplane) tween(view, 'pitch', view.pitch > 0 ? -BP_PITCH : BP_PITCH, 520, easeInOut);
  else tween(view, 'yaw', view.yaw + Math.PI, 520, easeInOut);
}
function exitInspect() {
  if (!inspect) return;
  const { p, back } = inspect;
  inspect = null; marks.textContent = '';
  cv.style.touchAction = '';
  p.interfaces.forEach(i => tween(i.mat.uniforms.uMix, 'value', 0, 300, easeOut));
  tween(view, 'tx', HOME.tx, 620, easeInOut); tween(view, 'ty', HOME.ty, 620, easeInOut); tween(view, 'tz', HOME.tz, 620, easeInOut);
  tween(view, 'yaw', nearAngle(back.yaw, view.yaw), 620, easeInOut);
  tween(view, 'pitch', back.pitch, 620, easeInOut); tween(view, 'zoom', back.zoom, 620, easeInOut);
  if (p.isBackplane) placements.forEach(q => { q.group.visible = true; });
  else tween(p.spin, 'spin', 0, 360, easeInOut)
    .then(() => tween(p.group.position, 'y', SEAT_Y + 7, 380, easeOut))
    .then(() => tween(p.group.position, 'y', SEAT_Y, 200, easeIn))
    .then(() => { p.spin = null; p.pivot.rotation.y = 0; p.busy = false; });
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
// 每帧：保持被查看的板卡的朝向，并把接口标记投影到屏幕上
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Vector3();
function toScreen(v, el) {
  v.project(camera);
  el.style.left = ((v.x * 0.5 + 0.5) * stage.clientWidth).toFixed(1) + 'px';
  el.style.top = ((-v.y * 0.5 + 0.5) * stage.clientHeight).toFixed(1) + 'px';
}
function updateInspect() {
  placements.forEach(p => {
    if (p.spin) p.pivot.rotation.y = p.spin.spin * (p.spin.yaw + p.faceOffset);
  });
  if (!inspect) return;
  const p = inspect.p;
  p.group.updateMatrixWorld();
  const pm = p.pivot.matrixWorld, settled = p.isBackplane || p.spin.spin > 0.6;
  _c.copy(camera.position).sub(TARGET);
  p.interfaces.forEach((i, k) => {
    const facing = i.side === 0 || worldNormal(p, i).dot(_c) > 0;
    const m = inspect.marks[k];
    m.hidden = !(facing && settled);
    if (!m.hidden) toScreen(_v.copy(i.center).applyMatrix4(pm), m);
  });
}

/* ---------- 槽位编号标记 ---------- */
const slotMarksEl = document.getElementById('slotMarks');
let ready = false;
for (let i = 0; i < SLOTS; i++) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'slotmark'; b.textContent = i + 1; b.hidden = true;
  b.addEventListener('click', () => slotClick(i));
  b.addEventListener('mouseenter', () => slotHover(i));
  b.addEventListener('mouseleave', () => showTarget(1, -1));
  slotMarksEl.appendChild(b);
  slotMarks.push(b);
}
// 每帧：标记贴在背板靠镜头一侧的边上
function updateSlotMarks() {
  const x = S.cx + (Math.sin(view.yaw) >= 0 ? 1 : -1) * (S.hx + 8);
  slotMarks.forEach((b, i) => {
    b.hidden = !!inspect || !ready;
    if (!b.hidden) toScreen(_v.set(x, S.topY, slotZ(i)), b);
  });
}

/* ---------- 界面 ---------- */
const libList = document.getElementById('libList'), strip = document.getElementById('strip'),
      hint = document.getElementById('hint'), stats = document.getElementById('stats');

Object.keys(TYPES).forEach(key => {
  const T = TYPES[key], b = document.createElement('button');
  b.type = 'button'; b.className = 'item'; b.id = 'lib-' + key; b.dataset.type = key;
  b.innerHTML = '<span class="sw"></span><span><span class="nm"></span><br><span class="mt"></span></span>';
  b.querySelector('.sw').style.background = T.color;
  b.querySelector('.nm').textContent = T.name;
  const meta = [...(SUBS[T.subsystem] ? [SUBS[T.subsystem].label] : []), sys.levels[T.level] || T.level, T.w === 1 ? t('meta.slots.1') : t('meta.slots.n', { n: T.w }),
                T.wh ? T.wh + ' Wh' : T.typ == null ? t('meta.noPower') : T.typ.toFixed(1) + ' W'];
  if (ifaceNotes(key).length) meta.push(t('meta.interfaces', { n: ifaceNotes(key).length }));
  b.querySelector('.mt').textContent = meta.join(' · ');
  b.addEventListener('click', () => setSel(sel && sel.kind === 'lib' && sel.type === key ? null : { kind: 'lib', type: key }));
  libList.appendChild(b);
});

/* ---------- 板卡库过滤 ---------- */
// 标签分组：代际、所属默认布局、占槽数，以及 system.json 里板卡自带的 tags。同组内任选其一即可，各组之间要同时满足
const filterGroups = [
  { id: 'subsystem', of: T => [T.subsystem], chips: Object.keys(SUBS).map(k => [k, SUBS[k].label]) },
  { id: 'level', of: T => [T.level], chips: Object.keys(sys.levels).map(k => [k, sys.levels[k]]) },
  { id: 'layout', of: (T, key) => Object.keys(LAYOUTS).filter(l => LAYOUTS[l].boards.some(c => c[0] === key)),
    chips: Object.keys(LAYOUTS).map(k => [k, LAYOUTS[k].name]) },
  { id: 'slots', of: T => [String(T.w)], chips: [['1', t('meta.slots.1')], ['2', t('meta.slots.n', { n: 2 })]] },
  { id: 'tag', of: T => T.tags || [], chips: [...new Set(Object.values(TYPES).flatMap(T => T.tags || []))].map(k => [k, k]) }
];
const filters = new Map(filterGroups.map(g => [g.id, new Set()]));
const libFilters = document.getElementById('libFilters'), libEmpty = document.getElementById('libEmpty');
function applyFilters() {
  let shown = 0;
  libList.querySelectorAll('.item').forEach(b => {
    const T = TYPES[b.dataset.type];
    const ok = filterGroups.every(g => { const on = filters.get(g.id); return !on.size || g.of(T, b.dataset.type).some(v => on.has(v)); });
    b.hidden = !ok; if (ok) shown++;
  });
  libEmpty.hidden = shown > 0;
  libFilters.querySelectorAll('.chip[data-group]').forEach(c => c.setAttribute('aria-pressed', String(filters.get(c.dataset.group).has(c.dataset.value))));
  libFilters.querySelector('.clear').hidden = ![...filters.values()].some(s => s.size);
}
filterGroups.forEach(g => g.chips.forEach(([value, label]) => {
  // 没有任何板卡带这个标签的不列出
  if (!Object.keys(TYPES).some(key => g.of(TYPES[key], key).includes(value))) return;
  const c = document.createElement('button');
  c.type = 'button'; c.className = 'chip'; c.dataset.group = g.id; c.dataset.value = value; c.textContent = label;
  // 分系统标签带一个色点，兼作槽位颜色的图例
  if (g.id === 'subsystem') { const d = document.createElement('span'); d.className = 'dot'; d.style.background = SUBS[value].color; c.prepend(d); }
  c.addEventListener('click', () => { const on = filters.get(g.id); if (!on.delete(value)) on.add(value); applyFilters(); });
  libFilters.appendChild(c);
}));
{
  const c = document.createElement('button');
  c.type = 'button'; c.className = 'chip clear'; c.textContent = t('filter.clear');
  c.addEventListener('click', () => { filters.forEach(s => s.clear()); applyFilters(); });
  libFilters.appendChild(c);
}
applyFilters();

function renderUI() {
  libPanel.hidden = !!inspect; ifacePanel.hidden = !inspect;
  libList.querySelectorAll('.item').forEach(b => {
    b.disabled = !ready || !loaded.has(b.dataset.type);
    b.setAttribute('aria-pressed', String(!!sel && sel.kind === 'lib' && sel.type === b.dataset.type));
  });
  const a = inspect ? null : armed();

  strip.textContent = '';
  for (let i = 0; i < SLOTS; i++) {
    const id = slots[i], p = id === null ? null : placements.get(id);
    const selected = !!p && !!sel && sel.kind === 'placed' && sel.id === p.id;
    // 3D 里的编号标记与槽位条同步
    const mk = slotMarks[i];
    mk.className = 'slotmark' + (p ? ' full' : '') + (selected ? ' sel' : '') + (a && fit(a.w, i, a.ignore) >= 0 ? ' ok' : '');
    mk.style.background = p ? tagColor(TYPES[p.type]) : ''; mk.style.color = p ? inkOn(tagColor(TYPES[p.type])) : '';
    mk.setAttribute('aria-label', t('aria.slot', { n: i + 1, what: p ? TYPES[p.type].name : t('aria.empty') }));

    if (p && p.slot !== i) continue;
    const c = document.createElement('button');
    c.type = 'button'; c.className = 'cell'; c.id = 'slot-' + (i + 1);
    const no = document.createElement('span'); no.className = 'no';
    if (p) {
      const T = TYPES[p.type];
      c.classList.add('full'); c.style.gridColumn = 'span ' + T.w; c.style.background = tagColor(T); c.style.color = inkOn(tagColor(T));
      if (selected) c.classList.add('sel');
      no.textContent = T.w === 2 ? (i + 1) + '–' + (i + 2) : String(i + 1);
      const lb = document.createElement('span'); lb.className = 'lb';
      lb.textContent = T.name + levelSuffix(T);
      c.appendChild(lb);
      c.setAttribute('aria-label', t('aria.slot', { n: no.textContent, what: lb.textContent }));
    } else {
      no.textContent = String(i + 1);
      c.setAttribute('aria-label', t('aria.slot', { n: i + 1, what: t('aria.empty') }));
      c.addEventListener('mouseenter', () => slotHover(i));
      c.addEventListener('mouseleave', () => showTarget(1, -1));
    }
    c.addEventListener('click', () => slotClick(i));
    c.appendChild(no);
    strip.appendChild(c);
  }

  hint.textContent = '';
  const span = document.createElement('span');
  const btn = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (cls) b.className = cls; b.addEventListener('click', fn); return b; };
  hint.appendChild(span);
  if (inspect) {
    span.textContent = t('hint.inspect', { name: nameOf(inspect.p) });
    hint.appendChild(btn(t('btn.flip'), '', flipInspect));
    hint.appendChild(btn(t('btn.back'), 'ghost', exitInspect));
  } else if (!sel) {
    span.textContent = t(ready ? 'hint.idle' : 'hint.loading');
    if (bpCard && bpCard.interfaces.length) hint.appendChild(btn(t('btn.backplane'), 'ghost', () => enterInspect(bpCard)));
  } else if (sel.kind === 'lib') {
    const T = TYPES[sel.type];
    span.textContent = t((anyFit(T.w, null) ? 'hint.place' : 'hint.noRoom') + (T.w === 2 ? '2' : ''), { name: T.name });
    hint.appendChild(btn(t('btn.cancel'), 'ghost', () => setSel(null)));
  } else if (sel.swap) {
    const name = TYPES[placements.get(sel.id).type].name;
    span.textContent = sel.failed ? t('hint.swapNoRoom', { name, other: sel.failed }) : t('hint.swap', { name });
    hint.appendChild(btn(t('btn.cancel'), 'ghost', () => setSel(null)));
  } else {
    const p = placements.get(sel.id);
    span.textContent = t('hint.selected', { name: TYPES[p.type].name });
    if (p.interfaces.length) hint.appendChild(btn(t('btn.interfaces'), '', () => enterInspect(p)));
    if (placements.size > 1) hint.appendChild(btn(t('btn.swap'), 'ghost', () => { sel = { kind: 'placed', id: p.id, swap: true }; renderUI(); }));
    sitesOf(p.type).forEach((site, i) => {
      if (site.fixed) return;   // 固定装着的部件（电池的加热板、COM stack 的 S-Band 板）不提供切换
      // 每个扩展位一个按钮，依次切换：各个可用的扩展板，然后是不装
      const e = p.exps[i], cycle = [...site.options, null];
      const state = e.key ? sys.expansions[e.key].name : t(site.options.length ? 'expansion.none' : 'expansion.unavailable');
      const b = btn(t('btn.expansion', { site: site.name, name: state }), 'ghost', () => {
        setExpansion(p, i, cycle[(cycle.indexOf(e.key) + 1) % cycle.length]); rebuildInterfaces(p); renderUI();
      });
      b.disabled = !site.options.length || e.by >= 0;
      hint.appendChild(b);
    });
    if (p.bracket) hint.appendChild(btn(t('btn.bracket', { mode: t('bracket.' + p.bracketMode) }), 'ghost', () => {
      p.bracketMode = BRACKET_MODES[(BRACKET_MODES.indexOf(p.bracketMode) + 1) % BRACKET_MODES.length];
      setBracket(p.bracket, p.bracketMode); renderUI();
    }));
    hint.appendChild(btn(t('btn.remove'), p.interfaces.length ? 'ghost' : '', () => { touched(); removeCard(p); }));
    hint.appendChild(btn(t('btn.cancel'), 'ghost', () => setSel(null)));
  }
  if (placements.size && !inspect) hint.appendChild(btn(t('btn.clear'), 'ghost', () => { clearAll(); touched(); }));

  let typ = 0, peak = 0, wh = 0, missing = 0;
  placements.forEach(p => { const T = TYPES[p.type]; if (T.typ == null && !T.wh) missing++; typ += T.typ || 0; peak += T.peak || 0; wh += T.wh || 0; });
  const used = slots.filter(s => s !== null).length;
  const watts = v => v > 0 ? v.toFixed(2) + ' W' : '—';
  const rows = [[t('stats.slots'), used + ' / ' + SLOTS], [t('stats.typ'), watts(typ)], [t('stats.peak'), watts(peak)],
                [t('stats.capacity'), wh.toFixed(1) + ' Wh'], [t('stats.runtime'), typ > 0 && wh > 0 ? (wh / typ).toFixed(1) + ' h' : '—']];
  stats.textContent = '';
  rows.forEach(r => { const d = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = r[0]; dd.textContent = r[1]; d.appendChild(dt); d.appendChild(dd); stats.appendChild(d); });
  const tag = text => { const e = document.createElement('span'); e.className = 'tag'; e.textContent = text; stats.appendChild(e); };
  if (missing) tag(t('stats.missing', { n: missing }));
}

/* ---------- 画面交互 ---------- */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), _p = new THREE.Vector3();
const seatPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -SEAT_Y);
// 点到的板卡，以及（选了板卡时）光标落在背板平面上的哪个槽位
function pick(e) {
  const r = cv.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const ch = ray.intersectObjects([...placements.values()].map(p => p.hit))[0] || null;
  const a = armed();
  let slot = -1;
  if (a && ray.ray.intersectPlane(seatPlane, _p)) {
    const i = Math.round(_p.z / PITCH + (SLOTS - 1) / 2);
    const onBoard = Math.abs(_p.x - S.cx) <= S.hx + 4 && i >= 0 && i < SLOTS;
    if (onBoard && (!ch || ray.ray.origin.distanceTo(_p) < ch.distance)) slot = fit(a.w, i, a.ignore);
  }
  return { card: ch ? placements.get(ch.object.userData.id) : null, slot, a };
}
let pd = null, dragging = false;
cv.addEventListener('pointerdown', e => {
  pd = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch };
  dragging = false;
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}
});
cv.addEventListener('pointermove', e => {
  if (pd) {
    const dx = e.clientX - pd.x, dy = e.clientY - pd.y, mouse = e.pointerType === 'mouse';
    const tilt = mouse || !!inspect;
    if (!dragging && (Math.abs(dx) > 6 || (tilt && Math.abs(dy) > 6))) {
      dragging = true; killTween(view, 'yaw'); killTween(view, 'pitch');
      showTarget(1, -1); cv.style.cursor = 'grabbing';
    }
    if (!dragging) return;
    view.yaw = pd.yaw - dx * 0.008;
    // 平时触屏上竖向滑动留给页面滚动，只有鼠标可以改俯仰角；查看接口时都可以，而且能转到板子下方
    if (tilt) view.pitch = clamp(pd.pitch + dy * 0.006, inspect ? -1.5 : 0.12, 1.5);
  } else if (!inspect) {
    const h = pick(e);
    if (h.a) showTarget(h.a.w, h.slot);
    cv.style.cursor = h.slot >= 0 || h.card ? 'pointer' : 'grab';
  }
});
cv.addEventListener('pointerup', e => {
  if (!pd) return;
  if (!dragging && !inspect) {
    const h = pick(e);
    if (sel && sel.swap) {
      const me = placements.get(sel.id);
      if (!h.card) setSel(null);
      else if (h.card !== me && !h.card.busy && !me.busy) swap(me, h.card);
    }
    else if (h.slot >= 0) applyAt(h.slot);
    else if (h.card && !h.card.busy) setSel(sel && sel.id === h.card.id ? null : { kind: 'placed', id: h.card.id });
    else if (!h.card) setSel(null);
  }
  pd = null; dragging = false; cv.style.cursor = 'grab';
});
cv.addEventListener('pointercancel', () => { pd = null; dragging = false; });
cv.addEventListener('pointerleave', () => { if (!pd) showTarget(1, -1); });
cv.addEventListener('wheel', e => { e.preventDefault(); view.zoom = clamp(view.zoom * (e.deltaY < 0 ? 1.08 : 0.926), 0.6, 3); }, { passive: false });
const turnBy = d => tween(view, 'yaw', view.yaw + d, 420, easeInOut);
document.getElementById('rotL').addEventListener('click', () => turnBy(-Math.PI / 2));
document.getElementById('rotR').addEventListener('click', () => turnBy(Math.PI / 2));
document.getElementById('resetView').addEventListener('click', () => {
  // 查看接口时回到进入查看时的视角
  const h = inspect ? inspect.home : { yaw: HOME_YAW, pitch: ISO, zoom: 1 };
  tween(view, 'yaw', nearAngle(h.yaw, view.yaw), 420, easeInOut); tween(view, 'pitch', h.pitch, 420, easeInOut); tween(view, 'zoom', h.zoom, 420, easeInOut);
});
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (inspect) exitInspect(); else setSel(null); }
  if (inspect) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel && sel.kind === 'placed') { const p = placements.get(sel.id); if (p && !p.busy) { touched(); removeCard(p); } }
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
  draw();   // 改尺寸会清空画布，当场重画一帧，否则会闪一下
}
new ResizeObserver(resize).observe(stage);

function frameLoop() {
  const now = performance.now();   // 与补间起点用同一个时钟
  for (const w of tweens) {
    const u = Math.min(1, (now - w.t0) / w.ms);
    w.o[w.k] = w.from + (w.to - w.from) * w.ease(u);
    if (u >= 1) { tweens.delete(w); w.res(); }
  }
  draw();
  requestAnimationFrame(frameLoop);
}
function draw() {
  const half = 100;
  if (aspect >= 1) { camera.top = half; camera.bottom = -half; camera.right = half * aspect; camera.left = -half * aspect; }
  else { camera.right = half; camera.left = -half; camera.top = half / aspect; camera.bottom = -half / aspect; }
  camera.zoom = view.zoom;
  TARGET.set(view.tx, view.ty, view.tz);
  const cp = Math.cos(view.pitch), D = 1200;
  camera.position.set(TARGET.x + D * cp * Math.sin(view.yaw), TARGET.y + D * Math.sin(view.pitch), TARGET.z + D * cp * Math.cos(view.yaw));
  camera.lookAt(TARGET);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  updateInspect();
  updateSlotMarks();
  renderer.render(scene, camera);
}

applyStatic(document);
applyTheme();
resize();
renderUI();
requestAnimationFrame(frameLoop);
// 先取背板，界面随即可用；板卡的模型同时开始下载，默认布局按槽位顺序一块一块插入
const wait = ms => new Promise(res => setTimeout(res, reduced ? 0 : ms));
let run = 0, layout = sys.initial;   // run：每次换布局或清空加一，用来中止还在进行的逐块插入
const fetchBoard = type => loadBoard(sys, type).then(() => { loaded.add(type); renderUI(); });
const orderSign = key => LAYOUTS[key] && LAYOUTS[key].order === 'desc' ? -1 : 1;
// 原地轻轻抬一下再落回：换布局时位置没变的板卡用它代替拔出重插
function bump(p) {
  if (p.busy || !placements.has(p.id)) return;
  p.busy = true;
  tween(p.group.position, 'y', SEAT_Y + 12, 170, easeOut)
    .then(() => tween(p.group.position, 'y', SEAT_Y, 230, easeIn))
    .then(() => { p.busy = false; });
}
// keep：布局里第 k 项 → 已经在位的板卡。这些不重新插，只依次起伏一下，连起来像一道波
async function playLayout(key, keep = new Map()) {
  const mine = ++run, list = LAYOUTS[key].boards;
  layout = key; renderLayouts();
  const jobs = list.map(c => fetchBoard(c[0]));
  // 插入顺序由布局的 order 决定：asc 从 1 号槽往后，desc 从最后一个槽往前
  const seq = list.map((_, k) => k).sort((a, b) => (list[a][1] - list[b][1]) * orderSign(key));
  for (const k of seq) {
    if (keep.has(k)) { bump(keep.get(k)); await wait(90); if (run !== mine) return; continue; }
    await jobs[k];
    if (run !== mine) return;
    place(list[k][0], list[k][1], true);
    await wait(260);
    if (run !== mine) return;
  }
  Object.keys(TYPES).forEach(fetchBoard);   // 布局里没有的板卡最后取
}
// 清空：从最后一个槽开始依次拔出。同时中止还没放完的布局。返回全部拔出所需的毫秒数
function clearAll() {
  run++;
  setSel(null);
  const list = [...placements.values()].sort((a, b) => b.slot - a.slot);
  list.forEach((p, k) => {
    p.busy = true;
    setTimeout(() => removeCard(p), reduced ? 0 : k * 170);
  });
  return reduced || !list.length ? 0 : (list.length - 1) * 170 + 700;
}
// 换成另一套布局：类型和槽位都对得上的板卡留在原位，其余的先依次拔出，再把缺的逐块插入
const layoutsEl = document.getElementById('layouts');
function loadLayout(key) {
  if (!ready || inspect) return;
  const mine = ++run, list = LAYOUTS[key].boards, keep = new Map(), drop = [], from = layout;
  setSel(null);
  layout = key; renderLayouts();
  placements.forEach(p => {
    const k = list.findIndex(c => c[0] === p.type && c[1] === p.slot);
    if (k >= 0) keep.set(k, p); else drop.push(p);
  });
  // 拔出顺序跟着原来那套布局的 order 走；从 Custom 换过来时从最后一个槽开始
  drop.sort((a, b) => (a.slot - b.slot) * (LAYOUTS[from].order ? orderSign(from) : -1)).forEach((p, k) => {
    p.busy = true;
    setTimeout(() => removeCard(p), reduced ? 0 : k * 170);
  });
  const ms = reduced || !drop.length ? 0 : (drop.length - 1) * 170 + 700;
  setTimeout(() => { if (run === mine) playLayout(key, keep); }, ms);
}
// 手动改动过板卡后，当前配置就不再是某套预设，选择器切到 Custom
function touched() { if (LAYOUTS.custom && layout !== 'custom') { layout = 'custom'; renderLayouts(); } }
function renderLayouts() {
  layoutsEl.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.key === layout)));
}
Object.entries(LAYOUTS).forEach(([key, L]) => {
  const b = document.createElement('button');
  b.type = 'button'; b.dataset.key = key; b.textContent = L.name;
  b.addEventListener('click', () => loadLayout(key));
  layoutsEl.appendChild(b);
});
renderLayouts();
loadBackplane(sys).then(() => {
  S = buildStructure(scene, sys);
  if (S.group) {
    bpCard = { isBackplane: true, busy: false, interfaces: [], pivot: S.group, group: S.group };
    addInterfaces(bpCard.interfaces, ifaceNotes('backplane'), S.interfaces);
  }
  // 镜头对准结构中心
  HOME.tx = view.tx = S.cx; HOME.tz = view.tz = S.cz;
  ready = true;
  renderUI();
  playLayout(sys.initial);
});
