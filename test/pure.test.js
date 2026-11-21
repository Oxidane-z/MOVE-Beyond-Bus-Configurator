import { describe, it, expect } from 'vitest';
import sys from '../system.json';
import { fit, swapPlan } from '../src/slots.js';
import { classifyColor, MATERIALS, inkOn, contrast } from '../src/color.js';
import { serialize, parse, presetCfg } from '../src/config.js';

const E = null;

describe('fit', () => {
  it('places a single-slot board only on a free slot', () => {
    const s = [E, 1, E, E, E, E, E];
    expect(fit(s, 1, 0)).toBe(0);
    expect(fit(s, 1, 1)).toBe(-1);
    expect(fit(s, 1, 7)).toBe(-1);
    expect(fit(s, 1, -1)).toBe(-1);
  });
  it('places a two-slot board at the slot or one before it', () => {
    const s = [E, E, 1, E, 2, E, E];
    expect(fit(s, 2, 0)).toBe(0);
    expect(fit(s, 2, 1)).toBe(0);
    expect(fit(s, 2, 3)).toBe(-1);
    expect(fit(s, 2, 6)).toBe(5);
  });
  it('ignores the board being moved', () => {
    const s = [1, 1, E, 2, E, E, E];
    expect(fit(s, 2, 1, 1)).toBe(1);
    expect(fit(s, 2, 2, 1)).toBe(1);
  });
});

describe('swapPlan', () => {
  it('swaps boards of equal width', () => {
    const s = [1, E, 2, E, E, E, E];
    const plan = swapPlan(s, { id: 1, slot: 0, w: 1 }, { id: 2, slot: 2, w: 1 });
    expect(plan.get(1)).toBe(2);
    expect(plan.get(2)).toBe(0);
  });
  it('keeps the outer ends when widths differ', () => {
    const s = [1, 2, 2, E, E, E, E];
    const plan = swapPlan(s, { id: 1, slot: 0, w: 1 }, { id: 2, slot: 1, w: 2 });
    expect(plan.get(2)).toBe(0);
    expect(plan.get(1)).toBe(2);
  });
  it('fails when a third board is in the way', () => {
    const s = [1, 3, E, 2, 2, E, E];
    // 2 (w=2) moves to slot 0–1, but slot 1 holds board 3
    expect(swapPlan(s, { id: 1, slot: 0, w: 1 }, { id: 2, slot: 3, w: 2 })).toBeNull();
  });
});

