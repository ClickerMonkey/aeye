/**
 * `fromJSONSchema`: outside schemas (MCP tools, elicitation forms, OpenAPI)
 * imported without loss, including the keywords strict dialects lack.
 */
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_STRICT, fromJSONSchema, GOOGLE_STRICT, LENIENT, OPENAI_STRICT, type ImportReport } from '../index';

describe('fromJSONSchema', () => {
  it('allOf of objects merges into one object (sendable to every strict dialect)', () => {
    const report: ImportReport = { unsupported: [] };
    const b = fromJSONSchema({
      allOf: [
        { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        { type: 'object', properties: { size: { type: 'integer', minimum: 1 } } },
      ],
    }, report);
    expect(report.unsupported).toEqual([]);
    const js = b.render(OPENAI_STRICT).jsonSchema as any;
    expect(js.allOf).toBeUndefined();
    expect(Object.keys(js.properties)).toEqual(['id', 'size']);
    expect(js.required).toEqual(['id', 'size']);
    expect(b.render(OPENAI_STRICT).parse({ id: 'x', size: null })).toMatchObject({ ok: true, value: { id: 'x' } });
    expect(b.render(OPENAI_STRICT).parse({ id: 'x', size: 0 }).ok).toBe(false);
  });

  it('allOf next to its own keywords keeps both', () => {
    const b = fromJSONSchema({ type: 'string', allOf: [{ minLength: 2 }, { maxLength: 4 }] });
    expect(b.render(LENIENT).parse('abc').ok).toBe(true);
    expect(b.render(LENIENT).parse('a').ok).toBe(false);
    expect(b.render(LENIENT).parse('abcde').ok).toBe(false);
  });

  it('not and if/then/else are kept as rules (words on strict dialects)', () => {
    const b = fromJSONSchema({
      type: 'object',
      properties: { kind: { type: 'string', not: { const: 'internal' } }, port: { type: 'integer' } },
      required: ['kind'],
      if: { properties: { kind: { const: 'http' } } },
      then: { required: ['port'] },
    });
    const an = b.render(ANTHROPIC_STRICT).jsonSchema as any;
    expect(an.properties.kind.description).toBe('Must not be: "internal".');
    expect(an.description).toContain('If it is');
    const r = b.render(ANTHROPIC_STRICT);
    expect(r.parse({ kind: 'internal' }).ok).toBe(false);
    expect(r.parse({ kind: 'http' }).ok).toBe(false);
    expect(r.parse({ kind: 'http', port: 80 }).ok).toBe(true);
    expect(r.parse({ kind: 'ftp' }).ok).toBe(true);
  });

  it('additionalProperties: true is an open object, with or without properties', () => {
    const open = fromJSONSchema({ type: 'object', additionalProperties: true });
    expect(open.render(LENIENT).parse({ q: 'x', n: 2 })).toMatchObject({ ok: true, value: { q: 'x', n: 2 } });
    const withProps = fromJSONSchema({ type: 'object', properties: { name: { type: 'string' } }, additionalProperties: true });
    expect(withProps.render(LENIENT).parse({ name: 'n', other: [1] })).toMatchObject({ ok: true, value: { name: 'n', other: [1] } });
    expect(withProps.render(LENIENT).parse({ name: 1 }).ok).toBe(false);
  });

  it('patternProperties and additionalProperties next to properties become extra keys', () => {
    const b = fromJSONSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
      patternProperties: { '^x-': { type: 'string' } },
      additionalProperties: { type: 'number' },
    });
    expect(b.render(LENIENT).parse({ name: 'n', 'x-a': 'v', other: 1 }).ok).toBe(true);
    expect(b.render(LENIENT).parse({ name: 'n', 'x-a': 1 })).toMatchObject({ ok: false, issues: [{ path: ['x-a'] }] });
    const g = b.render(GOOGLE_STRICT).jsonSchema as any;
    expect(g.additionalProperties).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] });
    const o = b.render(OPENAI_STRICT);
    expect(Object.keys((o.jsonSchema as any).properties)).toEqual(['name', 'extra']);
    expect(o.parse({ name: 'n', extra: [{ key: 'x-a', value: 'v' }, { key: 'n', value: 2 }] })).toMatchObject({ ok: true, value: { name: 'n', 'x-a': 'v', n: 2 } });
  });

  it('reports what it cannot check', () => {
    const report: ImportReport = { unsupported: [] };
    fromJSONSchema({ type: 'object', dependentRequired: { a: ['b'] }, properties: { r: { $ref: 'https://x/y.json' } } }, report);
    expect(report.unsupported).toEqual(['$ref https://x/y.json', 'dependentRequired']);
  });
});
