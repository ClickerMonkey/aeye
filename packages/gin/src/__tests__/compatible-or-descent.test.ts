import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';

/**
 * `Type.compatible` opens an `or` on the RIGHT, for EVERY type.
 *
 * `a.compatible(b)` reads "every value of `b` is also a valid value of `a`",
 * so a union on the right is assignable to `a` exactly when every one of its
 * variants is. Every concrete class implements the relation by matching on
 * `other`'s class (`other instanceof NumType`, …), and an `or` is not an
 * instance of any of them — so before this, `num.compatible(or<num, num>)`
 * was `false`, and so was `A.compatible(or<A, A>)` for one and the same
 * instance used twice. `OrType` alone carried the correct branch, which only
 * fired when the `Or` was on the LEFT.
 *
 * The descent lives once, on the base class, so no per-class comparison had
 * to learn about unions. These tests pin both halves: a FULLY covered union
 * is now accepted, and a union with one genuinely foreign arm is still
 * refused.
 */
describe('Type.compatible — an `or` on the RIGHT descends for every type', () => {
  test('num accepts a union of nums (the headline repro)', () => {
    const r = createRegistry();
    expect(r.num().compatible(r.or([r.num(), r.num()]))).toBe(true);
  });

  test('the same instance twice — A.compatible(or<A, A>)', () => {
    const r = createRegistry();
    const a = r.obj({ url: { type: r.text() }, method: { type: r.text() } });
    expect(a.compatible(r.or([a, a]))).toBe(true);
  });

  test('not num-specific — text accepts a union of texts', () => {
    const r = createRegistry();
    expect(r.text().compatible(r.or([r.text(), r.text()]))).toBe(true);
  });

  test('a foreign arm still refuses — num vs or<num, text>', () => {
    const r = createRegistry();
    expect(r.num().compatible(r.or([r.num(), r.text()]))).toBe(false);
    // and the same union is fine for something that accepts both arms
    expect(r.any().compatible(r.or([r.num(), r.text()]))).toBe(true);
  });

  test('structurally identical objs — the downstream API-kind trigger', () => {
    // The real report: `HttpRequest.compatible(or<HttpRequest, HttpRequest>)`
    // in a stored program, where a slot's declared type met a union built
    // out of that same type.
    const r = createRegistry();
    const request = () => r.obj({
      url: { type: r.text() },
      body: { type: r.optional(r.text()) },
    });
    const declared = request();
    expect(declared.compatible(r.or([request(), request()]))).toBe(true);
    // A variant that drops a REQUIRED field is not a value of the declared
    // shape, so one bad arm is still enough to refuse the whole union.
    const noUrl = r.obj({ body: { type: r.optional(r.text()) } });
    expect(declared.compatible(r.or([request(), noUrl]))).toBe(false);
  });

  test('nested unions recurse through the public method', () => {
    const r = createRegistry();
    expect(r.num().compatible(r.or([r.num(), r.or([r.num(), r.num()])]))).toBe(true);
    // one text buried two levels down is still found
    expect(r.num().compatible(r.or([r.num(), r.or([r.num(), r.text()])]))).toBe(false);
  });

  test('variants of MIXED classes are each judged on their own terms', () => {
    const r = createRegistry();
    // `optional<num>` accepts a bare num (it unwraps) and an optional<num>.
    const optNum = r.optional(r.num());
    expect(optNum.compatible(r.or([r.num(), r.optional(r.num())]))).toBe(true);
    expect(optNum.compatible(r.or([r.num(), r.text()]))).toBe(false);
  });

  test('descends inside a composite slot, not just at the top', () => {
    const r = createRegistry();
    expect(r.list(r.num()).compatible(r.list(r.or([r.num(), r.num()])))).toBe(true);
    expect(r.list(r.num()).compatible(r.list(r.or([r.num(), r.text()])))).toBe(false);
    expect(
      r.obj({ n: { type: r.num() } })
        .compatible(r.obj({ n: { type: r.or([r.num(), r.num()]) } })),
    ).toBe(true);
    expect(
      r.map(r.text(), r.num())
        .compatible(r.map(r.text(), r.or([r.num(), r.num()]))),
    ).toBe(true);
  });

  test('each variant is judged by the SAME relation it gets on its own', () => {
    const r = createRegistry();
    const positive = r.extend('num', { name: 'positive', options: { min: 0 } });
    // The descent composes; it does not decide. An Extension answers for a
    // union arm exactly as it answers alone:
    expect(positive.compatible(positive)).toBe(true);
    expect(positive.compatible(r.or([positive, positive]))).toBe(true);
    // …including the case `compatible` still gets WRONG in the other
    // direction. An Extension on the right is not descended (see
    // `slotAccepts` in type.ts, which walks the Extension chain itself
    // precisely because `compatible` does not), so this is `false` on its
    // own and stays `false` as a union arm. Pinned so the two halves of the
    // family are not silently conflated: fixing the Extension half is a
    // separate change, and this line is what will fail when it lands.
    expect(r.num().compatible(positive)).toBe(false);
    expect(r.num().compatible(r.or([positive, positive]))).toBe(false);
  });

  test('or<> is the bottom type — no values, so everything accepts it', () => {
    const r = createRegistry();
    expect(r.num().compatible(r.or([]))).toBe(true);
    expect(r.text().compatible(r.or([]))).toBe(true);
  });

  test('OrType on the LEFT is unchanged', () => {
    const r = createRegistry();
    const numOrText = r.or([r.num(), r.text()]);
    expect(numOrText.compatible(r.num())).toBe(true);
    expect(numOrText.compatible(r.bool())).toBe(false);
    // both on the left AND the right: every right variant must land in some
    // left variant.
    expect(numOrText.compatible(r.or([r.num(), r.text()]))).toBe(true);
    expect(numOrText.compatible(r.or([r.num(), r.bool()]))).toBe(false);
  });

  test('the wrappers inherit the descent — accepts / exact', () => {
    const r = createRegistry();
    expect(r.num().accepts(r.or([r.num(), r.num()]))).toBe(true);
    expect(r.num().accepts(r.or([r.num(), r.text()]))).toBe(false);
    // `exact` refuses wrapper unwrapping, but a union of the SAME type is
    // not a wrapper — every one of its values is exactly a num.
    expect(r.num().exact(r.or([r.num(), r.num()]))).toBe(true);
    expect(r.num().exact(r.or([r.num(), r.text()]))).toBe(false);
  });

  test('value-mode options still apply per variant', () => {
    const r = createRegistry();
    const small = r.num({ min: 0, max: 10 });
    const inRange = r.num({ min: 2, max: 8 });
    const tooBig = r.num({ min: 0, max: 100 });
    expect(small.compatible(r.or([inRange, inRange]), { value: true })).toBe(true);
    expect(small.compatible(r.or([inRange, tooBig]), { value: true })).toBe(false);
  });
});
