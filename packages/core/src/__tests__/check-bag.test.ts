import z from 'zod';
import { checkBag } from '../schema/check-bag';

describe('checkBag — the constraints a schema\'s checks add up to', () => {
  it('reads string length bounds, patterns and formats', () => {
    const bag = checkBag(z.string().min(2).max(9).regex(/^a/));
    expect(bag.minimum).toBe(2);
    expect(bag.maximum).toBe(9);
    expect([...(bag.patterns ?? [])].map((p) => p.source)).toEqual(['^a']);
    expect(bag.format).toBe('regex');
  });

  it('treats a format schema as its own first check', () => {
    const bag = checkBag(z.email());
    expect(bag.format).toBe('email');
    expect(bag.patterns?.size).toBe(1);
  });

  it('records base64 as a content encoding', () => {
    expect(checkBag(z.base64()).contentEncoding).toBe('base64');
  });

  it('keeps the tighter of two bounds', () => {
    const bag = checkBag(z.number().min(1).min(5).max(10).max(7));
    expect(bag.minimum).toBe(5);
    expect(bag.maximum).toBe(7);
  });

  it('separates exclusive from inclusive bounds', () => {
    const bag = checkBag(z.number().gt(0).lt(1));
    expect(bag.exclusiveMinimum).toBe(0);
    expect(bag.exclusiveMaximum).toBe(1);
    expect(bag.minimum).toBeUndefined();
  });

  it('gives integer formats their numeric range', () => {
    const bag = checkBag(z.int32());
    expect(bag.format).toBe('int32');
    expect(bag.minimum).toBe(-2147483648);
    expect(bag.maximum).toBe(2147483647);
  });

  it('reads multipleOf', () => {
    expect(checkBag(z.number().multipleOf(3)).multipleOf).toBe(3);
  });

  it('reads array and exact lengths', () => {
    expect(checkBag(z.array(z.string()).min(1).max(4))).toMatchObject({ minimum: 1, maximum: 4 });
    expect(checkBag(z.array(z.string()).length(3))).toMatchObject({ minimum: 3, maximum: 3 });
  });

  it('is empty for a schema with no checks', () => {
    expect(checkBag(z.string())).toEqual({});
  });
});
