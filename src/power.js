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
    out.loads.push({ key: L.key, name: L.name || L.key, rail: L.rail, interface: L.interface || null, states: L.states, state, watts: L.states[state] });
  }
  return any ? out : null;
}

// 一套配置的预算。entries 是已放置的板卡：[{ T: system.json 里的条目, sel: 各负载选的状态 }]
//   now/idle/typ/peak  板卡端的总功耗
//   draw               电池端的总功耗（各轨除以转换效率；没分轨的部分按效率 1）
//   rails              各电源轨上的合计
//   wh / usable        电池总容量 / 其中可用的
//   runtime            各档的续航小时数；没有电池或没有功耗时为 null
//   missing            既没有功耗数据也不是电池的板卡数，未计入
export function budget(entries, P = {}) {
  const defs = P.rails || {}, b = { ...zero(), draw: zero(), rails: {}, wh: 0, usable: 0, runtime: {}, missing: 0, counted: 0 };
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
  ALL.forEach(k => { b.runtime[k] = b.usable > 0 && b.draw[k] > 0 ? b.usable / b.draw[k] : null; });
  return b;
}

// 一块板在各电源轨上的峰值电流，以及是否超过单槽上限。defs 是 system.json 的 power.rails。
// 返回 [{ rail, amps, limit, over }]，只含登记了电压的轨
export function railCurrents(bp, defs = {}) {
  return Object.entries(bp.rails).filter(([rail]) => defs[rail] && defs[rail].volts > 0).map(([rail, r]) => {
    const amps = r.peak / defs[rail].volts, limit = defs[rail].limit;
    return { rail, amps, limit, over: limit != null && amps > limit };
  });
}

export const fmtW = v => (v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' W';
export const fmtH = h => h == null ? '—' : h >= 100 ? Math.round(h) + ' h' : h.toFixed(1) + ' h';
