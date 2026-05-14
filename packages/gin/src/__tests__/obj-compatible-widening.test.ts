import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';

/**
 * `ObjType.compatible(other)` — used by edit-compat tooling and other
 * subset checks. Semantics: "every value of `other` is also a valid
 * value of `this`". For obj types specifically:
 *
 *  - Each field declared on `this` must appear on `other` with a
 *    type that satisfies `thisField.compatible(otherField)` —
 *    OR be optional, in which case `other` may simply omit it.
 *  - In `opts.exact`, the field sets must match exactly (no extras
 *    on `this` beyond what `other` declares).
 *  - `other` may have extra fields that `this` doesn't declare —
 *    those are ignored by `this`'s validator and don't affect
 *    compatibility.
 *
 * The "extra optional fields on `this`" rule is what makes the
 * canonical edit-compat scenario work without a special API:
 * `{x:num, y?:bool}.compatible({x:num})` is true because callers
 * producing the simpler shape still produce values the wider shape
 * accepts (the missing `y` defaults to undefined, which optional
 * handles).
 */
describe('ObjType.compatible — widening / edit-compat scenarios', () => {
  const r = createRegistry();

  test('identical shapes compatible', () => {
    const a = r.obj({ x: { type: r.num() }, y: { type: r.num() } });
    const b = r.obj({ x: { type: r.num() }, y: { type: r.num() } });
    expect(a.compatible(b)).toBe(true);
    expect(b.compatible(a)).toBe(true);
  });

  test('this has extra OPTIONAL field — other may omit it', () => {
    const wider  = r.obj({ x: { type: r.num() }, flag: { type: r.optional(r.bool()) } });
    const narrow = r.obj({ x: { type: r.num() } });
    // Every narrow value (no flag) is valid for wider (flag undefined → optional accepts).
    expect(wider.compatible(narrow)).toBe(true);
    // Reverse: every wider value (with flag) is valid for narrow (extra ignored).
    expect(narrow.compatible(wider)).toBe(true);
  });

  test('this has extra REQUIRED field — other must have it too', () => {
    const wider  = r.obj({ x: { type: r.num() }, flag: { type: r.bool() } });
    const narrow = r.obj({ x: { type: r.num() } });
    // narrow values lack `flag`; wider expects it required → not compatible.
    expect(wider.compatible(narrow)).toBe(false);
    // Other direction: every wider value still satisfies narrow (extras ignored).
    expect(narrow.compatible(wider)).toBe(true);
  });

  test('canonical edit example — replacement direction', () => {
    // old = {x:num, y:num}; new = {x:num, y:num|text, z?:bool}
    // Every old value satisfies new ⇒ `new.compatible(old) === true`.
    // Some new values DON'T satisfy old (y can be text) ⇒ `old.compatible(new) === false`.
    const oldT = r.obj({ x: { type: r.num() }, y: { type: r.num() } });
    const newT = r.obj({
      x: { type: r.num() },
      y: { type: r.or([r.num(), r.text()]) },
      z: { type: r.optional(r.bool()) },
    });
    expect(newT.compatible(oldT)).toBe(true);
    expect(oldT.compatible(newT)).toBe(false);
  });

  test('exact mode rejects extras on either side', () => {
    const a = r.obj({ x: { type: r.num() }, y: { type: r.optional(r.bool()) } });
    const b = r.obj({ x: { type: r.num() } });
    // Without exact: a has optional y, b lacks it — accepted.
    expect(a.compatible(b)).toBe(true);
    // With exact: extras on `a` not in `b` are rejected.
    expect(a.compatible(b, { exact: true })).toBe(false);
  });

  test('removing a required field is rejected for replacement', () => {
    // old has y required; new omits y entirely.
    const oldT = r.obj({ x: { type: r.num() }, y: { type: r.num() } });
    const newT = r.obj({ x: { type: r.num() } });
    // new.compatible(old)? new iterates new's only field (x), finds it on
    // old with compatible type. Returns true — but this answers the wrong
    // question for edit-compat (it just confirms new is a subset).
    expect(newT.compatible(oldT)).toBe(true);
    // old.compatible(new)? old iterates {x, y}. y not on new, y is REQUIRED
    // on old → false. This is the rejection we want.
    expect(oldT.compatible(newT)).toBe(false);
    // The correct edit-compat question is "does the new contract preserve
    // the old's guarantees?" which boils down to checking BOTH directions
    // when shapes change: old.compatible(new) must be true (no fields lost)
    // AND new.compatible(old) must be true (no required fields added).
    // Edit tooling should call both; here y-loss flips one side false.
  });

  test('field type widening accepted in replacement direction', () => {
    const oldT = r.obj({ y: { type: r.num() } });
    const newT = r.obj({ y: { type: r.or([r.num(), r.text()]) } });
    // new.compatible(old): or<num,text>.compatible(num) is true (or accepts num).
    expect(newT.compatible(oldT)).toBe(true);
    // Reverse fails: num.compatible(or) is false.
    expect(oldT.compatible(newT)).toBe(false);
  });

  test('field type narrowing rejected in replacement direction', () => {
    const oldT = r.obj({ y: { type: r.or([r.num(), r.text()]) } });
    const newT = r.obj({ y: { type: r.num() } });
    // new.compatible(old): num.compatible(or<num,text>) is false (num doesn't
    // accept text). Narrowing breaks callers who supply text.
    expect(newT.compatible(oldT)).toBe(false);
  });
});
