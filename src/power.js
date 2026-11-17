// 功耗预算的纯计算部分（不碰界面）。单位：瓦、瓦时、小时。
//
// 板卡的功耗写在 system.json 板卡条目的 "power" 里，三种写法：
//   底噪加负载：{"base": {"3v3": 0.1}, "loads": [{"key": "gnss", "name": "GNSS", "rail": "3v3", "states": {"off": 0, "on": 0.3}, "default": "on"}]}
//               base 是一直在耗的部分；每个负载是板上的一个功能或接口上接的一个外设（外设再写 "interface": 接口的 ref），
//               有几个自己命名的状态，各是多少瓦。待机 / 典型 / 峰值自动得出：各负载取最低 / 默认 / 最高的状态
//   按电源轨：  {"rails": {"3v3": [待机, 典型, 峰值], "5v": [待机, 典型, 峰值]}}
//   不分轨：    {"idle": 0.1, "typ": 0.4, "peak": 1.2}
// source 取 measured（实测）、datasheet（数据手册）或 est（估算），不写按 est 处理。
// 电池是电源：容量写在板卡的 "wh" 里。
//
// system.json 顶层的 "power"：
//   rails    背板分给每个槽的电源轨，{key: {label, efficiency}}。efficiency 是从电池到这一路的转换效率，
//            VSYS 直接来自电池所以是 1；3V3 和 5V 经过稳压，实际效率填进来之前先按 1 算
//            volts 是这一路的电压（VSYS 取低压保护点，电流按最坏情况算），limit 是每个槽在这一路上的电流上限（安）
//   usable   电池容量里可用的比例（放电深度），默认 1
export const LEVELS = ['idle', 'typ', 'peak'];
const ALL = ['now', 'idle', 'typ', 'peak'];
const zero = () => ({ now: 0, idle: 0, typ: 0, peak: 0 });
const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// 负载的默认状态：写了 default 用它，否则是第一个
export const defaultState = L => own(L.states, L.default) ? L.default : Object.keys(L.states)[0];

// 一块板的功耗。sel 是这块板上各负载当前选的状态 { 负载 key: 状态名 }，不给就都取默认。
// 返回四档合计（now 当前、idle 待机、typ 典型、peak 峰值）、各电源轨上的四档、各负载的当前状态。没有数据返回 null
export function boardPower(T, sel) {
  const P = T && T.power;
  if (!P) return null;
  const out = { ...zero(), rails: {}, loads: [], source: P.source || 'est' };
  let any = false;
  const add = (rail, v) => {
    any = true;
    const r = rail ? (out.rails[rail] || (out.rails[rail] = zero())) : null;
    ALL.forEach(k => { out[k] += v[k]; if (r) r[k] += v[k]; });
  };
  const flat = w => ({ now: w, idle: w, typ: w, peak: w });
  // 固定三档的写法
  if (P.rails) for (const [rail, v] of Object.entries(P.rails)) add(rail, { now: +v[1] || 0, idle: +v[0] || 0, typ: +v[1] || 0, peak: +v[2] || 0 });
  else if (P.typ != null) add(null, { now: +P.typ, idle: P.idle != null ? +P.idle : +P.typ, typ: +P.typ, peak: P.peak != null ? +P.peak : +P.typ });
  // 底噪加负载的写法
  for (const [rail, w] of Object.entries(P.base || {})) add(rail, flat(+w || 0));
  for (const L of P.loads || []) {
    const vals = Object.values(L.states), def = defaultState(L), state = own(L.states, sel && sel[L.key]) ? sel[L.key] : def;
    add(L.rail, { now: L.states[state], idle: Math.min(...vals), typ: L.states[def], peak: Math.max(...vals) });
    out.loads.push({ key: L.key, name: L.name || L.key, rail: L.rail, interface: L.interface || null, states: L.states, labels: L.labels || {}, state, watts: L.states[state] });
  }
  return any ? out : null;
}

