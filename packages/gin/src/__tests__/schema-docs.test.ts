import { describe, test, expect } from 'vitest';
import { createRegistry, buildSchemas } from '../index';
import { Prop } from '../type';

/**
 * `SchemaOptions.includeDocs` threads through toValueSchema / toNewSchema
 * so LLM-facing schemas carry the type's documentation via `.describe(...)`.
 *
 *  - 'none' (default): no docs attached
 *  - 'type':           type's own docs only
 *  - 'all':            type's docs + per-prop docs on object/iface fields
 */
describe('includeDocs option', () => {
  const r = createRegistry();

  test("'none' (default): no description on any schema", () => {
    const ranged = r.extend('num', {
      name: 'ranged',
      docs: 'a number with bounds',
      options: { min: 0, max: 100 },
    });
    const opts = buildSchemas(r);
    const s = ranged.toValueSchema(opts);
    expect(s.description).toBeUndefined();
  });

  test("'type': type's docs attached to the top-level schema", () => {
    const ranged = r.extend('num', {
      name: 'ranged',
      docs: 'a number with bounds',
      options: { min: 0, max: 100 },
    });
    const opts = buildSchemas(r, {}); // fine to pass basic
    opts.includeDocs = 'type';
    const s = ranged.toValueSchema(opts);
    expect(s.description).toBe('a number with bounds');
  });

  test("'all': obj fields with docs get per-field descriptions", () => {
    const person = r.obj({
      name: new Prop({ type: r.text(), docs: 'given name' }),
      age:  new Prop({ type: r.num({ min: 0, whole: true }), docs: 'age in whole years' }),
    });
    const opts = buildSchemas(r);
    opts.includeDocs = 'all';

    const s = opts.includeDocs === 'all'
      ? person.toValueSchema(opts)
      : null;
    // The returned obj schema itself has no top-level docs (we didn't set
    // them on the obj type), but its fields have per-field descriptions
    // that came from Prop.docs.
    const shape = (s as unknown as { shape: Record<string, { description?: string }> }).shape;
    expect(shape.name!.description).toBe('given name');
    expect(shape.age!.description).toBe('age in whole years');
  });

  test("'type' does NOT add per-prop descriptions", () => {
    const person = r.obj({
      name: new Prop({ type: r.text(), docs: 'given name' }),
    });
    const opts = buildSchemas(r);
    opts.includeDocs = 'type';
    const s = person.toValueSchema(opts);
    const shape = (s as unknown as { shape: Record<string, { description?: string }> }).shape;
    expect(shape.name!.description).toBeUndefined();
  });

  test('docs propagate through nested composites', () => {
    const role = r.extend('text', {
      name: 'role',
      docs: 'the user role',
    });
    const list = r.list(role);
    const opts = buildSchemas(r);
    opts.includeDocs = 'type';
    const s = list.toValueSchema(opts);
    // Outer list has no docs, but inner element description is set.
    const element = (s as unknown as { element: { description?: string } }).element;
    expect(element.description).toBe('the user role');
  });
});
