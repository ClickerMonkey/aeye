import { describe, test, expect } from 'vitest';
import { createRegistry, buildSchemas } from '../index';

/**
 * `Type.toNewSchema(opts)` describes the VALUE side of a `{ kind: 'new' }`
 * Expr — primitives stay primitive, composite slots accept Exprs.
 *
 * `NewExpr.toSchema(opts)` honors `opts.newStrict`: when true, it emits
 * a discriminated union over `opts.types`, locking the LLM to one of the
 * pre-chosen type instances.
 */

describe('Type.toNewSchema', () => {
  const r = createRegistry();
  const opts = buildSchemas(r);

  test('primitives match their value schema', () => {
    expect(r.num().toNewSchema(opts).safeParse(42).success).toBe(true);
    expect(r.num().toNewSchema(opts).safeParse('x').success).toBe(false);
    expect(r.text().toNewSchema(opts).safeParse('hi').success).toBe(true);
  });

  test('list<V> → array of Expr', () => {
    const s = r.list(r.num()).toNewSchema(opts);
    // Each element should be a valid Expr (not a bare number).
    expect(s.safeParse([
      { kind: 'new', type: { name: 'num' }, value: 1 },
      { kind: 'new', type: { name: 'num' }, value: 2 },
    ]).success).toBe(true);
    // A bare number is NOT a valid Expr.
    expect(s.safeParse([1, 2]).success).toBe(false);
  });

  test('obj → each field is Expr', () => {
    const t = r.obj({
      x: { type: r.num() },
      y: { type: r.text() },
    });
    const s = t.toNewSchema(opts);
    expect(s.safeParse({
      x: { kind: 'new', type: { name: 'num' }, value: 5 },
      y: { kind: 'new', type: { name: 'text' }, value: 'hi' },
    }).success).toBe(true);
    expect(s.safeParse({ x: 5, y: 'hi' }).success).toBe(false);
  });

  test('map → array of {key: Expr, value: Expr}', () => {
    const s = r.map(r.text(), r.num()).toNewSchema(opts);
    expect(s.safeParse([{
      key: { kind: 'new', type: { name: 'text' }, value: 'a' },
      value: { kind: 'new', type: { name: 'num' }, value: 1 },
    }]).success).toBe(true);
    // Bare key/value not allowed in strict-new context.
    expect(s.safeParse([{ key: 'a', value: 1 }]).success).toBe(false);
  });

  test('Extension delegates to base', () => {
    const ranged = r.extend('num', { name: 'ranged', options: { min: 0 } });
    expect(ranged.toNewSchema(opts).safeParse(5).success).toBe(true);
    expect(ranged.toNewSchema(opts).safeParse('x').success).toBe(false);
  });
});

describe('Type.toInstanceSchema', () => {
  const r = createRegistry();

  test('matches only THIS instance, not other types of the same class', () => {
    const intT = r.num({ whole: true });
    const s = intT.toInstanceSchema();
    expect(s.safeParse(intT.toJSON()).success).toBe(true);
    // A different num (no `whole`) does NOT match.
    expect(s.safeParse(r.num().toJSON()).success).toBe(false);
    // A different type doesn't match.
    expect(s.safeParse(r.text().toJSON()).success).toBe(false);
  });
});

describe('NewExpr.toSchema strict mode', () => {
  const r = createRegistry();

  test('non-strict: accepts any TypeDef + any value', () => {
    const opts = buildSchemas(r);
    // Use the registry's schema directly; register a parseable shape.
    const newSchema = r.exprClass('new')!.toSchema(opts);
    expect(newSchema.safeParse({
      kind: 'new', type: { name: 'num' }, value: 42,
    }).success).toBe(true);
    expect(newSchema.safeParse({
      kind: 'new', type: { name: 'text' }, value: 'anything',
    }).success).toBe(true);
  });

  test('strict: union = built-in class branches + named-instance branches', () => {
    // The strict schema enumerates ALL built-in Type classes (value: any)
    // plus every registered named type / opts.types entry (value: specific).
    // Bool is a built-in class → its branch is always present.
    const numT = r.num();
    const textT = r.text();
    const opts = buildSchemas(r, { types: [numT, textT], newStrict: true });
    const newSchema = r.exprClass('new')!.toSchema(opts);

    // num (named instance branch OR num class branch) — accepted.
    expect(newSchema.safeParse({
      kind: 'new', type: { name: 'num' }, value: 7,
    }).success).toBe(true);

    // text (same) — accepted.
    expect(newSchema.safeParse({
      kind: 'new', type: { name: 'text' }, value: 'hi',
    }).success).toBe(true);

    // bool — built-in class branch accepts it even if not in opts.types.
    expect(newSchema.safeParse({
      kind: 'new', type: { name: 'bool' }, value: true,
    }).success).toBe(true);

    // Completely unknown name — no branch matches.
    expect(newSchema.safeParse({
      kind: 'new', type: { name: 'NotAType' }, value: 1,
    }).success).toBe(false);
  });

  test('strict: named-instance branch enforces specific value shape', () => {
    // A named instance branch pairs a name-only type with a SPECIFIC value
    // schema derived from that instance's `toNewSchema`. That's where the
    // LLM gets tight guidance for complex composites (obj fields, tuple
    // positions, etc.).
    const nameT = r.text();
    const ageT = r.num({ min: 0, whole: true });
    const personT = r.extend(r.obj({
      name: { type: nameT },
      age: { type: ageT },
    }), { name: 'Person' });
    r.register(personT);

    const opts = buildSchemas(r, { newStrict: true });
    const newSchema = r.exprClass('new')!.toSchema(opts);

    // Correctly-shaped Person — each field is a New Expr of the field type.
    expect(newSchema.safeParse({
      kind: 'new',
      type: { name: 'Person' },
      value: {
        name: { kind: 'new', type: { name: 'text' }, value: 'Alice' },
        age:  { kind: 'new', type: { name: 'num'  }, value: 30      },
      },
    }).success).toBe(true);

    // Missing required field — the Person's value schema is an z.object
    // with `name` and `age`; a missing key fails schema validation.
    expect(newSchema.safeParse({
      kind: 'new',
      type: { name: 'Person' },
      value: {
        name: { kind: 'new', type: { name: 'text' }, value: 'Alice' },
      },
    }).success).toBe(false);

    // Bare primitive values where Expr is expected — rejected.
    expect(newSchema.safeParse({
      kind: 'new',
      type: { name: 'Person' },
      value: { name: 'Alice', age: 30 },
    }).success).toBe(false);
  });
});
