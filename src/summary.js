// 一块板能外接什么：从它的接口说明里归纳出来，给板卡的资料卡用。
// 背板连接器、调试口、板间的扩展连接器不算外接功能；跳线、选择针、按钮这类板上的设置也不算。
// 编号不同的同一种接口（Sun sensor 1…6、Magnetometer A / B、I²C bus 1 (A)）合成一项，带上个数
const SKIP_TYPES = ['bus', 'debug', 'expansion'];
const SKIP_LABEL = /jumper|select|button/i;
// 去掉末尾的编号：“ 3”“ A”“ (B)”“ Y+”
const base = label => {
  let s = label, prev;
  do { prev = s; s = s.replace(/\s*\([A-D]\)$/, '').replace(/\s+Y[+\-−]$/, '').replace(/\s+[A-D]$/, '').replace(/\s+\d+$/, ''); } while (s !== prev && s);
  return s || label;
};
// notes 是接口说明的数组 [{ label, type }]。返回 [{ name, n }]，按第一次出现的顺序
export function connects(notes) {
  const out = new Map();
  for (const n of notes || []) {
    if (!n || !n.label || SKIP_TYPES.includes(n.type) || SKIP_LABEL.test(n.label)) continue;
    const k = base(n.label);
    out.set(k, (out.get(k) || 0) + 1);
  }
  return [...out].map(([name, n]) => ({ name, n }));
}
export const connectsText = notes => connects(notes).map(c => c.n > 1 ? c.name + ' ×' + c.n : c.name);
