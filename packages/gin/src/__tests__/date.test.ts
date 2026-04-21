import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { DateType } from '../types/date';

describe('DateType', () => {
  const r = createRegistry();

  test('builder and name', () => {
    expect(r.date()).toBeInstanceOf(DateType);
    expect(r.date().name).toBe('date');
  });

  test('valid requires Date', () => {
    expect(r.date().valid(new Date())).toBe(true);
    expect(r.date().valid('2025-01-01')).toBe(false);
    expect(r.date().valid(1234567890)).toBe(false);
  });

  test('valid respects min/max bounds', () => {
    const t = r.date({ min: '2020-01-01', max: '2025-12-31' });
    expect(t.valid(new Date('2022-06-15'))).toBe(true);
    expect(t.valid(new Date('2019-01-01'))).toBe(false);
    expect(t.valid(new Date('2026-01-01'))).toBe(false);
  });

  test('parse accepts Date and ISO string', () => {
    const d = r.date().parse('2025-06-01');
    expect(d.raw).toBeInstanceOf(Date);
  });

  test('parse rejects invalid input', () => {
    expect(() => r.date().parse('not-a-date')).toThrow();
  });

  test('dump returns ISO date string', () => {
    const t = r.date();
    const d = new Date('2025-06-01T00:00:00Z');
    expect(t.encode(d)).toBe('2025-06-01');
  });

  test('narrow rejects widening bounds', () => {
    expect(() => r.date({ min: '2020-01-01' }).narrow({ min: '2000-01-01' })).toThrow();
    expect(() => r.date({ max: '2020-01-01' }).narrow({ max: '2100-01-01' })).toThrow();
  });

  test('props include date arithmetic and comparison', () => {
    const p = r.date().props();
    for (const n of ['year', 'month', 'day', 'addDays', 'diffDays', 'before', 'after', 'eq', 'toText']) {
      expect(p[n]).toBeDefined();
    }
  });

  test('encode + parse roundtrip', () => {
    const t = r.date({ min: '2020-01-01' });
    const back = r.parse(t.toJSON()) as DateType;
    expect(back).toBeInstanceOf(DateType);
    expect(back.options.min).toBe('2020-01-01');
  });
});
