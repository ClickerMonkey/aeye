import { describe, test, expect } from 'vitest';
import { LENIENT } from '@aeye/schema';
import { createRegistry, type Type } from '../index';
import type { ValueSchemaOptions } from '../node';
import { Prop } from '../type';
import { bindA } from './_a';

/**
 * `ValueSchemaOptions.includeDocs` threads through `toA` / `toNewA`
 * so LLM-facing schemas carry the type's documentation as descriptions.
 *
 *  - 'none' (default): no docs attached
 *  - 'type':           type's own docs only
 *  - 'all':            type's docs + per-prop docs on object/iface fields
 */
interface Js { description?: string; properties?: Record<string, Js>; items?: Js }
const js = (type: Type, opts?: ValueSchemaOptions): Js => bindA(type.toA(opts)).render(LENIENT).jsonSchema as Js;

describe('includeDocs option', () => {
  const r = createRegistry();
  const ranged = () => r.extend('num', { name: 'ranged', docs: 'a number with bounds', options: { min: 0, max: 100 } });

  test("'none' (default): no description on any schema", () => {
    expect(js(ranged(), {}).description).toBeUndefined();
  });

  test("'type': type's docs attached to the top-level schema", () => {
    expect(js(ranged(), { includeDocs: 'type' }).description).toBe('a number with bounds');
  });

  test("'all': obj fields with docs get per-field descriptions", () => {
    const person = r.obj({
      name: new Prop({ type: r.text(), docs: 'given name' }),
      age:  new Prop({ type: r.num({ min: 0, whole: true }), docs: 'age in whole years' }),
    });
    const s = js(person, { includeDocs: 'all' });
    // The obj schema itself has no top-level docs (none set on the obj type),
    // but its fields have per-field descriptions that came from Prop.docs.
    expect(s.description).toBeUndefined();
    expect(s.properties!.name!.description).toBe('given name');
    expect(s.properties!.age!.description).toBe('age in whole years');
  });

  test("'type' does NOT add per-prop descriptions", () => {
    const person = r.obj({ name: new Prop({ type: r.text(), docs: 'given name' }) });
    expect(js(person, { includeDocs: 'type' }).properties!.name!.description).toBeUndefined();
  });

  test('docs propagate through nested composites', () => {
    const role = r.extend('text', { name: 'role', docs: 'the user role' });
    const s = js(r.list(role), { includeDocs: 'type' });
    // Outer list has no docs, but the element's description is set.
    expect(s.description).toBeUndefined();
    expect(s.items!.description).toBe('the user role');
  });
});
