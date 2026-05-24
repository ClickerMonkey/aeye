import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

/**
 * Visual demo — a sprawling type def with embedded Expr bodies in
 * multiple slots, several deliberately broken. Renders the JSON-form
 * of the type with `Type.toJSONCode` and runs `formatProblems`
 * against `Type.validate(engine)` so the reader can eyeball the
 * compiler-style `^^^` underlines landing inside the type def.
 *
 * Run with: `npx vitest run type-jsoncode-demo --reporter=verbose`
 */
describe('Type.toJSONCode + Type.validate — visual demo', () => {
  test('Extension with embedded Expr bodies in props/get/call/init/constraint', () => {
    const r = createRegistry();
    const e = new Engine(r);

    // A custom `Account` type — an obj with two fields, plus a method,
    // plus a getter, plus a constraint, plus an init.
    // Several embedded Exprs are deliberately broken so we can see the
    // pointer output land precisely.
    const Account = r.extend('obj', {
      name: 'Account',
      docs: 'a sample account type with broken bodies',
      props: {
        // Normal field — no embedded Expr.
        balance: { type: r.num({ min: 0 }) },
        // Method that should return num but body returns text.
        wrongType: {
          type: r.fn({ args: r.obj({}), returns: r.num() }),
          get: { kind: 'new', type: { name: 'text' }, value: 'oops' },
        },
        // Method whose body references an unbound name.
        undefinedRef: {
          type: r.fn({ args: r.obj({ x: { type: r.num() } }), returns: r.num() }),
          get: { kind: 'get', path: [{ prop: 'unknownVar' }] },
        },
        // Method body that's actually fine — to show clean parts mixed
        // in with the broken ones.
        ok: {
          type: r.fn({ args: r.obj({}), returns: r.num() }),
          get: { kind: 'new', type: { name: 'num' }, value: 42 },
        },
      },
      // Constraint should return bool but returns num.
      constraint: r.parseExpr({ kind: 'new', type: { name: 'num' }, value: 1 }),
      init: {
        args: r.obj({ start: { type: r.num() } }),
        // init.run references an unbound var.
        run: { kind: 'get', path: [{ prop: 'thisDoesNotExist' }] },
      },
    });
    r.register(Account);

    // Render the type's JSON form with spans, and validate.
    const codeObj = Account.toJSONCode([], 2, 0);
    const probs = Account.validate(e);

    console.log('\n' + '═'.repeat(80));
    console.log('  Account — Type.toJSONCode() output');
    console.log('═'.repeat(80));
    console.log(codeObj.toString());
    console.log('\n' + '═'.repeat(80));
    console.log(`  Account — ${probs.list.length} problems from Type.validate()`);
    console.log('═'.repeat(80));
    for (const p of probs.list) {
      console.log(`  [${p.severity}] ${p.code}: ${p.message} @ ${p.path.join('.')}`);
    }
    console.log('\n' + '═'.repeat(80));
    console.log('  typeJsonCode.formatProblems(problems) — sectioned ^^^ output');
    console.log('═'.repeat(80));
    console.log(codeObj.formatProblems(probs, { color: false }));

    // Sanity: each broken slot produced a problem.
    expect(probs.list.length).toBeGreaterThanOrEqual(3);
  });
});
