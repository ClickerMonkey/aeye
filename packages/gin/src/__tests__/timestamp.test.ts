import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { TimestampType } from '../types/timestamp';

describe('TimestampType', () => {
  const r = createRegistry();

  test('builder and name', () => {
    expect(r.timestamp()).toBeInstanceOf(TimestampType);
    expect(r.timestamp().name).toBe('timestamp');
  });

  test('valid accepts Date', () => {
    expect(r.timestamp().valid(new Date())).toBe(true);
    expect(r.timestamp().valid('2025-01-01T00:00:00Z')).toBe(false);
    expect(r.timestamp().valid(new Date(NaN))).toBe(false);
  });

  test('parse accepts ISO with time', () => {
    const v = r.timestamp().parse('2025-06-01T12:34:56Z');
    expect(v.raw).toBeInstanceOf(Date);
  });

  test('dump returns full ISO string', () => {
    const d = new Date('2025-06-01T12:00:00Z');
    expect(r.timestamp().encode(d)).toBe('2025-06-01T12:00:00.000Z');
  });

  test('props include time components + duration arithmetic', () => {
    const p = r.timestamp().props();
    for (const n of ['year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond', 'addDuration', 'subDuration', 'diff', 'toDate', 'toEpoch']) {
      expect(p[n]).toBeDefined();
    }
  });

  test('encode + parse roundtrip', () => {
    const t = r.timestamp();
    const back = r.parse(t.toJSON()) as TimestampType;
    expect(back).toBeInstanceOf(TimestampType);
  });
});
