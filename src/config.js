// 一套配置的文字形式，用在地址栏（分享、刷新后恢复）和撤销记录里。
// 配置：{ bp: 背板 key, boards: [{ type, slot, bracket, exps: [扩展板 key 或 null, …] }] }
// 文字：背板;板卡,槽位[,b支架面][,e扩展板+扩展板];…   槽位从 1 起；和默认值相同的选项不写；"-" 表示这个扩展位不装
// 例：v78;obdh,1,e-;recovery,3,bfront

export const BRACKET_MODES = ['back', 'front', 'none'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const sitesOf = (sys, type) => sys.boards[type].expansionSites || [];
export const defaultBracket = (sys, type) => sys.boards[type].bracketSide || 'back';
export const defaultExps = (sys, type) => sitesOf(sys, type).map(s => s.default || null);

export function serialize(sys, cfg) {
  const parts = [cfg.bp];
  [...cfg.boards].sort((a, b) => a.slot - b.slot).forEach(c => {
    const f = [c.type, c.slot + 1], def = defaultExps(sys, c.type), exps = c.exps || def;
    if (sys.boards[c.type].bracket && c.bracket && c.bracket !== defaultBracket(sys, c.type)) f.push('b' + c.bracket);
    if (exps.some((k, i) => (k || null) !== def[i])) f.push('e' + exps.map(k => k || '-').join('+'));
    parts.push(f.join(','));
  });
  return parts.join(';');
}

// 认不出的背板返回 null；认不出、越界或和前面重叠的板卡跳过；认不出的选项按默认值
export function parse(sys, str) {
  if (!str) return null;
  try { str = decodeURIComponent(str); } catch (e) { return null; }
  const [bp, ...rest] = str.split(';');
  if (!own(sys.backplanes, bp)) return null;
  const used = new Array(sys.slots).fill(false), boards = [];
  for (const part of rest) {
    const [type, n, ...opts] = part.split(',');
    if (!own(sys.boards, type)) continue;
    const T = sys.boards[type], slot = Number(n) - 1;
    if (!Number.isInteger(slot) || slot < 0 || slot + T.w > sys.slots) continue;
    if (used.slice(slot, slot + T.w).some(Boolean)) continue;
    const c = { type, slot, bracket: defaultBracket(sys, type), exps: defaultExps(sys, type) };
    for (const o of opts) {
      if (o[0] === 'b' && T.bracket && BRACKET_MODES.includes(o.slice(1))) c.bracket = o.slice(1);
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
  return { bp, boards };
}

// system.json 里的一套预设布局，选项都取默认值
export const presetCfg = (sys, key, bp) => ({
  bp,
  boards: sys.layouts[key].boards.map(([type, slot]) => ({ type, slot, bracket: defaultBracket(sys, type), exps: defaultExps(sys, type) }))
});
