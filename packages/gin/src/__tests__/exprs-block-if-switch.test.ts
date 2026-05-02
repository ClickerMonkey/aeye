import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

describe('evalBlock', () => {
  const e = new Engine(createRegistry());

  test('returns the last expression value', async () => {
    const v = await e.run({
      kind: 'block',
      lines: [
        { kind: 'new', type: { name: 'num' }, value: 1 },
        { kind: 'new', type: { name: 'num' }, value: 2 },
        { kind: 'new', type: { name: 'num' }, value: 3 },
      ],
    });
    expect(v.raw).toBe(3);
  });

  test('empty block returns void', async () => {
    const v = await e.run({ kind: 'block', lines: [] });
    expect(v.type.name).toBe('void');
  });
});

describe('evalIf', () => {
  const e = new Engine(createRegistry());

  test('picks first truthy branch', async () => {
    const v = await e.run({
      kind: 'if',
      ifs: [
        { condition: { kind: 'new', type: { name: 'bool' }, value: false }, body: { kind: 'new', type: { name: 'num' }, value: 1 } },
        { condition: { kind: 'new', type: { name: 'bool' }, value: true },  body: { kind: 'new', type: { name: 'num' }, value: 2 } },
      ],
      else: { kind: 'new', type: { name: 'num' }, value: 3 },
    });
    expect(v.raw).toBe(2);
  });

  test('falls through to else', async () => {
    const v = await e.run({
      kind: 'if',
      ifs: [
        { condition: { kind: 'new', type: { name: 'bool' }, value: false }, body: { kind: 'new', type: { name: 'num' }, value: 1 } },
      ],
      else: { kind: 'new', type: { name: 'num' }, value: 99 },
    });
    expect(v.raw).toBe(99);
  });

  test('no match and no else → void', async () => {
    const v = await e.run({
      kind: 'if',
      ifs: [{ condition: { kind: 'new', type: { name: 'bool' }, value: false }, body: { kind: 'new', type: { name: 'num' }, value: 1 } }],
    });
    expect(v.type.name).toBe('void');
  });
});

describe('evalSwitch', () => {
  const e = new Engine(createRegistry());

  test('matches case by === on raw', async () => {
    const v = await e.run({
      kind: 'switch',
      value: { kind: 'new', type: { name: 'text' }, value: 'b' },
      cases: [
        { equals: [{ kind: 'new', type: { name: 'text' }, value: 'a' }], body: { kind: 'new', type: { name: 'num' }, value: 1 } },
        { equals: [{ kind: 'new', type: { name: 'text' }, value: 'b' }], body: { kind: 'new', type: { name: 'num' }, value: 2 } },
      ],
      else: { kind: 'new', type: { name: 'num' }, value: 0 },
    });
    expect(v.raw).toBe(2);
  });

  test('falls through to else on no match', async () => {
    const v = await e.run({
      kind: 'switch',
      value: { kind: 'new', type: { name: 'num' }, value: 5 },
      cases: [{ equals: [{ kind: 'new', type: { name: 'num' }, value: 1 }], body: { kind: 'new', type: { name: 'num' }, value: 10 } }],
      else: { kind: 'new', type: { name: 'num' }, value: -1 },
    });
    expect(v.raw).toBe(-1);
  });

  test('toCode: bodies render as plain indented statements (no out-of-sync braces)', () => {
    // Reproduces the user's example. The previous `renderStatementBody`
    // wrapping in `{ ... }` and re-indenting via `indentCode` shifted
    // the closing brace above the break statement; this asserts the
    // new clean form: case label, body line(s) at +4, optional break
    // at +4, default likewise.
    const code = e.toCode({
      kind: 'switch',
      value: { kind: 'get', path: [{ prop: 'y' }] },
      cases: [{
        equals: [{ kind: 'new', type: { name: 'num' }, value: 5 }],
        body: { kind: 'new', type: { name: 'text' }, value: 'y is five' },
      }],
      else: { kind: 'new', type: { name: 'text' }, value: 'y is not five' },
    } as any);
    expect(code).toBe(
      'switch (y) {\n' +
      '  case 5:\n' +
      '    "y is five";\n' +
      '    break;\n' +
      '  default:\n' +
      '    "y is not five";\n' +
      '}',
    );
  });

  test('toCode: case body that is a `flow` skips the auto-`break`', () => {
    // A return / throw / exit terminates control flow on its own —
    // appending `break;` after would be unreachable.
    const code = e.toCode({
      kind: 'switch',
      value: { kind: 'get', path: [{ prop: 'x' }] },
      cases: [{
        equals: [{ kind: 'new', type: { name: 'num' }, value: 1 }],
        body: { kind: 'flow', action: 'return', value: { kind: 'new', type: { name: 'num' }, value: 99 } },
      }],
    } as any);
    expect(code).toContain('case 1:\n    return 99;');
    expect(code).not.toContain('return 99;\n    break;');
  });
});