// 一套配置的预算。entries 是已放置的板卡：[{ T: system.json 里的条目, sel: 各负载选的状态 }]
//   now/idle/typ/peak  板卡端的总功耗
//   draw               电池端的总功耗（各轨除以转换效率；没分轨的部分按效率 1）
//   rails              各电源轨上的合计
//   wh / usable        电池总容量 / 其中可用的
//   runtime            各档的续航小时数；没有电池或没有功耗时为 null
//   loss               降压损耗，电池端减板卡端
//   missing            既没有功耗数据也不是电池的板卡数，未计入
//   counted / boards   有功耗数据的板卡数 / 应该有功耗数据的板卡数（不含电池）
//   partial            有板卡没计入：合计偏小，续航只是上限
export function budget(entries, P = {}) {
  const defs = P.rails || {}, b = { ...zero(), draw: zero(), loss: zero(), rails: {}, wh: 0, usable: 0, runtime: {}, missing: 0, counted: 0, boards: 0, partial: false };
  for (const { T, sel } of entries) {
    b.wh += T.wh || 0;
    const bp = boardPower(T, sel);
    if (!bp) { if (!T.wh) b.missing++; continue; }
    b.counted++;
    const railed = zero();
    for (const [rail, r] of Object.entries(bp.rails)) {
      const acc = b.rails[rail] || (b.rails[rail] = zero()), eff = (defs[rail] && defs[rail].efficiency) || 1;
      ALL.forEach(k => { acc[k] += r[k]; railed[k] += r[k]; b.draw[k] += r[k] / eff; });
    }
    ALL.forEach(k => { b[k] += bp[k]; b.draw[k] += bp[k] - railed[k]; });
  }
  b.usable = b.wh * (P.usable != null ? P.usable : 1);
  ALL.forEach(k => { b.loss[k] = b.draw[k] - b[k]; b.runtime[k] = b.usable > 0 && b.draw[k] > 0 ? b.usable / b.draw[k] : null; });
  b.boards = b.counted + b.missing; b.partial = b.missing > 0;
  return b;
}

/* 场景：一键把所有负载设到一档。idle 各取最低的状态，typ 取默认，peak 取最高 */
export const SCENARIOS = ['idle', 'typ', 'peak'];
const pickState = (L, name) => {
  if (name === 'typ') return defaultState(L);
  const keys = Object.keys(L.states);
  return keys.reduce((best, k) => (name === 'idle' ? L.states[k] < L.states[best] : L.states[k] > L.states[best]) ? k : best, keys[0]);
};
// 一块板在某个场景下各负载的状态 { 负载 key: 状态名 }
export function scenarioSel(T, name) {
  const sel = {};
  for (const L of (T && T.power && T.power.loads) || []) sel[L.key] = pickState(L, name);
  return sel;
}
// 现在各板选的状态合起来是哪个场景。按瓦数比（两个状态瓦数相同就不区分）；都对不上是 'custom'。
// 没有任何可切换的负载时算 'typ'
export function scenarioOf(entries) {
  return SCENARIOS.slice().sort((a, b) => (b === 'typ') - (a === 'typ')).find(name => entries.every(({ T, sel }) =>
    ((T.power && T.power.loads) || []).every(L => {
      const cur = own(L.states, sel && sel[L.key]) ? sel[L.key] : defaultState(L);
      return L.states[cur] === L.states[pickState(L, name)];
    }))) || 'custom';
}

// 一块板在各电源轨上的电流，以及是否超过单槽上限。defs 是 system.json 的 power.rails。
// 返回 [{ rail, amps, ampsNow, limit, over, overNow }]，只含登记了电压的轨。amps 按峰值算，ampsNow 按当前选的状态算：
// overNow 是现在就超了，只有 over 是最坏情况下会超
export function railCurrents(bp, defs = {}) {
  return Object.entries(bp.rails).filter(([rail]) => defs[rail] && defs[rail].volts > 0).map(([rail, r]) => {
    const amps = r.peak / defs[rail].volts, ampsNow = r.now / defs[rail].volts, limit = defs[rail].limit;
    return { rail, amps, ampsNow, limit, over: limit != null && amps > limit, overNow: limit != null && ampsNow > limit };
  });
}

