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