describe('colors', () => {
  it('classifies CAD colours into materials', () => {
    expect(classifyColor(0.05, 0.05, 0.05)).toBe(MATERIALS.dark);
    expect(classifyColor(0.8, 0.8, 0.8)).toBe(MATERIALS.light);
    expect(classifyColor(0.9, 0.8, 0.1)).toBe(MATERIALS.gold);
    expect(classifyColor(0.6, 0.35, 0.1)).toBe(MATERIALS.kapton);
    expect(classifyColor(0.1, 0.2, 0.9)).toBe(MATERIALS.light);
  });
  it('picks readable ink on every subsystem colour', () => {
    for (const s of Object.values(sys.subsystems)) {
      const got = contrast(s.color, inkOn(s.color));
      expect(got).toBe(Math.max(contrast(s.color, '#ffffff'), contrast(s.color, '#25262b')));
      expect(got).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('config text form', () => {
  it('round-trips every preset layout', () => {
    for (const key of Object.keys(sys.layouts)) {
      const cfg = presetCfg(sys, key, sys.backplane);
      expect(parse(sys, serialize(sys, cfg))).toEqual(cfg);
    }
  });
  it('writes only non-default options', () => {
    const cfg = presetCfg(sys, 'rexus', 'v78');
    expect(serialize(sys, cfg)).toBe('v78;obdh,1;recovery,3;battery,4;adcs,6;piklas,7');
    cfg.boards[0].exps = [null];
    cfg.boards[1].bracket = 'front';
    const text = serialize(sys, cfg);
    expect(text).toBe('v78;obdh,1,e-;recovery,3,bfront;battery,4;adcs,6;piklas,7');
    expect(parse(sys, text)).toEqual(cfg);
  });
  it('rejects unknown backplanes and skips bad boards', () => {
    expect(parse(sys, '')).toBeNull();
    expect(parse(sys, 'nope;cdh,1')).toBeNull();
    expect(parse(sys, 'constructor;cdh,1')).toBeNull();
    const cfg = parse(sys, 'v6;cdh,1;cdh,1;bogus,2;battery,7;payload,x;constructor,3;adcs,3,bsideways,eunknown');
    expect(cfg.bp).toBe('v6');
    expect(cfg.boards.map(b => [b.type, b.slot])).toEqual([['cdh', 0], ['adcs', 2]]);
    expect(cfg.boards[1].bracket).toBe('back');
  });
  it('never changes a fixed expansion site', () => {
    const cfg = parse(sys, 'v78;battery,1,e-');
    expect(cfg.boards[0].exps).toEqual(['battery-heater']);
  });
});

import { boardPower, budget } from '../src/power.js';

describe('power', () => {
  const P = { rails: { vsys: { efficiency: 1 }, '5v': { efficiency: 0.8 }, '3v3': { efficiency: 1 } }, usable: 0.5 };
  it('sums rails into idle / typ / peak', () => {
    const bp = boardPower({ power: { rails: { '3v3': [0.1, 0.2, 0.3], '5v': [0, 1, 2] }, source: 'measured' } });
    expect([bp.idle, bp.typ, bp.peak].map(v => +v.toFixed(3))).toEqual([0.1, 1.2, 2.3]);
    expect(bp.source).toBe('measured');
  });
  it('fills idle and peak from typ when only typ is given', () => {
    expect(boardPower({ power: { typ: 0.4 } })).toMatchObject({ idle: 0.4, typ: 0.4, peak: 0.4, source: 'est' });
    expect(boardPower({})).toBe(null);
  });
  it('applies rail efficiency and usable capacity to the runtime', () => {
    const b = budget([{ wh: 10 }, { power: { rails: { '5v': [0.4, 0.8, 1.6] } } }, { power: { typ: 1 } }, {}].map(T => ({ T })), P);
    expect(b.typ).toBeCloseTo(1.8);
    expect(b.draw.typ).toBeCloseTo(2);       // 0.8 / 0.8 + 1
    expect(b.runtime.typ).toBeCloseTo(2.5);  // 10 Wh × 0.5 ÷ 2 W
    expect(b.missing).toBe(1);
    expect(budget([{ T: { power: { typ: 1 } } }], P).runtime.typ).toBe(null);
  });
  it('derives idle / typ / peak from load states and follows the selected state', () => {
    const T = { power: { base: { '3v3': 0.1 }, loads: [
      { key: 'pa', rail: '5v', states: { off: 0, tx: 4 }, default: 'off' },
      { key: 'gnss', rail: '3v3', states: { off: 0, on: 0.3 }, default: 'on' }] } };
    const d = boardPower(T);
    expect([d.idle, d.typ, d.peak, d.now].map(v => +v.toFixed(2))).toEqual([0.1, 0.4, 4.4, 0.4]);
    const s = boardPower(T, { pa: 'tx', gnss: 'off', nope: 'x' });
    expect(+s.now.toFixed(2)).toBe(4.1);
    expect(s.rails['5v'].now).toBe(4);
    expect(s.loads.map(l => l.state)).toEqual(['tx', 'off']);
    expect(boardPower(T, { pa: 'bogus' }).now).toBeCloseTo(0.4);
  });
  it('keeps non-default load states in the config text', () => {
    const cfg = parse(sys, 'v78;recovery,3,plora-pa=tx+gnss=on+x=y');
    expect(cfg.boards[0].loads).toEqual({ 'lora-pa': 'tx' });
    expect(serialize(sys, cfg)).toBe('v78;recovery,3,plora-pa=tx');
  });
});

import { railCurrents } from '../src/power.js';
describe('rail limits', () => {
  it('flags a rail whose peak current exceeds the slot limit', () => {
    const defs = { '5v': { volts: 5, limit: 5 }, vsys: { volts: 6.5, limit: 5 }, x: {} };
    const c = railCurrents(boardPower({ power: { rails: { '5v': [5, 10, 30], vsys: [0, 1, 13], x: [1, 1, 1] } } }), defs);
    expect(c.map(v => [v.rail, +v.amps.toFixed(2), v.over])).toEqual([['5v', 6, true], ['vsys', 2, false]]);
  });
});

import { scenarioSel, scenarioOf, fmtW, fmtWShort } from '../src/power.js';
describe('power: totals you can trust', () => {
  const P = { rails: { '5v': { efficiency: 0.8, volts: 5, limit: 5 } }, usable: 1 };
  const T = { power: { loads: [
    { key: 'pa', rail: '5v', states: { off: 0, rx: 1, tx: 4 }, default: 'rx' },
    { key: 'gnss', rail: '5v', states: { off: 0, on: 2 }, default: 'on' }] } };
  it('marks the budget as partial and counts boards when some have no data', () => {
    const b = budget([{ T: { wh: 10 } }, { T }, { T: {} }, { T: {} }], P);
    expect([b.counted, b.boards, b.missing, b.partial]).toEqual([1, 3, 2, true]);
    expect(budget([{ T: { wh: 10 } }, { T }], P).partial).toBe(false);
  });
  it('reports conversion loss as battery side minus board side', () => {
    const b = budget([{ T }], P);
    expect(b.now).toBeCloseTo(3);
    expect(b.draw.now).toBeCloseTo(3.75);
    expect(b.loss.now).toBeCloseTo(0.75);
    expect(b.loss.peak).toBeCloseTo(6 / 0.8 - 6);
  });
  it('builds scenario selections and recognises them', () => {
    expect(scenarioSel(T, 'idle')).toEqual({ pa: 'off', gnss: 'off' });
    expect(scenarioSel(T, 'typ')).toEqual({ pa: 'rx', gnss: 'on' });
    expect(scenarioSel(T, 'peak')).toEqual({ pa: 'tx', gnss: 'on' });
    expect(scenarioOf([{ T, sel: {} }, { T: { wh: 5 } }])).toBe('typ');
    expect(scenarioOf([{ T, sel: scenarioSel(T, 'peak') }])).toBe('peak');
    expect(scenarioOf([{ T, sel: scenarioSel(T, 'idle') }])).toBe('idle');
    expect(scenarioOf([{ T, sel: { pa: 'tx', gnss: 'off' } }])).toBe('custom');
    expect(scenarioOf([])).toBe('typ');
  });
  it('tells a present overload from a worst-case one', () => {
    const c = railCurrents(boardPower({ power: { loads: [{ key: 'x', rail: '5v', states: { a: 10, b: 30 }, default: 'a' }] } }), P.rails)[0];
    expect([c.over, c.overNow]).toEqual([true, false]);
    const d = railCurrents(boardPower({ power: { loads: [{ key: 'x', rail: '5v', states: { a: 10, b: 30 }, default: 'a' }] } }, { x: 'b' }), P.rails)[0];
    expect([d.over, d.overNow]).toEqual([true, true]);
  });
  it('formats watts with one decimal, two below 1 W', () => {
    expect([fmtW(5), fmtW(10), fmtW(20.04), fmtW(0.4), fmtW(0)]).toEqual(['5.0 W', '10.0 W', '20.0 W', '0.40 W', '0.0 W']);
    expect([fmtWShort(4), fmtWShort(0.3), fmtWShort(0), fmtWShort(10.5)]).toEqual(['4 W', '0.3 W', '0 W', '10.5 W']);
  });
});

import { sources, withSources, stringWatts } from '../src/power.js';

describe('power inputs', () => {
  const P = { usable: 0.5, solar: { cells: 6, vmp: 2, imp: 0.5, efficiency: 0.5 } };   // 6 W per string, 3 W after the charger
  const defs = [{ ref: 'G', kind: 'gse' }, { ref: 'A', strings: 1 }, { ref: 'B', strings: 3 }];
  const load = w => budget([{ T: { wh: 10 } }, { T: { power: { typ: w } } }], P);
  it('adds up the strings in sun and clamps them to what the connector takes', () => {
    expect(stringWatts(P.solar)).toBeCloseTo(6);
    const s = sources(defs, { A: [5], B: [1, 0.5], X: [1] }, P);
    expect(s.list.map(i => i.n)).toEqual([0, 1, 1.5]);
    expect(s.list[2].fr).toEqual([1, 0.5, 0]);
    expect(s.solar).toBeCloseTo(7.5);
    expect(s.gse).toBe(false);
  });
  it('lets the battery cover what the sun does not, and stretches the runtime', () => {
    const b = withSources(load(5), sources(defs, { A: [1] }, P), P);
    expect(b.battery.typ).toBeCloseTo(2);
    expect(b.runtime.typ).toBeCloseTo(2.5);   // 10 Wh × 0.5 ÷ 2 W
    expect(b.charging).toBe(false);
  });
  it('charges the battery with the surplus and never runs out', () => {
    const b = withSources(load(5), sources(defs, { B: [1, 1, 1] }, P), P);
    expect(b.battery.typ).toBeCloseTo(-4);
    expect(b.runtime.typ).toBe(Infinity);
    expect(b.charging).toBe(true);
    expect(withSources(load(5), sources(defs, { B: [1, 1, 1] }, P), { ...P, chargeLimit: 1 }).spare.typ).toBeCloseTo(3);
  });
  it('treats the GSE supply as unlimited', () => {
    const b = withSources(load(50), sources(defs, { G: 1 }, P), P);
    expect(b.battery.typ).toBe(0);
    expect(b.runtime.typ).toBe(Infinity);
    expect(b.charging).toBe(true);
  });
  it('reports the shortfall when there is no battery', () => {
    const b = withSources(budget([{ T: { power: { typ: 5 } } }], P), sources(defs, { A: [1] }, P), P);
    expect(b.short.typ).toBeCloseTo(2);
    expect(b.runtime.typ).toBe(null);
  });
  it('keeps the inputs in the share link', () => {
    const cfg = { bp: 'v78', boards: [], inputs: { 'MLP-6P-1': [1, 0.5], HARNESS: 1, 'MLP-2P': [0], bogus: [1] } };
    const str = serialize(sys, cfg);
    expect(str).toBe('v78;in:HARNESS=1+MLP-6P-1=100.50');
    expect(parse(sys, str).inputs).toEqual({ HARNESS: 1, 'MLP-6P-1': [1, 0.5, 0] });
    expect(parse(sys, 'v78;in:MLP-2P=900+MLP-6P-2=0.0.35').inputs).toEqual({ 'MLP-2P': [1], 'MLP-6P-2': [0, 0, 0.35] });
  });
});

import { fitOver, span, overOf, NONE } from '../src/slots.js';

describe('overhang', () => {
  const front = { w: 2, connectorSlot: 1, overhang: true }, back = { w: 2, overhang: true }, plain = { w: 2, connectorSlot: 1 };
  it('knows which way a board may overhang', () => {
    expect([overOf(front), overOf(back), overOf(plain), overOf({ w: 1, overhang: true })]).toEqual([-1, 1, 0, 0]);
  });
  it('puts the connector in the edge slot and takes one slot there', () => {
    const s = [null, null, null, 5, null, null, null];
    expect(fitOver(s, 2, 0, null, -1)).toBe(-1);
    expect(fitOver(s, 2, 1, null, -1)).toBe(1);
    expect(fitOver(s, 2, 6, null, 1)).toBe(6);
    expect(fitOver(s, 2, 0, null, 0)).toBe(0);
    expect(fitOver(s, 2, 3, null, -1)).toBe(NONE);
    expect(fitOver([9, null, null], 2, 0, null, -1)).toBe(NONE);
  });
  it('clips the occupied span and rejects other positions outside the slots', () => {
    expect(span(front, -1, 7)).toEqual([0, 1]);
    expect(span(back, 6, 7)).toEqual([6, 7]);
    expect(span(front, 2, 7)).toEqual([2, 4]);
    expect(span(front, 6, 7)).toBeNull();
    expect(span(plain, -1, 7)).toBeNull();
    expect(span(back, -1, 7)).toBeNull();
  });
  it('keeps an overhanging board in the share link', () => {
    const cfg = parse(sys, 'v78;obdh,0;recovery,2;battery,1');
    expect(cfg.boards.map(b => [b.type, b.slot])).toEqual([['obdh', -1], ['recovery', 1]]);   // the battery would overlap slot 1
    expect(serialize(sys, cfg)).toBe('v78;obdh,0;recovery,2');
    expect(parse(sys, 'v78;battery,0').boards).toEqual([]);
  });
});