// 一位小数，不到 1 W 的保留两位
export const fmtW = v => (Math.abs(v) >= 1 || v === 0 ? v.toFixed(1) : v.toFixed(2)) + ' W';
// 按钮上用的短写法：去掉末尾的零（4 W、0.3 W）
export const fmtWShort = v => String(+(Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2))) + ' W';
export const fmtH = h => h == null ? '—' : h === Infinity ? '∞' : h >= 100 ? Math.round(h) + ' h' : h.toFixed(1) + ' h';

/* 外部电源输入：太阳能板和地面电源（GSE） */
// 一串太阳能电池在最大功率点的功率（W）。S 是 system.json 的 power.solar：cells 串联节数，vmp / imp 单节在最大功率点的电压、电流
export const stringWatts = S => S ? (S.cells || 0) * (S.vmp || 0) * (S.imp || 0) : 0;
// 背板上各个输入口现在供多少电。defs 是背板的 inputs：[{ ref, kind: 'solar' | 'gse', strings: 这个口最多接几串 }]（只写 ref 的字符串也认）；
// sel 是 { ref: 值 }：太阳能口是一个数组，每一串受到的日照占满日照的几成（0–1）；GSE 口是 0 / 1。
// 返回 { list: [{ ref, kind, max, fr: 各串的日照, n: 折合成几串满日照, per: 一串满日照送到 VSYS 的功率, watts }],
//        solar: 太阳能合计（已乘充电芯片的效率）, gse: 接着地面电源 }
export function sources(defs, sel, P = {}) {
  const per = stringWatts(P.solar) * ((P.solar && P.solar.efficiency) || 1), unit = v => Math.max(0, Math.min(1, Number(v) || 0));
  const list = (defs || []).map(d => {
    const o = typeof d === 'string' ? { ref: d } : d, kind = o.kind === 'gse' ? 'gse' : 'solar', max = kind === 'gse' ? 1 : o.strings || 1, v = sel && sel[o.ref];
    const fr = kind === 'gse' ? [] : Array.from({ length: max }, (_, i) => unit(Array.isArray(v) ? v[i] : 0));
    const n = kind === 'gse' ? (Number(v) > 0 ? 1 : 0) : fr.reduce((a, f) => a + f, 0);
    return { ref: o.ref, kind, max, fr, n, per, watts: kind === 'solar' ? n * per : 0 };
  });
  return { list, solar: list.reduce((a, i) => a + i.watts, 0), gse: list.some(i => i.kind === 'gse' && i.n > 0) };
}
// 把电源输入并进预算。b 是 budget() 的结果，src 是 sources() 的结果。返回 b 的副本，另外带上：
//   input    src 本身
//   battery  各档下电池的功率：正数在放电，负数在充电
//   spare    太阳能里用不上的部分（负载和充电都满足了以后多出来的）
//   short    没有电池时输入不够的部分
//   charging 电池在充电（接着地面电源而没有登记充电功率上限时，充电功率是 0 但这一项为 true）
//   runtime  按电池实际放电的功率重新算；电池不在放电时是 Infinity
// 地面电源当作不限功率的可调电源：负载全由它供，电池按 P.chargeLimit（W，没登记就不算数字）充电
export function withSources(b, src, P = {}) {
  const limit = P.chargeLimit != null ? P.chargeLimit : Infinity, has = b.wh > 0;
  const out = { ...b, input: src, battery: {}, spare: {}, short: {}, runtime: {} };
  ALL.forEach(k => {
    const need = b.draw[k];
    let bat = 0, spare = 0, short = 0;
    if (src.gse) bat = has && limit !== Infinity ? -limit : 0;
    else if (src.solar >= need) { const c = has ? Math.min(src.solar - need, limit) : 0; bat = -c; spare = src.solar - need - c; }
    else if (has) bat = need - src.solar;
    else short = need - src.solar;
    out.battery[k] = bat; out.spare[k] = spare; out.short[k] = short;
    out.runtime[k] = !has || (need <= 0 && !src.gse && src.solar <= 0) ? null : bat > 1e-9 ? b.usable / bat : Infinity;
  });
  out.charging = has && (out.battery.now < 0 || src.gse);
  return out;
}
