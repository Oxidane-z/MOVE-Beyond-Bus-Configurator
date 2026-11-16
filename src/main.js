import * as THREE from 'three';
import sys from '../system.json';
import { t, applyStatic } from './i18n.js';
import { applyTheme, setResolution, drawSilhouette, drawDim, SIL_LAYER } from './render.js';
import { makeFlow } from './flow.js';
import { isFree as isFreeIn, fit as fitIn, swapPlan as swapPlanIn } from './slots.js';
import { inkOn } from './color.js';
import { LEVELS, boardPower, budget, railCurrents, fmtW, fmtH } from './power.js';
import { BRACKET_MODES, serialize, parse, presetCfg, defaultBracket } from './config.js';
import { buildStructure, buildCard as buildCardGeo, buildExpansion, loadBackplane, loadBoard, hasModel, setBracket } from './models.js';

const SLOTS = sys.slots, PITCH = sys.pitch, TYPES = sys.boards, LAYOUTS = sys.layouts, BACKPLANES = sys.backplanes;
let SEAT_Y = BACKPLANES[sys.backplane].seatY;   // 槽位连接器顶面的高度，随背板型号变
const slotZ = i => (i - (SLOTS - 1) / 2) * PITCH;
const buildCard = key => buildCardGeo(key, TYPES[key], PITCH);
// 板卡原点（连接器）所在的 Z。占两个槽的板卡，连接器可能在靠后的那个槽
const cardZ = (type, slot) => slotZ(slot + (TYPES[type].connectorSlot || 0));
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 槽位条和编号标记用分系统颜色（PCB 颜色在 MOVE-IIIa 里几乎都是绿的，区分不了板卡）；没写分系统的退回 PCB 颜色
const SUBS = sys.subsystems || {};
const tagColor = T => (SUBS[T.subsystem] || T).color;
// 库里还没有任何板卡填了功耗时，功耗相关的统计项和“power n/a”都不显示
const hasPower = Object.values(sys.boards).some(T => boardPower(T));
const RAILS = (sys.power && sys.power.rails) || {};
const railLabel = k => (RAILS[k] && RAILS[k].label) || k;
let layer = 'layout';   // 左侧面板和槽位条现在显示哪一层：'layout' 是板卡库，'power' 是功耗预算
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
let S = { cx: 0, cz: 0, hx: 52, hz: 52, topY: 7 };   // 结构尺寸，模型加载完后由 buildStructure 给出

/* ---------- 落位预览 ---------- */
// 光标指向可落位的槽时：背景里浮出槽位号，对应的编号标记变成强调色
const banner = document.getElementById('slotBanner'), slotMarks = [];
const stripCells = [];   // 第 i 槽对应槽位条上的哪一格（占两槽的板卡两个槽指向同一格）
function showTarget(w, slot) {
  const on = slot >= 0;
  banner.classList.toggle('on', on);
  if (on) banner.textContent = t('banner.slot', { n: w === 2 ? (slot + 1) + '–' + (slot + 2) : slot + 1 });
  slotMarks.forEach((b, i) => b.classList.toggle('target', on && i >= slot && i < slot + w));
  stripCells.forEach(c => c.classList.remove('target'));
  if (on) for (let i = slot; i < slot + w; i++) if (stripCells[i]) stripCells[i].classList.add('target');
}

/* ---------- 补间 ---------- */
// 画面只在有变化时重画：补间进行中，或者有人把 dirty 置为 true（界面更新、拖动、缩放、换主题）
let dirty = true;
const tweens = new Set();
const easeOut = x => 1 - Math.pow(1 - x, 3), easeIn = x => x * x, easeInOut = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
function killTween(o, k) { for (const w of tweens) if (w.o === o && w.k === k) { tweens.delete(w); w.res(); } }
function tween(o, k, to, ms, ease) {
  return new Promise(res => {
    killTween(o, k);
    dirty = true;
    if (reduced || ms <= 0) { o[k] = to; res(); return; }
    tweens.add({ o, k, from: o[k], to, ms, ease: ease || easeOut, t0: performance.now(), res });
  });
}

/* ---------- 配置状态 ---------- */
const slots = new Array(SLOTS).fill(null);
const placements = new Map();
const loaded = new Set();   // 模型（连同支架和扩展板）已就绪的板卡
let nextId = 1, sel = null;
const loading = new Set();  // 模型正在取的板卡
const pending = new Map();  // 槽位 → 已经指定要放在这里、模型还没取到的板卡
const redoStack = [];       // 撤销掉的配置，可以重做
const failed = new Set();   // 模型取不下来的板卡，可以重试
const undoStack = [];       // 每次改动前的配置（config.js 的文字形式）
let applying = false, targetSnap = '';   // 正在逐块换成另一套配置；targetSnap 是换完以后的样子

const isFree = (i, ignore) => isFreeIn(slots, i, ignore);
const fit = (w, i, ignore) => fitIn(slots, w, i, ignore);
function anyFit(w, ignore) { for (let i = 0; i < SLOTS; i++) if (fit(w, i, ignore) >= 0) return true; return false; }
function armed() {
  if (!sel || sel.swap) return null;
  if (sel.kind === 'lib') return { w: TYPES[sel.type].w, ignore: null };
  const p = placements.get(sel.id);
  return p ? { w: TYPES[p.type].w, ignore: p.id } : null;
}
function occupy(p, v) { for (let k = 0; k < TYPES[p.type].w; k++) slots[p.slot + k] = v; }

