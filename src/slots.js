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
