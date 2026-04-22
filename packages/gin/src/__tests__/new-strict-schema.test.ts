import { describe, test, expect } from 'vitest';
import { toJSONSchema } from '@aeye/core';
import { createRegistry, buildSchemas } from '../index';
import { NewExpr } from '../exprs/new';

/**
 * When `newStrict: true`, `NewExpr.toSchema(opts)` produces a union over
 * every type the LLM could legitimately construct:
 *
 *   ({ kind:'new', type:{name:'Pair'},                        value:[…pair elements…] }
 *  | { kind:'new', type:{name:'num',  options:{min?, max?, …}}, value:any }
 *  | { kind:'new', type:{name:'text', options:{minLength?, …}}, value:any }
 *  | … one branch per built-in class + one per registered named type)
 *
 * This test prints the compiled JSON Schema so we can eyeball what the
 * LLM actually sees, and asserts the key discriminators are present.
 */
describe('NewExpr strict schema — full registry + custom types', () => {
  test('barf: compiled JSON Schema for new (with Pair registered)', () => {
    const r = createRegistry();

    // Custom named type: Pair = [text, num]
    const Pair = r.extend(r.tuple([r.text(), r.num()]), {
      name: 'Pair',
      docs: 'a (label, value) pair',
    });
    r.register(Pair);

    // Build the full NewExpr schema via the static class method —
    // this is the exact Zod the LLM would be given.
    const opts = buildSchemas(r, { newStrict: true });
    const newSchema = NewExpr.toSchema(opts);

    // Convert to JSON Schema via @aeye/core in strict mode (OpenAI-compatible).
    const jsonSchema = toJSONSchema(newSchema, { strict: true });

    // --- THE BARF ---
    // Stringify with indentation so we can see the full shape.
    const barf = JSON.stringify(jsonSchema, null, 2);
    // eslint-disable-next-line no-console
    console.log('\n===== NewExpr strict JSON Schema =====\n' + barf + '\n===== end =====\n');

    // Top-level is now a `$ref` into `$defs/Expr_new` — that def holds the
    // anyOf union of per-type branches.
    const defs = (jsonSchema as { $defs?: Record<string, unknown> }).$defs ?? {};
    const resolve = (b: unknown): unknown => {
      const ref = (b as { $ref?: string }).$ref;
      if (!ref) return b;
      const key = ref.replace(/^#\/\$defs\//, '');
      return defs[key];
    };
    const rootUnion = resolve(jsonSchema) as { anyOf?: unknown[] };
    expect(rootUnion).toHaveProperty('anyOf');
    const branches = rootUnion.anyOf!;
    expect(branches.length).toBeGreaterThan(1);
    const branchNames = branches.map((b) => {
      const branch = resolve(b) as { properties?: { type?: unknown } };
      const typeSchema = resolve(branch.properties?.type) as
        { properties?: { name?: { const?: string } } } | undefined;
      return typeSchema?.properties?.name?.const;
    });
    expect(branchNames).toContain('Pair');
    expect(branchNames).toContain('num');

    // Named-instance branch lands in $defs as `New_Pair`.
    expect(defs).toHaveProperty('New_Pair');
    // Class branch lands as `New_num`.
    expect(defs).toHaveProperty('New_num');
  });

  test('LLM-style payloads validate against the strict schema', () => {
    const r = createRegistry();
    const Pair = r.extend(r.tuple([r.text(), r.num()]), { name: 'Pair' });
    r.register(Pair);
    const opts = buildSchemas(r, { newStrict: true });
    const newSchema = NewExpr.toSchema(opts);

    // Named reference to Pair + inner News for each positional element.
    expect(newSchema.safeParse({
      kind: 'new',
      type: { name: 'Pair' },
      value: [
        { kind: 'new', type: { name: 'text' }, value: 'hello' },
        { kind: 'new', type: { name: 'num'  }, value: 42      },
      ],
    }).success).toBe(true);

    // Built-in class branch: num with options.
    expect(newSchema.safeParse({
      kind: 'new',
      type: { name: 'num', options: { min: 0, max: 100 } },
      value: 50,
    }).success).toBe(true);

    // Unknown type name — no branch matches.
    expect(newSchema.safeParse({
      kind: 'new',
      type: { name: 'NotAType' },
      value: 1,
    }).success).toBe(false);
  });
});