// opts：{ bracket, exps }，恢复一套配置时带上；不带就用默认的支架面和扩展板
function place(type, slot, animate, opts) {
  // 模型还没加载完，或者目标槽位已被占用时不放。加载期间抢先放板会和随后落下的默认布局叠在一起
  if (!ready || bpBusy || !loaded.has(type) || !hasModel(type)) return;
  for (let k = 0; k < TYPES[type].w; k++) if (!isFree(slot + k, null)) return;
  const built = buildCard(type);
  const p = { id: nextId++, type, slot, group: built.group, hit: built.hit, busy: false, interfaces: [], ownInterfaces: built.interfaces,
              pivot: built.pivot, body: built.body, front: built.front, faceOffset: built.faceOffset, cx: built.cx, cy: built.cy, top: built.top,
              bracket: built.bracket, bracketMode: (opts && opts.bracket) || defaultBracket(sys, type), loads: { ...(opts && opts.loads) }, exps: sitesOf(type).map(() => ({ key: null, exp: null, by: -1 })) };
  if (p.bracket) setBracket(p.bracket, p.bracketMode);
  sitesOf(type).forEach((site, i) => { const key = opts && !site.fixed ? opts.exps[i] : site.default; if (key) setExpansion(p, i, key); });
  rebuildInterfaces(p);
  built.hit.userData.id = p.id;
  p.group.position.set(0, SEAT_Y, cardZ(type, slot));
  placements.set(p.id, p);
  occupy(p, p.id);
  scene.add(p.group);
  if (animate) {
    p.busy = true;
    p.group.position.y = SEAT_Y + 140;
    tween(p.group.position, 'y', SEAT_Y + 7, 440, easeOut)
      .then(() => tween(p.group.position, 'y', SEAT_Y, 170, easeIn))
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
  if (e.exp) { p.body.remove(e.exp.obj); e.exp.interfaces.forEach(i => i.mat.dispose()); }
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
  tween(p.group.position, 'y', SEAT_Y + lift, 200, easeInOut)
    .then(() => tween(p.group.position, 'z', cardZ(p.type, p.slot), 240, easeInOut))
    .then(() => tween(p.group.position, 'y', SEAT_Y + 7, 220, easeOut))
    .then(() => tween(p.group.position, 'y', SEAT_Y, 140, easeIn))
    .then(() => { p.busy = false; });
}
const swapPlan = (A, B) => swapPlanIn(slots, { id: A.id, slot: A.slot, w: TYPES[A.type].w }, { id: B.id, slot: B.slot, w: TYPES[B.type].w });
function swap(A, B) {
  const plan = swapPlan(A, B);
  if (!plan) { sel = { kind: 'placed', id: A.id, swap: true, failed: TYPES[B.type].name }; renderUI(); return; }
  touched();
  occupy(A, null); occupy(B, null);
  A.slot = plan.get(A.id); B.slot = plan.get(B.id);
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
// 板卡升到多高算离开了画面
const exitY = () => SEAT_Y + 140 + Math.min(700, 2 * camera.top / view.zoom / Math.cos(Math.abs(view.pitch)));
function removeCard(p) {
  if (!placements.has(p.id)) return;
  occupy(p, null); placements.delete(p.id);
  p.busy = true; if (sel && sel.id === p.id) sel = null;
  // 先从连接器里拔出一小段，再加速上升直到离开画面。退出比进入快
  tween(p.group.position, 'y', SEAT_Y + 7, 180, easeInOut)
    .then(() => tween(p.group.position, 'y', exitY(), 420, easeIn))
    .then(() => {
      scene.remove(p.group);
      // 几何是各实例共享的模板，不释放；接口件的材质是这块板自己的
      p.ownInterfaces.forEach(i => i.mat.dispose());
      p.exps.forEach(e => { if (e.exp) e.exp.interfaces.forEach(i => i.mat.dispose()); });
    });
  renderUI();
}
function setSel(next) {
  sel = next;   // 选中的板抬起、其余落回，由 renderUI 里的 syncLift 按当前状态统一处理
  showTarget(1, -1);
  renderUI();
}
function applyAt(slot) {
  if (!sel || slot < 0) return;
  touched();
  if (sel.kind === 'lib') {
    // 模型还在路上就先记下要放哪，取到了再落位
    const type = sel.type;
    if (loaded.has(type)) place(type, slot, true);
    else {
      pending.set(slot, type);
      fetchBoard(type).then(() => {
        if (pending.get(slot) !== type) return;   // 这期间换了整套配置，或者这个槽改放了别的
        pending.delete(slot); place(type, slot, true); renderUI();
      });
      renderUI();
    }
  }
  else { const p = placements.get(sel.id); if (p && !p.busy) move(p, slot); }
  showTarget(1, -1);
}
// 点槽位（3D 里的编号标记或下方槽位条）：选了板卡就落位，否则选中槽里的板
function slotClick(i) {
  if (inspect || layer === 'power') return;
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
function slotHover(i) { const a = armed(); if (a && !inspect && layer !== 'power') showTarget(a.w, fit(a.w, i, a.ignore)); }

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

// 查看背板时板卡整体升出画面再藏起来，回来时落回原位
function stashCards(away) {
  placements.forEach(q => {
    if (q.leaving) return;
    q.busy = true;
    if (away) tween(q.group.position, 'y', exitY(), 340, easeIn).then(() => { if (inspect && inspect.p.isBackplane) q.group.visible = false; });
    else {
      q.group.visible = true;
      tween(q.group.position, 'y', SEAT_Y + 7, 320, easeOut)
        .then(() => tween(q.group.position, 'y', SEAT_Y, 150, easeIn))
        .then(() => { q.busy = false; });
    }
  });
}
// 镜头该对准哪里：平时是结构中心，查看接口时是被查看的板
const homeTarget = () => !inspect ? [HOME.tx, HOME.ty, HOME.tz]
  : inspect.p.isBackplane ? [S.cx, S.topY, S.cz] : [inspect.p.cx, SEAT_Y + LIFT + inspect.p.cy, cardZ(inspect.p.type, inspect.p.slot)];
function enterInspect(p) {
  if (inspect || p.busy || !p.interfaces.length) return;
  sel = null; showTarget(1, -1);
  const back = { yaw: view.yaw, pitch: view.pitch, zoom: view.zoom };
  inspect = { p, back, home: null, hover: null, pinned: null, marks: [], items: [] };

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
    // 点了板上的标记，左侧列表滚到对应的条目
    m.addEventListener('click', () => it.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' }));
    marks.appendChild(m); ifaceList.appendChild(it);
    inspect.marks.push(m); inspect.items.push(it);
  });

  if (p.isBackplane) {
    stashCards(true);
    inspect.home = { yaw: view.yaw, pitch: BP_PITCH, zoom: Math.max(view.zoom, 1.5) };
    tween(view, 'tx', S.cx, 520, easeInOut); tween(view, 'tz', S.cz, 520, easeInOut); tween(view, 'ty', S.topY, 520, easeInOut);
  } else {
    p.busy = true; p.spin = { spin: 0, yaw: normYaw() };
    inspect.home = { yaw: view.yaw, pitch: back.pitch, zoom: Math.max(view.zoom, 1.9) };
    tween(view, 'tx', p.cx, 520, easeInOut); tween(view, 'tz', cardZ(p.type, p.slot), 520, easeInOut);
    tween(view, 'ty', SEAT_Y + LIFT + p.cy, 520, easeInOut);
    tween(p.group.position, 'y', SEAT_Y + LIFT, 340, easeInOut)
      .then(() => tween(p.spin, 'spin', 1, 340, easeInOut));
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
  p.interfaces.forEach(i => tween(i.mat.uniforms.uMix, 'value', 0, 300, easeOut));
  tween(view, 'tx', HOME.tx, 500, easeInOut); tween(view, 'ty', HOME.ty, 500, easeInOut); tween(view, 'tz', HOME.tz, 500, easeInOut);
  tween(view, 'yaw', nearAngle(back.yaw, view.yaw), 500, easeInOut);
  tween(view, 'pitch', back.pitch, 500, easeInOut); tween(view, 'zoom', back.zoom, 500, easeInOut);
  if (p.isBackplane) stashCards(false);
  else tween(p.spin, 'spin', 0, 260, easeInOut)
    .then(() => tween(p.group.position, 'y', SEAT_Y + 7, 240, easeOut))
    .then(() => tween(p.group.position, 'y', SEAT_Y, 140, easeIn))
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

/* ---------- 悬停信息 ---------- */
// 鼠标停在一块板上（三维视图里或槽位条上）：板卡描出剪影，上方浮出一张信息卡。触屏没有悬停，选中后的操作栏起同样的作用
const hoverEl = document.getElementById('hoverCard');
let hover = null;
const silMeshes = p => { const out = []; p.group.traverse(o => { if (o.isMesh && !o.isLineSegments2 && o !== p.hit) out.push(o); }); return out; };
function setHover(p) {
  if (p === hover) return;
  if (hover) silMeshes(hover).forEach(o => o.layers.disable(SIL_LAYER));
  hover = p; dirty = true;
  hoverEl.hidden = !p;
  if (!p) return;
  silMeshes(p).forEach(o => o.layers.enable(SIL_LAYER));
  const T = TYPES[p.type], sub = SUBS[T.subsystem];
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const dot = color => { const d = el('span', 'dot'); d.style.background = color; return d; };
  hoverEl.textContent = '';
  // 第一行：PCB 色块和名称；第二行：分系统、代际、所在槽位
  const hd = el('div', 'hd'), sw = el('span', 'sw');
  sw.style.background = T.color; hd.appendChild(sw); hd.appendChild(el('span', 'nm', T.name));
  hoverEl.appendChild(hd);
  const mt = el('div', 'mt');
  if (sub) mt.appendChild(dot(sub.color));
  mt.appendChild(document.createTextNode([sub && sub.label, sys.levels[T.level] || T.level,
    t('banner.slot', { n: T.w === 2 ? (p.slot + 1) + '–' + (p.slot + 2) : p.slot + 1 })].filter(Boolean).join(' · ')));
  hoverEl.appendChild(mt);
  if (T.desc) hoverEl.appendChild(el('div', 'ds', T.desc));
  const row = (label, node) => { const r = el('div', 'row'); r.appendChild(el('span', 'k', label)); r.appendChild(node); hoverEl.appendChild(r); };
  // 接口按类型计数，色点用接口类型的颜色
  if (p.interfaces.length) {
    const counts = new Map();
    p.interfaces.forEach(i => counts.set(i.note.type, (counts.get(i.note.type) || 0) + 1));
    const v = el('span', 'v');
    counts.forEach((n, type) => {
      const I = sys.interfaceTypes[type] || { label: type, color: '#cccccc' }, c = el('span', 'tag');
      c.appendChild(dot(I.color)); c.appendChild(document.createTextNode(n + ' ' + I.label)); v.appendChild(c);
    });
    row(t('hover.interfaces'), v);
  }
  sitesOf(p.type).forEach((site, i) => {
    const e = p.exps[i];
    if (!site.fixed && site.options.length && e.by < 0) row(site.name, el('span', 'v', e.key ? sys.expansions[e.key].name : t('expansion.none')));
  });
  if (p.bracket) row(t('bracket'), el('span', 'v', t('bracket.' + p.bracketMode)));
  if (T.wh) row(t('hover.capacity'), el('span', 'v', T.wh + ' Wh'));
  const bp = powerOf(p);
  if (bp) row(t('hover.power'), el('span', 'v', fmtW(bp.now) + ' (' + LEVELS.map(k => fmtW(bp[k]).replace(' W', '')).join(' / ') + ')'));
}
// 重画时：悬停的板不在了、动起来了或者进了别的模式就收起；信息卡贴在板卡上沿的上方，不出舞台
function updateHover() {
  if (hover && (!placements.has(hover.id) || hover.busy || inspect || bpBusy || pd || cellDrag)) setHover(null);
  if (!hover) return;
  const g = hover.group.position, W = stage.clientWidth, hw = hoverEl.offsetWidth / 2, hh = hoverEl.offsetHeight;
  _v.set(g.x + hover.cx, g.y + hover.top, g.z).project(camera);
  hoverEl.style.left = clamp((_v.x * 0.5 + 0.5) * W, hw + 8, W - hw - 8).toFixed(1) + 'px';
  hoverEl.style.top = Math.max((-_v.y * 0.5 + 0.5) * stage.clientHeight, hh + 20).toFixed(1) + 'px';
}

/* ---------- 槽位编号标记 ---------- */
const slotMarksEl = document.getElementById('slotMarks');
let ready = false, bpBusy = false;   // bpBusy：正在换背板（板卡悬在半空，新旧背板在滑动）
for (let i = 0; i < SLOTS; i++) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'slotmark'; b.textContent = i + 1; b.hidden = true;
  b.addEventListener('click', () => slotClick(i));
  b.addEventListener('mouseenter', () => slotHover(i));
  b.addEventListener('mouseleave', () => showTarget(1, -1));
  slotMarksEl.appendChild(b);
  slotMarks.push(b);
}
// 重画时：标记贴在背板靠镜头一侧的边上。相邻两个标记在屏幕上挤到一起时（窄屏）整排隐藏，下方的槽位条有同样的功能
function updateSlotMarks() {
  const x = S.cx + (Math.sin(view.yaw) >= 0 ? 1 : -1) * (S.hx + 8);
  const w = stage.clientWidth, h = stage.clientHeight;
  _v.set(x, S.topY, slotZ(0)).project(camera); const ax = _v.x, ay = _v.y;
  _v.set(x, S.topY, slotZ(1)).project(camera);
  const crowded = Math.max(Math.abs(_v.x - ax) * w, Math.abs(_v.y - ay) * h) / 2 < 16;
  slotMarks.forEach((b, i) => {
    b.hidden = !!inspect || !ready || crowded || bpBusy || layer === 'power';
    if (!b.hidden) toScreen(_v.set(x, S.topY, slotZ(i)), b);
  });
}

/* ---------- 界面 ---------- */
const libList = document.getElementById('libList'), strip = document.getElementById('strip'),
      hint = document.getElementById('hint'), stats = document.getElementById('stats'), undoBtn = document.getElementById('undo'),
      redoBtn = document.getElementById('redo'), shareBtn = document.getElementById('share'), toast = document.getElementById('toast');
let cellDrag = null, suppressClick = false;   // 在槽位条上拖动板卡

Object.keys(TYPES).forEach(key => {
  const T = TYPES[key], b = document.createElement('button');
  b.type = 'button'; b.className = 'item'; b.id = 'lib-' + key; b.dataset.type = key;
  b.innerHTML = '<span class="sw"></span><span><span class="nm"></span><br><span class="mt"></span></span>';
  b.querySelector('.sw').style.background = T.color;
  b.querySelector('.nm').textContent = T.name;
  const meta = [...(SUBS[T.subsystem] ? [SUBS[T.subsystem].label] : []), sys.levels[T.level] || T.level, T.w === 1 ? t('meta.slots.1') : t('meta.slots.n', { n: T.w }),
                ...(T.wh ? [T.wh + ' Wh'] : boardPower(T) ? [fmtW(boardPower(T).typ)] : hasPower ? [t('meta.noPower')] : [])];
  if (ifaceNotes(key).length) meta.push(t('meta.interfaces', { n: ifaceNotes(key).length }));
  b.querySelector('.mt').textContent = meta.join(' · ');
  // 色块是 PCB 颜色；分系统颜色（槽位条用的那套）用一个小圆点带上
  if (SUBS[T.subsystem]) { const d = document.createElement('span'); d.className = 'dot'; d.style.background = SUBS[T.subsystem].color; b.querySelector('.mt').prepend(d); }
  // 模型到点选时才取
  b.addEventListener('click', () => {
    const on = sel && sel.kind === 'lib' && sel.type === key;
    setSel(on ? null : { kind: 'lib', type: key });
    if (!on) fetchBoard(key);
  });
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

/* ---------- 功耗预算面板 ---------- */
const powerPanel = document.getElementById('powerPanel'), layerBtn = document.getElementById('layerToggle');
const appEl = document.getElementById('app');
// 功耗层里配置是锁住的：不能选板、落位、互换、移除，也不能换布局和背板，只能切换负载的状态
function setLayer(next) {
  if (inspect || layer === next) return;
  layer = next;
  appEl.classList.toggle('power', layer === 'power');
  tween(dim, 'a', layer === 'power' ? DIM : 0, 250, easeInOut);
  setHover(null);
  setSel(null);   // 里面会 renderUI
}
layerBtn.addEventListener('click', () => setLayer(layer === 'power' ? 'layout' : 'power'));
const powerOf = p => boardPower(TYPES[p.type], p.loads);
// 左侧面板的功耗层：每块已放置的板一行——当前功耗，下面是待机 / 典型 / 峰值的范围和各电源轨上的当前值，
// 再下面是这块板的负载，各有一组按钮切换状态；最后是合计、各轨合计、电池和续航
function renderPower(B) {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const num = v => fmtW(v).replace(' W', '');
  powerPanel.textContent = '';
  powerPanel.appendChild(el('h2', '', t('power.title')));
  const list = [...placements.values()].sort((a, b) => a.slot - b.slot);
  if (!list.length) { powerPanel.appendChild(el('p', 'note', t('power.empty'))); return; }
  const rowsEl = el('div', 'list');
  list.forEach(p => {
    const T = TYPES[p.type], bp = powerOf(p), sub = SUBS[T.subsystem], r = el('div', 'prow');
    const nm = el('span', 'nm');
    if (sub) { const d = el('span', 'dot'); d.style.background = sub.color; nm.appendChild(d); }
    nm.appendChild(document.createTextNode(T.name));
    r.appendChild(el('span', 'no', T.w === 2 ? (p.slot + 1) + '–' + (p.slot + 2) : String(p.slot + 1)));
    r.appendChild(nm);
    r.appendChild(el('span', 'val' + (bp || T.wh ? '' : ' none'), bp ? fmtW(bp.now) : T.wh ? T.wh + ' Wh' : t('power.noData')));
    if (bp) {
      r.appendChild(el('span', 'sub', t('power.range', { idle: num(bp.idle), typ: num(bp.typ), peak: num(bp.peak) }) + ' W · ' + t('power.source.' + bp.source)));
      const parts = Object.entries(bp.rails).map(([k, v]) => railLabel(k) + ' ' + fmtW(v.now));
      if (parts.length) r.appendChild(el('span', 'sub', parts.join(' · ')));
      // 峰值电流超过单槽上限的电源轨
      railCurrents(bp, RAILS).filter(c => c.over).forEach(c => {
        r.classList.add('over');
        r.appendChild(el('span', 'warn', t('power.over', { rail: railLabel(c.rail), a: c.amps.toFixed(1), limit: c.limit })));
      });
      bp.loads.forEach(L => {
        const row = el('div', 'load'), left = el('span'), seg = el('div', 'seg');
        const iface = L.interface && ifaceNotes(p.type).find(n => n.ref === L.interface);
        left.appendChild(el('span', 'ln', L.name + (iface ? ' (' + iface.label + ')' : '')));
        left.appendChild(el('span', 'lr', (L.rail ? railLabel(L.rail) + ' ' : '') + fmtW(L.watts)));
        seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', L.name);
        Object.keys(L.states).forEach(st => {
          const b = el('button', '', st);
          b.type = 'button'; b.title = fmtW(L.states[st]); b.setAttribute('aria-pressed', String(st === L.state));
          // 负载状态不进撤销记录，也不算改了布局（预设仍然是那套预设）；它会跟着分享链接走
          b.addEventListener('click', () => { if (st === L.state) return; p.loads = { ...p.loads, [L.key]: st }; renderUI(); });
          seg.appendChild(b);
        });
        row.appendChild(left); row.appendChild(seg); r.appendChild(row);
      });
    }
    rowsEl.appendChild(r);
  });
  powerPanel.appendChild(rowsEl);
  const dl = el('dl', 'ptotal'), kv = (k, v) => { const d = el('div'); d.appendChild(el('dt', '', k)); d.appendChild(el('dd', '', v)); dl.appendChild(d); };
  const levels = ['now', ...LEVELS];
  if (B.counted) {
    levels.forEach(k => kv(t('power.' + k), fmtW(B[k])));
    Object.keys(RAILS).filter(k => B.rails[k]).forEach(k => kv(railLabel(k) + ' · ' + t('power.now').toLowerCase(), fmtW(B.rails[k].now)));
  }
  kv(t('power.capacity'), B.wh.toFixed(1) + ' Wh');
  if (B.wh > 0 && B.usable !== B.wh) kv(t('power.usable'), B.usable.toFixed(1) + ' Wh');
  if (B.counted) levels.forEach(k => kv(t('power.runtime') + ' · ' + t('power.' + k).toLowerCase(), fmtH(B.runtime[k])));
  powerPanel.appendChild(dl);
  if (!B.counted) powerPanel.appendChild(el('p', 'note', t('power.none')));
  else if (B.missing) powerPanel.appendChild(el('p', 'note', t('power.missing', { n: B.missing })));
}

/* ---------- 电源分布图 ---------- */
// 功耗层里叠在压暗的模型上，固定在结构上（不随镜头换边）：
//   干线  三条电源轨并排铺在背板上表面，沿槽位排列方向贯穿，从板卡底下穿过；在连接器长度方向上各占一条车道
//   降压  干线在 7 号槽外侧的一端，VSYS 横着接到 5V 和 3V3 的起点
//   支线  每块板从它实际插着的那个槽的连接器位置垂直升进板内，用到哪条轨就从哪条车道升起，停在板的中上部
//   电池  从它的连接器向下汇入 VSYS 干线，汇入点是充电芯片；外部充电口是向下的一条虚线
//   标签  板卡的功率挂在支线顶端；干线的标签在干线伸出背板的那一端（1 号槽外侧）
// 线宽随当前功率变化，没有电流的支路是虚线。光点从电池出发沿线路流动，只表示方向（flow.js）；
// 系统开了“减少动态效果”时不动，改成静态的箭头
const DIM = 0.8, dim = { a: 0 };
const LANE = 10, PULSE_S = 1.6;   // 车道间距（mm）；脉动周期（秒）
const flow = makeFlow(), flowMarks = document.getElementById('flowMarks');
let flowNodes = [], flowDirty = true, flowOn = false;
const RAIL_KEYS = Object.keys(RAILS);
function rebuildFlow() {
  flow.clear(); flowMarks.textContent = ''; flowNodes = [];
  const list = [...placements.values()].filter(p => !p.leaving && !p.busy);
  const B = budget(list.map(p => ({ T: TYPES[p.type], sel: p.loads })), sys.power);
  const max = Math.max(B.draw.now, 1e-6), wOf = w => 1.6 + 5 * Math.sqrt(Math.max(w, 0) / max);
  const colorOf = k => (RAILS[k] && RAILS[k].color) || '#cccccc';
  const casing = getComputedStyle(document.documentElement).getPropertyValue('--line3d').trim() || '#000000';
  const node = (x, y, z, text, bg) => {
    const e = document.createElement('span');
    e.className = 'fnode' + (bg ? '' : ' plain'); e.textContent = text;
    if (bg) { e.style.background = bg; e.style.color = inkOn(bg); }
    flowMarks.appendChild(e); flowNodes.push({ e, pos: new THREE.Vector3(x, y, z), w: 0, h: 0, x: 0, y: 0 });
  };
  const NV = Math.max(0, RAIL_KEYS.indexOf('vsys'));
  const y = S.topY + 0.6;                                              // 干线贴着背板上表面
  const lane = n => (n - (RAIL_KEYS.length - 1) / 2) * LANE;          // 第 n 条轨的车道；槽位连接器的中心在 X = 0
  const zFace = p => p.group.position.z + p.front * 1.1;               // 支线贴在 PCB 正面外一点，不埋在板子里
  // 支线顶端按槽位错开三档高度，相邻板卡的标签才不会压在一起
  const topOf = p => SEAT_Y + p.top * (0.5 + 0.16 * (Math.round(p.group.position.z / PITCH + (SLOTS - 1) / 2) % 3));
  const zBuck = Math.min(slotZ(SLOTS - 1) + PITCH * 0.5, S.cz + S.hz - 2);
  const zLink = n => zBuck + Math.max(0, Math.abs(n - NV) - 1) * 3.5;  // 各路降压的横线错开
  const zTail = n => S.cz - S.hz - 7 - n * 18;                         // 干线伸出背板的末端，三条错开，标签才排得开

  // 离电池的线路距离。有几块电池就取最近的那块；没有电池就没有脉动
  const bats = list.filter(p => TYPES[p.type].wh).map(p => ({ p, z: p.group.position.z, zf: zFace(p), top: topOf(p) }));
  bats.forEach(b => { b.len = (b.top - y) + Math.abs(b.zf - b.z); });
  const pulse = bats.length > 0 && !reduced;
  const dV = z => bats.length ? Math.min(...bats.map(b => b.len + Math.abs(z - b.z))) : 0;
  const dTrunk = (n, z) => n === NV ? dV(z) : dV(zLink(n)) + Math.abs(lane(n) - lane(NV)) + (zLink(n) - z);
  const opt = (w, dead) => ({ width: wOf(w), casing, dead: dead != null ? dead : w <= 0, pulse });
  // 静态的方向箭头（减少动态效果时代替脉动）：在 at 处画一个指向 dir 的小尖角，两翼沿 perp 张开
  const arrow = (at, dir, perp, color) => {
    if (!reduced || !bats.length) return;
    const tip = at.map((v, i) => v + dir[i] * 2.6);
    [1, -1].forEach(sgn => flow.line([at.map((v, i) => v - dir[i] * 2.6 + perp[i] * 3 * sgn), tip], [0, 0], color, { width: 1.8, casing, dead: false, pulse: false }));
  };

  // 干线和降压。VSYS 上走的是电池端的总功率（含降压损耗），其余两条是各自的合计
  const stops = [...new Set([...Array.from({ length: SLOTS }, (_, i) => slotZ(i)), ...bats.map(b => b.z)])].sort((a, b) => a - b);
  RAIL_KEYS.forEach((k, n) => {
    const w = k === 'vsys' ? B.draw.now : B.rails[k] ? B.rails[k].now : 0, color = colorOf(k);
    const zEnd = n === NV ? Math.max(...RAIL_KEYS.map((_, m) => zLink(m))) : zLink(n);
    const zs = [zTail(n), ...stops, zEnd];
    flow.line(zs.map(z => [lane(n), y, z]), zs.map(z => dTrunk(n, z)), color, opt(w));
    if (n !== NV) {
      flow.line([[lane(NV), y, zLink(n)], [lane(n), y, zLink(n)]], [dV(zLink(n)), dTrunk(n, zLink(n))], color, opt(w));
      if (w > 0) arrow([(lane(NV) + lane(n)) / 2, y, zLink(n)], [Math.sign(lane(n) - lane(NV)), 0, 0], [0, 0, 1], color);
    }
    if (w > 0) for (let i = 0; i + 1 < zs.length; i++) {
      const zm = (zs[i] + zs[i + 1]) / 2, dir = dTrunk(n, zs[i + 1]) >= dTrunk(n, zs[i]) ? 1 : -1;
      if (i > 0) arrow([lane(n), y, zm], [0, 0, dir], [1, 0, 0], color);
    }
    node(lane(n), y, zTail(n) - 3, railLabel(k) + ' ' + fmtW(w), color);
  });

  // 电池：从板里向下汇入 VSYS 干线，汇入点是充电芯片；外部充电口在背板背面
  bats.forEach(b => {
    const T = TYPES[b.p.type], share = B.wh > 0 ? B.draw.now * T.wh / B.wh : 0, x = lane(NV), color = colorOf(RAIL_KEYS[NV]);
    flow.line([[x, b.top, b.zf], [x, y, b.zf], [x, y, b.z]], [0, b.top - y, b.len], color, opt(share));
    if (share > 0) arrow([x, (b.top + y) / 2, b.zf], [0, -1, 0], [1, 0, 0], color);
    node(x, b.top + 4, b.zf, t('flow.battery') + ' ' + (T.wh * (B.wh > 0 ? B.usable / B.wh : 1)).toFixed(1) + ' Wh', tagColor(T));
    if (sys.power.charger) node(x, y, b.z, sys.power.charger, null);
    if (sys.power.external) {
      flow.line([[x, y - 24, b.z], [x, y, b.z]], [0, 24], color, opt(0, true));
      node(x, y - 24, b.z, sys.power.external, null);
    }
  });

  // 板卡：从它插着的那个槽的连接器位置，沿各自的车道升进板内
  list.forEach(p => {
    const T = TYPES[p.type], bp = T.wh ? null : powerOf(p);
    if (!bp) return;
    const used = RAIL_KEYS.filter(k => bp.rails[k]), zc = p.group.position.z, zf = zFace(p), top = topOf(p);
    if (!used.length) return;
    used.forEach(k => {
      const n = RAIL_KEYS.indexOf(k), w = bp.rails[k].now, x = lane(n), d0 = dTrunk(n, zc), jog = Math.abs(zf - zc);
      flow.line([[x, y, zc], [x, y, zf], [x, top, zf]], [d0, d0 + jog, d0 + jog + top - y], colorOf(k), opt(w));
      if (w > 0) arrow([x, (top + y) / 2, zf], [0, 1, 0], [1, 0, 0], colorOf(k));
    });
    node(used.reduce((a, k) => a + lane(RAIL_KEYS.indexOf(k)), 0) / used.length, top + 4, zf, fmtW(bp.now), tagColor(T));
  });
  flowNodes.forEach(n => { n.w = n.e.offsetWidth; n.h = n.e.offsetHeight; });   // 标签的尺寸只在重建时量一次
}
// 重画时：配置、负载或主题变了就重建；然后推进脉动的相位，把节点标签投影到屏幕上
function updateFlow() {
  const on = layer === 'power' && !inspect && ready && !bpBusy;
  flowMarks.hidden = !on;
  flowOn = on;
  if (!on) return false;
  if (flowDirty) { rebuildFlow(); flowDirty = false; }
  flow.setPhase((performance.now() / 1000 / PULSE_S) % 1);
  // 标签先投影到各自的位置，不进右上角工具栏那一条；从某些角度看（或者屏幕很窄时）会有标签落在一起，
  // 这时从上往下排，把压住的那个往下推开，推到不压住为止
  const W = stage.clientWidth, H = stage.clientHeight;
  flowNodes.forEach(n => { _v.copy(n.pos).project(camera); n.x = clamp((_v.x * 0.5 + 0.5) * W, n.w / 2 + 4, W - n.w / 2 - 4); n.y = Math.max((-_v.y * 0.5 + 0.5) * H, 52 + n.h / 2); });
  const placed = [];
  [...flowNodes].sort((a, b) => a.y - b.y).forEach(n => {
    for (let guard = 0; guard < 12; guard++) {
      const hit = placed.find(m => Math.abs(m.x - n.x) < (m.w + n.w) / 2 + 2 && Math.abs(m.y - n.y) < (m.h + n.h) / 2 + 1);
      if (!hit) break;
      n.y = hit.y + (hit.h + n.h) / 2 + 2;
    }
    placed.push(n);
  });
  // 往下推可能把最底下的几个推出舞台：再从下往上排一遍，贴住下边缘，压住的往上顶
  const fixed = [];
  placed.sort((a, b) => b.y - a.y).forEach(n => {
    n.y = Math.min(n.y, H - n.h / 2 - 4);
    for (let guard = 0; guard < 12; guard++) {
      const hit = fixed.find(m => Math.abs(m.x - n.x) < (m.w + n.w) / 2 + 2 && Math.abs(m.y - n.y) < (m.h + n.h) / 2 + 1);
      if (!hit) break;
      n.y = hit.y - (hit.h + n.h) / 2 - 2;
    }
    fixed.push(n);
    n.e.style.left = n.x.toFixed(1) + 'px'; n.e.style.top = n.y.toFixed(1) + 'px';
  });
  return true;
}

// 选中的那块板抬起一点，其余的都落回槽里。每次界面更新时按当前的选中状态重新对一遍，
// 而不是只在“换选中”的那一刻动这两块板：有些路径直接改了选中（互换失败、撤销），靠增量更新会留下悬在半空的板
function syncLift() {
  placements.forEach(p => {
    if (p.busy) { p.lifted = false; return; }   // 正在做别的动画，结束时落在槽里
    const want = !inspect && !!sel && sel.kind === 'placed' && sel.id === p.id;
    if (!!p.lifted === want) return;
    p.lifted = want;
    tween(p.group.position, 'y', want ? SEAT_Y + 10 : SEAT_Y, 220, want ? easeOut : easeInOut);
  });
}
function renderUI() {
  dirty = true; flowDirty = true;
  syncLift();
  // 操作栏和槽位条每次整体重建。记下键盘焦点在哪个按钮上，重建后还给同一个按钮
  const ae = document.activeElement, refocus = ae && (hint.contains(ae) || strip.contains(ae)) ? { id: ae.id, act: ae.dataset.act } : null;
  libPanel.hidden = !!inspect || layer !== 'layout'; ifacePanel.hidden = !inspect;
  powerPanel.hidden = !!inspect || layer !== 'power';
  layerBtn.setAttribute('aria-pressed', String(layer === 'power')); layerBtn.disabled = !!inspect;
  const B = budget([...placements.values()].map(p => ({ T: TYPES[p.type], sel: p.loads })), sys.power);
  if (!powerPanel.hidden) renderPower(B);
  libList.querySelectorAll('.item').forEach(b => {
    b.disabled = !ready;
    b.classList.toggle('loading', loading.has(b.dataset.type));
    b.setAttribute('aria-pressed', String(!!sel && sel.kind === 'lib' && sel.type === b.dataset.type));
  });
  const a = inspect ? null : armed();

  // 查看接口时不能换布局和背板
  document.querySelectorAll('#layouts button, #backplanes button').forEach(b => { b.disabled = !!inspect; });
  // 互换模式下，哪些板卡换得了
  const me = !inspect && sel && sel.swap ? placements.get(sel.id) : null;
  strip.textContent = ''; stripCells.length = 0;
  let pendSpan = 0;
  for (let i = 0; i < SLOTS; i++) {
    const id = slots[i], p = id === null ? null : placements.get(id);
    const selected = !!p && !!sel && sel.kind === 'placed' && sel.id === p.id;
    // 可以落位（互换模式下是可以互换）的槽。3D 里的编号标记和槽位条用同一套状态，窄屏上编号标记会隐藏
    const ok = me ? !!p && p !== me && !p.busy && !!swapPlan(me, p) : !!a && fit(a.w, i, a.ignore) >= 0;
    const dim = !!me && !!p && p !== me && !ok;
    const mk = slotMarks[i];
    mk.className = 'slotmark' + (p ? ' full' : '') + (selected ? ' sel' : '') + (ok ? ' ok' : '') + (dim ? ' dim' : '');
    mk.style.background = p ? tagColor(TYPES[p.type]) : ''; mk.style.color = p ? inkOn(tagColor(TYPES[p.type])) : '';
    mk.setAttribute('aria-label', t('aria.slot', { n: i + 1, what: p ? TYPES[p.type].name : t('aria.empty') }));

    if ((p && p.slot !== i) || pendSpan > 0) { if (!p) pendSpan--; stripCells[i] = stripCells[i - 1]; continue; }
    const c = document.createElement('button');
    c.type = 'button'; c.className = 'cell' + (ok ? ' ok' : '') + (dim ? ' dim' : ''); c.id = 'slot-' + (i + 1); c.dataset.slot = i;
    const no = document.createElement('span'); no.className = 'no';
    const pend = !p && pending.has(i) ? TYPES[pending.get(i)] : null;
    const label = (T, w, text, aria) => {
      c.style.gridColumn = 'span ' + w;
      no.textContent = w === 2 ? (i + 1) + '–' + (i + 2) : String(i + 1);
      const lb = document.createElement('span'); lb.className = 'lb'; lb.textContent = text;
      c.appendChild(lb);
      c.setAttribute('aria-label', t(aria, { n: no.textContent, what: text }));
    };
    if (p) {
      const T = TYPES[p.type];
      c.classList.add('full'); c.style.background = tagColor(T); c.style.color = inkOn(tagColor(T));
      if (selected) c.classList.add('sel');
      if (cellDrag && cellDrag.active && cellDrag.id === p.id) c.classList.add('drag');
      label(T, T.w, T.name + levelSuffix(T), 'aria.slot');
      if (layer === 'power') {
        // 功耗层：格子换成中性底色，第二行是当前功耗（电池是容量）
        const bp = powerOf(p), pv = document.createElement('span');
        c.classList.add('pw'); c.style.background = ''; c.style.color = '';
        pv.className = 'pv'; pv.textContent = bp ? fmtW(bp.now) : T.wh ? T.wh + ' Wh' : '—';
        c.appendChild(pv);
      }
      c.addEventListener('mouseenter', () => { if (!cellDrag && !inspect && !p.busy) setHover(p); });
      c.addEventListener('mouseleave', () => setHover(null));
    } else if (pend) {
      // 已经指定放在这里、模型还在路上：先占个位，免得点了以后一片空白
      const w = pend.w === 2 && i + 1 < SLOTS && slots[i + 1] === null ? 2 : 1;
      c.classList.add('pending'); pendSpan = w - 1;
      label(pend, w, pend.name, 'aria.slotLoading');
    } else {
      no.textContent = String(i + 1);
      c.setAttribute('aria-label', t('aria.slot', { n: i + 1, what: t('aria.empty') }));
    }
    c.addEventListener('mouseenter', () => slotHover(i));
    c.addEventListener('mouseleave', () => showTarget(1, -1));
    c.addEventListener('click', () => slotClick(i));
    c.appendChild(no);
    strip.appendChild(c);
    stripCells[i] = c;
  }

  hint.textContent = '';
  const span = document.createElement('span');
  const btn = (label, cls, fn, act) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.dataset.act = act; if (cls) b.className = cls; b.addEventListener('click', fn); return b; };
  hint.appendChild(span);
  if (layer === 'power' && !inspect) {
    span.textContent = t('hint.power');
    hint.appendChild(btn(t('btn.back'), 'ghost', () => setLayer('layout'), 'back'));
  } else if (inspect) {
    span.textContent = t('hint.inspect', { name: nameOf(inspect.p) });
    hint.appendChild(btn(t('btn.flip'), '', flipInspect, 'flip'));
    hint.appendChild(btn(t('btn.back'), 'ghost', exitInspect, 'back'));
  } else if (!sel) {
    span.textContent = !ready ? t('hint.loading') : failed.size ? t('hint.failed', { names: [...failed].map(k => TYPES[k].name).join(', ') }) : t('hint.idle');
    if (bpCard && bpCard.interfaces.length && !applying && !bpBusy) hint.appendChild(btn(t('btn.backplane'), 'ghost', () => enterInspect(bpCard), 'backplane'));
  } else if (sel.kind === 'lib') {
    const T = TYPES[sel.type];
    span.textContent = failed.has(sel.type) ? t('hint.loadFailed', { name: T.name })
      : (loaded.has(sel.type) ? '' : t('hint.loadingBoard') + ' ') + t((anyFit(T.w, null) ? 'hint.place' : 'hint.noRoom') + (T.w === 2 ? '2' : ''), { name: T.name });
    hint.appendChild(btn(t('btn.cancel'), 'ghost', () => setSel(null), 'cancel'));
  } else if (sel.swap) {
    const name = TYPES[placements.get(sel.id).type].name;
    span.textContent = sel.failed ? t('hint.swapNoRoom', { name, other: sel.failed }) : t('hint.swap', { name });
    hint.appendChild(btn(t('btn.cancel'), 'ghost', () => setSel(null), 'cancel'));
  } else {
    const p = placements.get(sel.id);
    // 除了自己现在的位置，还有没有别的槽放得下
    let canMove = false;
    for (let i = 0; i < SLOTS; i++) { const f = fit(TYPES[p.type].w, i, p.id); if (f >= 0 && f !== p.slot) canMove = true; }
    span.textContent = t(canMove ? 'hint.selected' : placements.size > 1 ? 'hint.selectedFull' : 'hint.selectedOnly', { name: TYPES[p.type].name });
    if (p.interfaces.length) hint.appendChild(btn(t('btn.interfaces'), '', () => enterInspect(p), 'interfaces'));
    if (placements.size > 1) hint.appendChild(btn(t('btn.swap'), 'ghost', () => { sel = { kind: 'placed', id: p.id, swap: true }; renderUI(); }, 'swap'));
    // 一组互斥的选项排成分段按钮：标签加各个选项，当前的那个是按下的
    const group = (label, options, current, pick, act) => {
      const g = document.createElement('div'); g.className = 'grp'; g.setAttribute('role', 'group'); g.setAttribute('aria-label', label);
      const l = document.createElement('div'); l.className = 'lbl'; l.textContent = label;
      const seg = document.createElement('div'); seg.className = 'seg';
      options.forEach(([value, text]) => {
        const b = btn(text, '', () => { if (value === current) return; touched(); pick(value); renderUI(); }, act + '-' + value);
        b.setAttribute('aria-pressed', String(value === current));
        seg.appendChild(b);
      });
      g.appendChild(l); g.appendChild(seg); hint.appendChild(g);
    };
    sitesOf(p.type).forEach((site, i) => {
      if (site.fixed) return;   // 固定装着的部件（电池的加热板、COM stack 的 S-Band 板）不提供切换
      const e = p.exps[i];
      if (!site.options.length || e.by >= 0) {   // 还没有可装的扩展板，或者被相邻位上的双位扩展板占着
        const b = btn(t('btn.expansion', { site: site.name, name: t('expansion.unavailable') }), 'ghost', () => {}, 'exp' + i);
        b.disabled = true; hint.appendChild(b); return;
      }
      group(site.name, [...site.options.map(k => [k, sys.expansions[k].name]), [null, t('expansion.none')]], e.key,
        key => { setExpansion(p, i, key); rebuildInterfaces(p); }, 'exp' + i);
    });
    if (p.bracket) group(t('bracket'), BRACKET_MODES.map(m => [m, t('bracket.' + m)]), p.bracketMode,
      mode => { p.bracketMode = mode; setBracket(p.bracket, mode); }, 'bracket');
    hint.appendChild(btn(t('btn.remove'), 'ghost', () => { touched(); removeCard(p); }, 'remove'));
    hint.appendChild(btn(t('btn.cancel'), 'ghost', () => setSel(null), 'cancel'));
  }
  if (placements.size && !inspect && layer !== 'power') hint.appendChild(btn(t('btn.clear'), 'ghost', () => { touched(); clearAll(); }, 'clear'));
  if (failed.size && !inspect && layer !== 'power') hint.appendChild(btn(t('btn.retry'), 'ghost', () => [...failed].forEach(fetchBoard), 'retry'));
  span.title = span.textContent;   // 提示只有一行，放不下会截断，鼠标停上去能看到全文
  undoBtn.disabled = !undoStack.length || !!inspect || layer === 'power';
  redoBtn.disabled = !redoStack.length || !!inspect || layer === 'power';

  const used = slots.filter(s => s !== null).length, showP = hasPower || layer === 'power';
  const watts = v => v > 0 ? fmtW(v) : '—';
  const rows = [[t('stats.slots'), used + ' / ' + SLOTS], ...(showP ? [[t('stats.typ'), watts(B.now)], [t('stats.peak'), watts(B.peak)]] : []),
                [t('stats.capacity'), B.wh.toFixed(1) + ' Wh'], ...(showP ? [[t('stats.runtime'), fmtH(B.runtime.now)]] : [])];
  stats.textContent = '';
  rows.forEach(r => { const d = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = r[0]; dd.textContent = r[1]; d.appendChild(dt); d.appendChild(dd); stats.appendChild(d); });
  const tag = text => { const e = document.createElement('span'); e.className = 'tag'; e.textContent = text; stats.appendChild(e); };
  if (B.missing && hasPower) tag(t('stats.missing', { n: B.missing }));

  if (refocus) {
    const el = (refocus.id && document.getElementById(refocus.id)) || (refocus.act && hint.querySelector('[data-act="' + refocus.act + '"]')) || hint.querySelector('button');
    if (el) el.focus({ preventScroll: true });
  }
  syncHash();
}

/* ---------- 画面交互 ---------- */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), _p = new THREE.Vector3();
const seatPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -SEAT_Y);   // 换背板时更新 constant
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
/* 在槽位条上拖动板卡：拖到空槽是移动，拖到另一块板上是互换。槽位条每次整体重建，所以按指针的横坐标算槽位，不依赖具体的格子 */
const slotAtX = x => { const r = strip.getBoundingClientRect(); return clamp(Math.floor((x - r.left) / r.width * SLOTS), 0, SLOTS - 1); };
strip.addEventListener('pointerdown', e => {
  const c = e.target.closest('.cell.full');
  if (!c || inspect || e.button || layer === 'power') return;
  const p = placements.get(slots[+c.dataset.slot]);
  if (p && !p.busy) cellDrag = { id: p.id, x: e.clientX, y: e.clientY, active: false };
});
window.addEventListener('pointermove', e => {
  if (!cellDrag) return;
  const p = placements.get(cellDrag.id);
  if (!p || p.busy || inspect) { cellDrag = null; strip.classList.remove('dragging'); return; }
  if (!cellDrag.active) {
    if (Math.hypot(e.clientX - cellDrag.x, e.clientY - cellDrag.y) < 8) return;
    cellDrag.active = true; strip.classList.add('dragging');
    setSel({ kind: 'placed', id: p.id });
  }
  const w = TYPES[p.type].w;
  showTarget(w, fit(w, slotAtX(e.clientX), p.id));
});
function endCellDrag(e, cancel) {
  if (!cellDrag) return;
  const d = cellDrag, p = placements.get(d.id);
  cellDrag = null; strip.classList.remove('dragging'); showTarget(1, -1);
  if (!d.active) return;
  suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);   // 松手后浏览器补发的 click 不算数
  const r = strip.getBoundingClientRect();
  if (cancel || !p || p.busy || e.clientY < r.top - 48 || e.clientY > r.bottom + 48) { renderUI(); return; }   // 拖到槽位条外面松手是取消
  const i = slotAtX(e.clientX), f = fit(TYPES[p.type].w, i, p.id), q = slots[i] === null ? null : placements.get(slots[i]);
  if (f >= 0 && f !== p.slot) { touched(); move(p, f); }
  else if (q && q !== p && !q.busy) swap(p, q);
  else renderUI();
}
window.addEventListener('pointerup', e => endCellDrag(e, false));
window.addEventListener('pointercancel', e => endCellDrag(e, true));
strip.addEventListener('click', e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);

let pd = null, dragging = false, pinch = null, lastTap = null;   // lastTap：上一次点在哪块板上，用来认双击
const pts = new Map();   // 按在画布上的指针，两个时是双指缩放和平移
const spread = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
const centroid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
// 平移：镜头的注视点沿屏幕的左右、上下方向挪 (dx, dy) 像素。from 是开始拖动时的注视点；离默认位置不超过 PAN_MAX
const PAN_MAX = 160, _r = new THREE.Vector3(), _u = new THREE.Vector3();
function panBy(from, dx, dy) {
  const k = (camera.top - camera.bottom) / view.zoom / stage.clientHeight, h = homeTarget();
  _r.set(1, 0, 0).applyQuaternion(camera.quaternion); _u.set(0, 1, 0).applyQuaternion(camera.quaternion);
  ['x', 'y', 'z'].forEach((ax, n) => {
    const key = 't' + ax;
    killTween(view, key);
    view[key] = clamp(from[key] - dx * k * _r[ax] + dy * k * _u[ax], h[n] - PAN_MAX, h[n] + PAN_MAX);
  });
  dirty = true;
}
cv.addEventListener('contextmenu', e => e.preventDefault());   // 右键拖动是平移
cv.addEventListener('pointerdown', e => {
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  if (pts.size === 2) {
    const c = centroid();
    pinch = { d: spread() || 1, zoom: view.zoom, x: c.x, y: c.y, tx: view.tx, ty: view.ty, tz: view.tz };
    pd = null; dragging = false; showTarget(1, -1); return;
  }
  if (pts.size > 2) return;
  // 手指比鼠标抖，点按和拖动的分界放宽一些
  pd = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch, tx: view.tx, ty: view.ty, tz: view.tz,
         pan: e.button === 1 || e.button === 2 || e.shiftKey, th: e.pointerType === 'mouse' ? 6 : 10 };
  dragging = false;
});
cv.addEventListener('pointermove', e => {
  if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch) {
    if (pts.size === 2) {
      const c = centroid();
      killTween(view, 'zoom'); view.zoom = clamp(pinch.zoom * spread() / pinch.d, 0.6, 3);
      panBy(pinch, c.x - pinch.x, c.y - pinch.y);
    }
    return;
  }
  if (pd) {
    const dx = e.clientX - pd.x, dy = e.clientY - pd.y;
    if (!dragging && (Math.abs(dx) > pd.th || Math.abs(dy) > pd.th)) {
      dragging = true; killTween(view, 'yaw'); killTween(view, 'pitch');
      showTarget(1, -1); cv.style.cursor = 'grabbing';
    }
    if (!dragging) return;
    if (pd.pan) { panBy(pd, dx, dy); return; }
    view.yaw = pd.yaw - dx * 0.008;
    // 页面本身不滚动（整页固定在一屏内），所以触屏和鼠标一样可以改俯仰角；查看接口时还能转到板子下方
    view.pitch = clamp(pd.pitch + dy * 0.006, inspect ? -1.5 : 0.12, 1.5);
    dirty = true;
  } else if (!inspect) {
    const h = pick(e);
    if (h.a) showTarget(h.a.w, h.slot);
    setHover(e.pointerType === 'mouse' && h.card && h.slot < 0 && !h.card.busy ? h.card : null);
    cv.style.cursor = layer !== 'power' && (h.slot >= 0 || h.card) ? 'pointer' : 'grab';
  }
});
const release = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
cv.addEventListener('pointerup', e => {
  release(e);
  if (!pd) return;
  if (!dragging && !inspect && !pd.pan && layer !== 'power') {
    const h = pick(e), now = performance.now();
    // 双击（或双点）同一块板：之前选着另一块板就和它互换，否则查看这块板的接口；双击背板是查看背板的接口。
    // 第一下点击已经把选中换成了这块板，所以要记住第一下之前选的是谁
    const onBp = !h.card && h.slot < 0 && !!S.group && ray.intersectObject(S.group, true).length > 0;
    const key = h.slot >= 0 ? null : h.card ? h.card.id : onBp ? 'bp' : null;
    const dbl = lastTap && key !== null && lastTap.id === key && now - lastTap.t < 350 ? lastTap : null;
    lastTap = key !== null && !dbl ? { t: now, id: key, prev: sel && sel.kind === 'placed' && !sel.swap ? sel.id : null } : null;
    if (dbl && key === 'bp') {
      if (bpCard && bpCard.interfaces.length && !applying && !bpBusy) enterInspect(bpCard);
    }
    else if (dbl && !(sel && sel.swap)) {
      const other = dbl.prev !== null && dbl.prev !== h.card.id ? placements.get(dbl.prev) : null;
      if (other && !other.busy && !h.card.busy) {
        // 先把选中还给原来那块板（第一下点击把它放下、把这块抬起来了），再互换。
        // 换不了时 swap 会停在互换模式并提示空间不够，这时选中的必须是原来那块
        setSel({ kind: 'placed', id: other.id });
        swap(other, h.card);
      }
      else if (!h.card.busy && h.card.interfaces.length) enterInspect(h.card);
    }
    else if (sel && sel.swap) {
      const me = placements.get(sel.id);
      if (!h.card) setSel(null);
      else if (h.card !== me && !h.card.busy && !me.busy) swap(me, h.card);
    }
    else if (h.slot >= 0) applyAt(h.slot);
    else if (h.card && !h.card.busy) setSel(sel && sel.id === h.card.id ? null : { kind: 'placed', id: h.card.id });
    else if (!h.card) setSel(null);
  }
  else if (!dragging && inspect && !pd.pan) {
    // 查看接口时双击空白处：退出查看
    pick(e);
    const now = performance.now(), blank = !ray.intersectObject(inspect.p.group, true).length;
    if (blank && lastTap && lastTap.id === 'blank' && now - lastTap.t < 350) { lastTap = null; exitInspect(); }
    else lastTap = blank ? { t: now, id: 'blank', prev: null } : null;
  }
  pd = null; dragging = false; cv.style.cursor = 'grab';
});
cv.addEventListener('pointercancel', e => { release(e); pd = null; dragging = false; });
cv.addEventListener('pointerleave', () => { if (!pd) showTarget(1, -1); setHover(null); });
cv.addEventListener('wheel', e => {
  e.preventDefault(); killTween(view, 'zoom');
  // 按滚动量连续缩放：鼠标滚轮一格（约 100）是 8%，触控板一次滑动发很多个小增量，合起来幅度相当。
  // 按着 ctrl 的滚轮事件是触控板捏合，增量小得多，放大十倍
  const d = clamp(e.deltaY * (e.deltaMode === 1 ? 33 : 1) * (e.ctrlKey ? 10 : 1), -300, 300);
  view.zoom = clamp(view.zoom * Math.exp(-d * 0.00077), 0.6, 3); dirty = true;
}, { passive: false });
const turnBy = d => tween(view, 'yaw', view.yaw + d, 420, easeInOut);
document.getElementById('rotL').addEventListener('click', () => turnBy(-Math.PI / 2));
document.getElementById('rotR').addEventListener('click', () => turnBy(Math.PI / 2));
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);
// 复制带当前配置的链接，结果用一条短提示告诉用户
let toastTimer = 0;
shareBtn.addEventListener('click', async () => {
  const s = stateSnap(), url = location.origin + location.pathname + location.search + (s === defaultSnap ? '' : '#' + s);
  let ok = true;
  try { await navigator.clipboard.writeText(url); } catch (e) { ok = false; }
  toast.textContent = t(ok ? 'share.copied' : 'share.failed');
  toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('on'), ok ? 1600 : 4000);
});
document.getElementById('resetView').addEventListener('click', () => {
  // 查看接口时回到进入查看时的视角
  const h = inspect ? inspect.home : { yaw: HOME_YAW, pitch: ISO, zoom: 1 };
  tween(view, 'yaw', nearAngle(h.yaw, view.yaw), 420, easeInOut); tween(view, 'pitch', h.pitch, 420, easeInOut); tween(view, 'zoom', h.zoom, 420, easeInOut);
  const g = homeTarget();
  tween(view, 'tx', g[0], 420, easeInOut); tween(view, 'ty', g[1], 420, easeInOut); tween(view, 'tz', g[2], 420, easeInOut);
});
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (inspect) exitInspect(); else if (layer === 'power') setLayer('layout'); else setSel(null); }
  if (inspect) return;
  if (layer !== 'power' && (e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
    e.preventDefault();
    if (e.shiftKey || e.key.toLowerCase() === 'y') redo(); else undo();
    return;
  }
  // 数字键 1–7 等于点对应的槽位：选了板卡就落位，否则选中槽里的板
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && e.key >= '1' && e.key <= String(SLOTS)) { slotClick(+e.key - 1); return; }
  if (layer !== 'power' && (e.key === 'Delete' || e.key === 'Backspace') && sel && sel.kind === 'placed') { const p = placements.get(sel.id); if (p && !p.busy) { touched(); removeCard(p); } }
});

