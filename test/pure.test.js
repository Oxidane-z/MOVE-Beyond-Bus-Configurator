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
