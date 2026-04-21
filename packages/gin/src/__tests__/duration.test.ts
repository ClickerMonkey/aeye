import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { DurationType } from '../types/duration';

describe('DurationType', () => {
  const r = createRegistry();

  test('builder and name', () => {
    expect(r.duration()).toBeInstanceOf(DurationType);
    expect(r.duration().name).toBe('duration');
  });

  test('valid accepts number', () => {
    expect(r.duration().valid(1000)).toBe(true);
    expect(r.duration().valid(0)).toBe(true);
    expect(r.duration().valid(NaN)).toBe(false);
    expect(r.duration().valid('1h')).toBe(false);
  });

  test('parse coerces numeric input', () => {
    expect(r.duration().parse(3600000).raw).toBe(3600000);
    expect(r.duration().parse('5000').raw).toBe(5000);
  });

  test('create returns 0', () => {
    expect(r.duration().create()).toBe(0);
  });

  test('init spec exposes component args', () => {
    const i = r.duration().init();
    expect(i).toBeDefined();
    expect(i!.args.name).toBe('object');
    expect(i!.run).toBeDefined();
  });

  test('props include component accessors + toText', () => {
    const p = r.duration().props();
    for (const n of ['totalSeconds', 'totalMinutes', 'totalHours', 'totalDays', 'days', 'hours', 'minutes', 'seconds', 'ms', 'toText']) {
      expect(p[n]).toBeDefined();
    }
  });

  test('encode + parse roundtrip', () => {
    const t = r.duration();
    const back = r.parse(t.toJSON()) as DurationType;
    expect(back).toBeInstanceOf(DurationType);
  });
});
