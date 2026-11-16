// 功耗预算的纯计算部分（不碰界面）。单位：瓦、瓦时、小时。
//
// 板卡的功耗写在 system.json 板卡条目的 "power" 里，两种写法：
//   按电源轨：{"rails": {"3v3": [待机, 典型, 峰值], "5v": [待机, 典型, 峰值]}, "source": "measured"}
//   不分轨：  {"idle": 0.1, "typ": 0.4, "peak": 1.2}
// source 取 measured（实测）、datasheet（数据手册）或 est（估算），不写按 est 处理。
// 电池是电源：容量写在板卡的 "wh" 里。
//
// system.json 顶层的 "power"：
//   rails    背板分给每个槽的电源轨，{key: {label, efficiency}}。efficiency 是从电池到这一路的转换效率，
//            VSYS 直接来自电池所以是 1；3V3 和 5V 经过稳压，实际效率填进来之前先按 1 算
//            volts 是这一路的电压（VSYS 取低压保护点，电流按最坏情况算），limit 是每个槽在这一路上的电流上限（安）
//   usable   电池容量里可用的比例（放电深度），默认 1
export const LEVELS = ['idle', 'typ', 'peak'];
const zero = () => ({ idle: 0, typ: 0, peak: 0 });

// 一块板的功耗：三档合计，以及各电源轨上的三档。没有数据返回 null
export function boardPower(T) {
  const P = T && T.power;
  if (!P) return null;
  const out = { ...zero(), rails: {}, source: P.source || 'est' };
  if (P.rails) {
    for (const [rail, v] of Object.entries(P.rails)) {
      const r = { idle: +v[0] || 0, typ: +v[1] || 0, peak: +v[2] || 0 };
      out.rails[rail] = r;
      LEVELS.forEach(k => { out[k] += r[k]; });
    }
  } else {
    if (P.typ == null) return null;
    out.typ = +P.typ; out.idle = P.idle != null ? +P.idle : out.typ; out.peak = P.peak != null ? +P.peak : out.typ;
  }
  return out;
}

// 一套配置的预算。types 是已放置板卡的 system.json 条目（同一种板放了两块就出现两次）。
//   idle/typ/peak  板卡端的总功耗
//   draw           电池端的总功耗（各轨除以转换效率；没分轨的部分按效率 1）
//   rails          各电源轨上的合计
//   wh / usable    电池总容量 / 其中可用的
//   runtime        三档各自的续航小时数；没有电池或没有功耗时为 null
//   missing        既没有功耗数据也不是电池的板卡数，未计入
export function budget(types, P = {}) {
  const defs = P.rails || {}, b = { ...zero(), draw: zero(), rails: {}, wh: 0, usable: 0, runtime: {}, missing: 0, counted: 0 };
  for (const T of types) {
    b.wh += T.wh || 0;
    const bp = boardPower(T);
    if (!bp) { if (!T.wh) b.missing++; continue; }
    b.counted++;
    const railed = zero();
    for (const [rail, r] of Object.entries(bp.rails)) {
      const acc = b.rails[rail] || (b.rails[rail] = zero()), eff = (defs[rail] && defs[rail].efficiency) || 1;
      LEVELS.forEach(k => { acc[k] += r[k]; railed[k] += r[k]; b.draw[k] += r[k] / eff; });
    }
    LEVELS.forEach(k => { b[k] += bp[k]; b.draw[k] += bp[k] - railed[k]; });
  }
  b.usable = b.wh * (P.usable != null ? P.usable : 1);
  LEVELS.forEach(k => { b.runtime[k] = b.usable > 0 && b.draw[k] > 0 ? b.usable / b.draw[k] : null; });
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
