// 一套配置的文字形式，用在地址栏（分享、刷新后恢复）和撤销记录里。
// 配置：{ bp: 背板 key, boards: [{ type, slot, bracket, exps: [扩展板 key 或 null, …] }], inputs: { 输入口 ref: 数 } }
// 文字：背板;板卡,槽位[,b支架面][,e扩展板+扩展板][,p负载=状态+负载=状态];…   槽位从 1 起；和默认值相同的选项不写；"-" 表示这个扩展位不装
// loads 是功耗层里各负载选的状态 { 负载 key: 状态名 }，只记和默认不同的
// inputs 是功耗层里各电源输入口的状态：太阳能口是各串受到的日照 [0–1, …]，写成百分数用点隔开（100.50）；GSE 口是 0 / 1。
// 写成单独的一段 in:口=值+口=值，只记不是 0 的
// 例：v78;obdh,1,e-;recovery,3,bfront

export const BRACKET_MODES = ['back', 'front', 'none'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const sitesOf = (sys, type) => sys.boards[type].expansionSites || [];
export const defaultBracket = (sys, type) => sys.boards[type].bracketSide || 'back';
const loadsOf = (sys, type) => (sys.boards[type].power && sys.boards[type].power.loads) || [];
const inputsOf = (sys, bp) => ((sys.backplanes[bp] && sys.backplanes[bp].inputs) || []).map(d => typeof d === 'string' ? { ref: d } : d);
// 一个输入口的状态整理成标准的样子，再写成文字（全是 0 就是空串）
const normIn = (d, v) => d.kind === 'gse' ? (Number(v) > 0 ? 1 : 0)
  : Array.from({ length: d.strings || 1 }, (_, i) => Math.max(0, Math.min(1, Number(Array.isArray(v) ? v[i] : 0) || 0)));
const textIn = (d, v) => {
  const n = normIn(d, v);
  if (d.kind === 'gse') return n ? '1' : '';
  const pct = n.map(f => Math.round(f * 100));
  while (pct.length && !pct[pct.length - 1]) pct.pop();
  return pct.join('.');
};
const defState = L => own(L.states, L.default) ? L.default : Object.keys(L.states)[0];
export const defaultExps = (sys, type) => sitesOf(sys, type).map(s => s.default || null);

export function serialize(sys, cfg) {
  const parts = [cfg.bp];
  [...cfg.boards].sort((a, b) => a.slot - b.slot).forEach(c => {
    const f = [c.type, c.slot + 1], def = defaultExps(sys, c.type), exps = c.exps || def;
    if (sys.boards[c.type].bracket && c.bracket && c.bracket !== defaultBracket(sys, c.type)) f.push('b' + c.bracket);
    if (exps.some((k, i) => (k || null) !== def[i])) f.push('e' + exps.map(k => k || '-').join('+'));
    const ld = loadsOf(sys, c.type).filter(L => c.loads && own(L.states, c.loads[L.key]) && c.loads[L.key] !== defState(L)).map(L => L.key + '=' + c.loads[L.key]);
    if (ld.length) f.push('p' + ld.join('+'));
    parts.push(f.join(','));
  });
  const ins = inputsOf(sys, cfg.bp).map(d => [d.ref, textIn(d, cfg.inputs && cfg.inputs[d.ref])]).filter(e => e[1]);
  if (ins.length) parts.push('in:' + ins.map(e => e[0] + '=' + e[1]).join('+'));
  return parts.join(';');
}

// 认不出的背板返回 null；认不出、越界或和前面重叠的板卡跳过；认不出的选项按默认值
export function parse(sys, str) {
  if (!str) return null;
  try { str = decodeURIComponent(str); } catch (e) { return null; }
  const [bp, ...rest] = str.split(';');
  if (!own(sys.backplanes, bp)) return null;
  const used = new Array(sys.slots).fill(false), boards = [], inputs = {};
  for (const part of rest) {
    if (part.slice(0, 3) === 'in:') {
      part.slice(3).split('+').forEach(kv => {
        const [ref, v] = kv.split('='), d = inputsOf(sys, bp).find(d => d.ref === ref);
        if (!d) return;
        const val = normIn(d, d.kind === 'gse' ? v : String(v).split('.').map(p => Number(p) / 100));
        if (textIn(d, val)) inputs[ref] = val;
      });
      continue;
    }
    const [type, n, ...opts] = part.split(',');
    if (!own(sys.boards, type)) continue;
    const T = sys.boards[type], slot = Number(n) - 1;
    if (!Number.isInteger(slot) || slot < 0 || slot + T.w > sys.slots) continue;
    if (used.slice(slot, slot + T.w).some(Boolean)) continue;
    const c = { type, slot, bracket: defaultBracket(sys, type), exps: defaultExps(sys, type), loads: {} };
    for (const o of opts) {
      if (o[0] === 'b' && T.bracket && BRACKET_MODES.includes(o.slice(1))) c.bracket = o.slice(1);
      if (o[0] === 'p') o.slice(1).split('+').forEach(kv => {
        const [k, st] = kv.split('='), L = loadsOf(sys, type).find(L => L.key === k);
        if (L && own(L.states, st) && st !== defState(L)) c.loads[k] = st;
      });
      if (o[0] === 'e') o.slice(1).split('+').forEach((k, i) => {
        const site = sitesOf(sys, type)[i];
        if (!site || site.fixed) return;
        if (k === '-') c.exps[i] = null;
        else if (site.options.includes(k)) c.exps[i] = k;
      });
    }
    for (let k = 0; k < T.w; k++) used[slot + k] = true;
    boards.push(c);
  }
  return { bp, boards, inputs };
}

// system.json 里的一套预设布局，选项都取默认值
export const presetCfg = (sys, key, bp) => ({
  bp,
  boards: sys.layouts[key].boards.map(([type, slot]) => ({ type, slot, bracket: defaultBracket(sys, type), exps: defaultExps(sys, type), loads: {} })),
  inputs: {}
});