/* ---------- 主题、尺寸、循环 ---------- */
// 初始主题由 index.html 里的内联脚本设好（默认深色）。按钮上显示的是点了以后会换成的主题
const themeBtn = document.getElementById('themeToggle');
function syncThemeBtn() {
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  themeBtn.textContent = dark ? '☀' : '☾';
  themeBtn.setAttribute('aria-label', t(dark ? 'aria.toLight' : 'aria.toDark'));
  themeBtn.title = themeBtn.getAttribute('aria-label');
}
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);   // 三维部分的颜色由下面的 MutationObserver 跟着更新
  try { localStorage.setItem('theme', next); } catch (e) {}
  syncThemeBtn();
});
syncThemeBtn();
new MutationObserver(() => { applyTheme(); dirty = true; flowDirty = true; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

let aspect = 1;
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  aspect = w / h;
  setResolution(w, h);
  flow.setResolution(w, h);
  draw();   // 改尺寸会清空画布，当场重画一帧，否则会闪一下
}
new ResizeObserver(resize).observe(stage);

function frameLoop() {
  const now = performance.now();   // 与补间起点用同一个时钟
  // 电源分布图的脉动需要持续重画：只在它正显示着、有线在脉动、而且标签页可见的时候
  const active = dirty || tweens.size > 0 || (flowOn && flow.live > 0 && !reduced && !document.hidden);
  dirty = false;
  for (const w of tweens) {
    const u = Math.min(1, (now - w.t0) / w.ms);
    w.o[w.k] = w.from + (w.to - w.from) * w.ease(u);
    // 补间结束后接着执行的收尾（摘掉模型、复位朝向）发生在这一帧之后，所以下一帧再画一次
    if (u >= 1) { tweens.delete(w); w.res(); dirty = true; flowDirty = true; }
  }
  if (active) draw();   // 没有变化就不重画
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
  updateHover();
  renderer.render(scene, camera);
  // 功耗层：把模型压暗，再在上面画电源分布图
  if (dim.a > 0.005) drawDim(renderer, dim.a);
  if (updateFlow()) { renderer.autoClear = false; renderer.render(flow.scene, camera); renderer.autoClear = true; }
  if (hover) drawSilhouette(renderer, scene, camera);
}

applyStatic(document);
applyTheme();
resize();
renderUI();
requestAnimationFrame(frameLoop);
// 先取背板，界面随即可用。板卡的模型按需取：布局里用到的、在板卡库里点选的
const wait = ms => new Promise(res => setTimeout(res, reduced ? 0 : ms));
let run = 0, layout = sys.initial;   // run：每次换配置加一，用来中止还在进行的逐块插入
const fetchBoard = type => {
  if (!loaded.has(type) && !loading.has(type)) { loading.add(type); renderUI(); }
  return loadBoard(sys, type).then(() => {
    loading.delete(type);
    if (hasModel(type)) { loaded.add(type); failed.delete(type); } else failed.add(type);
    renderUI();
  });
};
// 依次拔出一组板卡，从最后一个槽往前。记下每个槽位上方什么时候腾空（拔出动画走完），
// 新板卡要等自己那几个槽腾空了才落下，这样拔出和插入的模型不会在同一个位置上重叠
const EXIT_MS = 650, clearAt = new Array(SLOTS).fill(0);
function pullOut(list) {
  list.sort((a, b) => b.slot - a.slot).forEach((p, k) => {
    const delay = reduced ? 0 : k * 110;
    p.busy = true; p.leaving = true;
    if (!reduced) for (let i = 0; i < TYPES[p.type].w; i++) clearAt[p.slot + i] = performance.now() + delay + EXIT_MS;
    // 不用等的当场拔掉：槽位立刻空出来，紧接着的插入才放得进去
    if (delay) setTimeout(() => removeCard(p), delay); else removeCard(p);
  });
}
// 原地轻轻抬一下再落回：换配置时位置没变的板卡用它代替拔出重插
function bump(p) {
  if (p.busy || !placements.has(p.id)) return;
  p.busy = true;
  tween(p.group.position, 'y', SEAT_Y + 12, 170, easeOut)
    .then(() => tween(p.group.position, 'y', SEAT_Y, 230, easeIn))
    .then(() => { p.busy = false; });
}

/* ---------- 配置：撤销、地址栏、整套替换 ---------- */
// 当前的配置（正在拔出的板卡不算）
const currentCfg = () => ({ bp: bpKey, boards: [...placements.values()].filter(p => !p.leaving)
  .map(p => ({ type: p.type, slot: p.slot, bracket: p.bracketMode, exps: p.exps.map(e => e.by >= 0 ? null : e.key), loads: p.loads })) });
const snapshot = () => serialize(sys, currentCfg());
// 逐块替换的过程中，以换完以后的样子为准
const stateSnap = () => applying ? targetSnap : snapshot();
// 改动之前调用：把现在的配置记进撤销记录
function checkpoint() {
  if (!ready) return;
  const s = stateSnap();
  if (undoStack[undoStack.length - 1] !== s) undoStack.push(s);
  redoStack.length = 0;   // 有了新的改动，之前撤销掉的就不能重做了
  if (undoStack.length > 50) undoStack.shift();
}
function undo() {
  if (inspect || !ready) return;
  const cur = stateSnap();
  let s;
  do { s = undoStack.pop(); } while (s !== undefined && s === cur);   // 没有实际改动的记录跳过
  const cfg = s === undefined ? null : parse(sys, s);
  if (!cfg) { renderUI(); return; }
  redoStack.push(cur);
  setLayoutFor(cfg);
  applyConfig(cfg);
}
function redo() {
  if (inspect || !ready) return;
  const cur = stateSnap();
  let s;
  do { s = redoStack.pop(); } while (s !== undefined && s === cur);
  const cfg = s === undefined ? null : parse(sys, s);
  if (!cfg) { renderUI(); return; }
  undoStack.push(cur);
  setLayoutFor(cfg);
  applyConfig(cfg);
}
// 地址栏里带上当前配置，刷新后恢复，也可以把链接发给别人。和打开时的默认配置相同就不带
function syncHash() {
  if (!ready || applying) return;
  const s = snapshot(), want = s === defaultSnap ? '' : '#' + s;
  if (location.hash !== want) { try { history.replaceState(null, '', want || location.pathname + location.search); } catch (e) {} }
}
// 布局选择器跟着配置走：和哪套预设一样就选中哪套，都不一样是 Custom
function setLayoutFor(cfg) {
  const s = serialize(sys, { bp: '', boards: cfg.boards.map(b => ({ ...b, loads: {} })) });   // 负载状态不影响它算哪套预设
  const match = Object.keys(LAYOUTS).find(k => serialize(sys, presetCfg(sys, k, '')) === s);
  layout = match || (LAYOUTS.custom ? 'custom' : layout);
  renderLayouts();
}
// 把一块留在原位的板卡的支架面和扩展板改成配置里写的
function setOpts(p, c) {
  if (!placements.has(p.id)) return;
  if (p.bracket && p.bracketMode !== c.bracket) { p.bracketMode = c.bracket; setBracket(p.bracket, p.bracketMode); }
  p.loads = { ...c.loads };
  let changed = false;
  sitesOf(p.type).forEach((site, i) => {
    const e = p.exps[i], key = c.exps[i] || null;
    if (site.fixed || e.by >= 0 || e.key === key) return;
    setExpansion(p, i, key); changed = true;
  });
  if (changed) rebuildInterfaces(p);
}
// 换成另一套配置（预设布局、撤销、地址栏里的配置、清空都走这里）：类型和槽位都对得上的板卡留在原位，
// 只依次起伏一下，连起来像一道波；其余的依次拔出，缺的逐块插入（每块等自己的槽位腾空）
async function applyConfig(cfg) {
  const mine = ++run;
  applying = true; targetSnap = serialize(sys, cfg);
  setSel(null);
  if (cfg.bp !== bpKey) await setBackplane(cfg.bp);
  if (run !== mine) return;
  const list = cfg.boards, keep = new Map(), drop = [];
  placements.forEach(p => {
    if (p.leaving) return;
    const k = list.findIndex(c => c.type === p.type && c.slot === p.slot);
    if (k >= 0) keep.set(k, p); else drop.push(p);
  });
  pullOut(drop);
  pending.clear();
  list.forEach((c, k) => { if (!keep.has(k)) pending.set(c.slot, c.type); });
  const jobs = list.map((c, k) => keep.has(k) ? null : fetchBoard(c.type));
  // 和拔出一样从最后一个槽往前：最先腾空的槽最先插入
  const seq = list.map((_, k) => k).sort((a, b) => list[b].slot - list[a].slot);
  for (const k of seq) {
    const c = list[k];
    if (keep.has(k)) { setOpts(keep.get(k), c); bump(keep.get(k)); await wait(90); if (run !== mine) return; continue; }
    await jobs[k];
    let due = 0;
    // 自己占的槽和两侧相邻的槽都要腾空：等轴测视角下隔壁的板一上一下也会显得交错
    for (let i = -1; i <= TYPES[c.type].w; i++) due = Math.max(due, (clearAt[c.slot + i] || 0) - performance.now());
    if (due > 0) await wait(due);
    if (run !== mine) return;
    pending.delete(c.slot);
    place(c.type, c.slot, true, c);
    await wait(170);
    if (run !== mine) return;
  }
  applying = false;
  renderUI();
}
// 清空：从最后一个槽开始依次拔出。同时中止还没放完的配置
function clearAll() { applyConfig({ bp: bpKey, boards: [] }); }
const layoutsEl = document.getElementById('layouts');
function loadLayout(key) {
  if (!ready || inspect) return;
  checkpoint();
  layout = key; renderLayouts();
  applyConfig(presetCfg(sys, key, bpKey));
}
// 手动改动板卡之前调用：记进撤销记录；当前配置不再是某套预设，选择器切到 Custom
function touched() {
  checkpoint();
  if (LAYOUTS.custom && layout !== 'custom') { layout = 'custom'; renderLayouts(); }
}
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
// 背板可以换型号。各型号的槽位位置相同，只是外形、板上器件和连接器高度略有差别，所以换背板时板卡留在原位
const bpsEl = document.getElementById('backplanes');
let bpKey = null, bpLoading = false;
// 换背板的过程：板卡一起抬起悬住，旧背板朝画面右侧滑出去，新背板从左侧滑进来，板卡再落回连接器。
// 第一次加载（还没有背板）不做动画
const BP_LIFT = 45;
async function setBackplane(key) {
  if (key === bpKey || bpLoading || inspect) return;
  bpLoading = true;
  const B = BACKPLANES[key];
  await loadBackplane(key, B);
  if (inspect) { bpLoading = false; return; }
  setSel(null);
  const old = S.group;
  let lifted = [];
  if (old) {
    bpBusy = true;
    // 正在自己做动画的板卡（刚落位、正在拔出）不管，其余的一起抬起
    lifted = [...placements.values()].filter(q => !q.busy);
    lifted.forEach(q => { q.busy = true; });
    renderUI();
    await Promise.all(lifted.map(q => tween(q.group.position, 'y', SEAT_Y + BP_LIFT, 240, easeOut)));
  }
  // 滑动方向固定在结构上：沿槽位连接器的长度方向（X 轴，和板卡的板面平行），像从板卡底下抽出一个托盘。
  // 旧背板朝 +X 抽走，新背板从 -X 推进来；视图怎么转，这个方向相对背板都不变。
  // 距离取够滑出画面：看这个方向在屏幕上横向、纵向各占多少，哪边先出画面就按哪边算
  _r.set(1, 0, 0).applyQuaternion(camera.quaternion); _u.set(0, 1, 0).applyQuaternion(camera.quaternion);
  const halfW = camera.right / view.zoom, halfH = camera.top / view.zoom, reach = S.hx * 2 + 40;
  const dist = Math.min(900, (halfW + reach) / Math.max(Math.abs(_r.x), 0.05), (halfH + reach) / Math.max(Math.abs(_u.x), 0.05));
  const dx = dist, dz = 0;
  S = buildStructure(scene, key, B);
  bpKey = key; bpCard = null;
  if (S.group) {
    bpCard = { isBackplane: true, busy: false, interfaces: [], pivot: S.group, group: S.group };
    addInterfaces(bpCard.interfaces, ifaceNotes(B.notes), S.interfaces);
  }
  SEAT_Y = B.seatY; seatPlane.constant = -SEAT_Y;
  bpsEl.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.key === bpKey)));
  HOME.tx = S.cx; HOME.tz = S.cz;   // 镜头对准结构中心
  if (old) {
    const slide = (g, x, z, ms, ease) => Promise.all([tween(g.position, 'x', x, ms, ease), tween(g.position, 'z', z, ms, ease)]);
    const out = slide(old, dx, dz, 380, easeIn).then(() => scene.remove(old));
    let into = null;
    if (S.group) { S.group.position.x = -dx; S.group.position.z = -dz; into = slide(S.group, 0, 0, 440, easeOut); }
    tween(view, 'tx', S.cx, 440, easeInOut); tween(view, 'tz', S.cz, 440, easeInOut);
    await Promise.all([out, into]);
    await Promise.all(lifted.map(q => !placements.has(q.id) ? null
      : tween(q.group.position, 'y', SEAT_Y + 7, 240, easeOut)
          .then(() => tween(q.group.position, 'y', SEAT_Y, 140, easeIn))
          .then(() => { q.busy = false; })));
    bpBusy = false;
  } else {
    view.tx = S.cx; view.tz = S.cz;
    placements.forEach(q => { if (!q.busy) q.group.position.y = SEAT_Y; });
  }
  bpLoading = false;
  renderUI();
}
Object.entries(BACKPLANES).forEach(([key, B]) => {
  const b = document.createElement('button');
  b.type = 'button'; b.dataset.key = key; b.textContent = B.name;
  b.addEventListener('click', () => { if (key !== bpKey && !bpLoading && !inspect) { checkpoint(); setBackplane(key); } });
  bpsEl.appendChild(b);
});
// 打开时：地址栏里带了配置就恢复它，否则用 system.json 里的默认布局
const initialCfg = presetCfg(sys, sys.initial, sys.backplane), defaultSnap = serialize(sys, initialCfg);
const fromHash = parse(sys, location.hash.slice(1));
window.addEventListener('hashchange', () => {
  if (!ready || inspect) return;
  const cfg = parse(sys, location.hash.slice(1));
  if (!cfg || serialize(sys, cfg) === stateSnap()) return;
  checkpoint(); setLayoutFor(cfg); applyConfig(cfg);
});
setBackplane(fromHash ? fromHash.bp : sys.backplane).then(() => {
  ready = true;
  if (fromHash) setLayoutFor(fromHash);
  applyConfig(fromHash || initialCfg);
});
