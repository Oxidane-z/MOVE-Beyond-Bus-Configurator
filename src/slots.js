// 槽位占用的纯函数。slots 是长度为槽位数的数组，空槽是 null，被占的槽存板卡实例的 id。

export const isFree = (slots, i, ignore) => i >= 0 && i < slots.length && (slots[i] === null || slots[i] === ignore);

// 宽 w 的板卡指向第 i 槽时落在哪一槽（起始槽位）；放不下返回 -1。两槽宽的板先试 i、i+1，再试 i-1、i
export function fit(slots, w, i, ignore) {
  if (w === 1) return isFree(slots, i, ignore) ? i : -1;
  if (isFree(slots, i, ignore) && isFree(slots, i + 1, ignore)) return i;
  if (isFree(slots, i - 1, ignore) && isFree(slots, i, ignore)) return i - 1;
  return -1;
}

// 两块板互换后各自的起始槽位：靠前的位置给原来靠后的板，两块板合起来占的范围两端不变。
// a、b 是 { id, slot, w }；返回 Map(id → 新槽位)，放不下时返回 null
export function swapPlan(slots, a, b) {
  const [L, R] = a.slot < b.slot ? [a, b] : [b, a];
  const newR = L.slot, newL = R.slot + R.w - L.w;
  const free = i => i >= 0 && i < slots.length && (slots[i] === null || slots[i] === a.id || slots[i] === b.id);
  for (let k = 0; k < R.w; k++) if (!free(newR + k)) return null;
  for (let k = 0; k < L.w; k++) if (!free(newL + k)) return null;
  if (newR + R.w > newL) return null;
  return new Map([[L.id, newL], [R.id, newR]]);
}

/* 悬出：两槽宽、只有一格真的插连接器的板（system.json 里标了 overhang），可以把连接器插在最靠边的那个槽，
   板体的另一半悬到槽位之外，只占一个槽。这时它的起始槽位是 -1（朝前悬）或最后一槽（朝后悬） */
export const NONE = -9;   // fitOver 放不下时返回它（-1 已经是一个合法的起始槽位了）
// 一块板朝哪边悬：-1 朝前（连接器在靠后那格），1 朝后（连接器在靠前那格），0 不能悬
export const overOf = T => T && T.overhang && T.w === 2 ? (T.connectorSlot ? -1 : 1) : 0;
// 板卡 T 起始槽位为 slot 时实际占的槽 [from, to)，n 是槽位数；越界而且不是允许的悬出时返回 null
export function span(T, slot, n) {
  if (!Number.isInteger(slot)) return null;
  const o = overOf(T), inside = slot >= 0 && slot + T.w <= n;
  if (!inside && !((o === -1 && slot === -1) || (o === 1 && slot === n - 1))) return null;
  return [Math.max(slot, 0), Math.min(slot + T.w, n)];
}
// fit 加上悬出：能悬的板指着它那一侧最靠边的槽时，连接器就插在那个槽，板体悬出去。放不下返回 NONE
export function fitOver(slots, w, i, ignore, over) {
  if (over === -1 && i === 0 && isFree(slots, 0, ignore)) return -1;
  if (over === 1 && i === slots.length - 1 && isFree(slots, i, ignore)) return i;
  const f = fit(slots, w, i, ignore);
  return f < 0 ? NONE : f;
}

// 互换里有一块板悬在槽位之外时的做法。h 是悬着的那块，o 是另一块，都是 { id, slot, w, over }：
// o 换到 h 的连接器所在的那个槽（o 自己也能悬就照样悬着，否则从那个槽起占够自己的宽度），
// h 回到槽位里，落在 o 原来的位置附近（先试连接器对着 o 原来的各个槽）。返回 Map(id → 新槽位)，放不下返回 null
export function swapOver(slots, h, o) {
  const n = slots.length, tmp = slots.map(v => v === h.id || v === o.id ? null : v);
  const edge = h.slot < 0 ? 0 : n - 1, newO = fitOver(tmp, o.w, edge, null, o.over);
  if (newO === NONE) return null;
  for (let k = Math.max(newO, 0); k < Math.min(newO + o.w, n); k++) tmp[k] = o.id;
  for (let i = Math.max(o.slot, 0); i < Math.min(o.slot + o.w, n); i++) {
    const f = fitOver(tmp, h.w, i, null, h.over);
    if (f !== NONE) return new Map([[h.id, f], [o.id, newO]]);
  }
  return null;
}

// 互换的宽松做法，swapPlan 排不开时用：不要求两块板合起来占的范围不变，只要各自能落在对方原来的位置附近。
// 先让一块落到另一块原来占的某个槽上，再让另一块落到它原来占的某个槽上（两槽宽的板可以借用旁边的空槽）；
// 一个顺序不行就换一个顺序。a、b 是 { id, slot, w }；返回 Map(id → 新槽位)，放不下返回 null
export function swapLoose(slots, a, b) {
  const n = slots.length, vis = p => { const r = []; for (let i = Math.max(p.slot, 0); i < Math.min(p.slot + p.w, n); i++) r.push(i); return r; };
  const attempt = (x, y) => {
    for (const i of vis(x)) {
      const tmp = slots.map(v => v === a.id || v === b.id ? null : v), fy = fit(tmp, y.w, i, null);
      if (fy < 0) continue;
      for (let k = fy; k < fy + y.w; k++) tmp[k] = y.id;
      for (const j of vis(y)) { const fx = fit(tmp, x.w, j, null); if (fx >= 0) return new Map([[x.id, fx], [y.id, fy]]); }
    }
    return null;
  };
  return attempt(a, b) || attempt(b, a);
}
