/** Gin → `a`: each TypeDef kind, named types via a registry, recursion. */
import { describe, expect, it } from 'vitest';
import { expectTypeOf } from 'expect-type';
import { a, LENIENT, OPENAI_STRICT } from '../index';
import { fromGin, ginNamedTypes, type GinRegistryLike, type GinTypeDef } from './from-gin';

describe('fromGin', () => {
  it('maps every value kind (types and runtime)', () => {
    const def = {
      name: 'obj',
      props: {
        title: { type: { name: 'text', options: { minLength: 1 } }, docs: 'Title.' },
        points: { type: { name: 'num', options: { whole: true, min: 0 } } },
        done: { type: { name: 'bool' } },
        tags: { type: { name: 'list', generic: { V: { name: 'text' } } } },
        weights: { type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } } },
        byDay: { type: { name: 'map', generic: { K: { name: 'num' }, V: { name: 'text' } } } },
        note: { type: { name: 'optional', generic: { T: { name: 'text' } } } },
        due: { type: { name: 'nullable', generic: { T: { name: 'date' } } } },
        level: { type: { name: 'enum', options: { values: { LOW: 'low', HIGH: 'high' } } } },
        kind: { type: { name: 'literal', options: { value: 'task' } } },
        owner: { type: { name: 'Person' } },
        extra: { type: { name: 'any' } },
      },
    } as const;
    const s = fromGin(def);
    type T = a.infer<typeof s>;
    expectTypeOf<T['title']>().toEqualTypeOf<string>();
    expectTypeOf<T['tags']>().toEqualTypeOf<string[]>();
    expectTypeOf<T['weights']>().toEqualTypeOf<Record<string, number>>();
    expectTypeOf<T['byDay']>().toEqualTypeOf<{ key: number; value: string }[]>();
    expectTypeOf<T['due']>().toEqualTypeOf<string | null>();
    expectTypeOf<T['level']>().toEqualTypeOf<'low' | 'high'>();
    expectTypeOf<T['kind']>().toEqualTypeOf<'task'>();
    expectTypeOf<T>().toHaveProperty('note');

    const People = a.define({ Person: a.object({ name: a.string() }) }).result(s);
    const js = People.render(LENIENT).jsonSchema as any;
    expect(js.properties.title).toEqual({ type: 'string', minLength: 1, description: 'Title.' });
    expect(js.properties.points).toEqual({ type: 'integer', minimum: 0 });
    expect(js.properties.weights).toEqual({ type: 'object', additionalProperties: { type: 'number' } });
    expect(js.properties.byDay.type).toBe('array');
    expect(js.properties.owner).toEqual({ $ref: '#/$defs/Person' });
    expect(js.required).not.toContain('note');
    // Strict: the SAME gin map<text, num> becomes pairs only on the wire.
    expect((People.render(OPENAI_STRICT).jsonSchema as any).properties.weights.type).toBe('array');
  });

  it('a registry of named (recursive) gin types feeds the dynamic step', () => {
    const named = new Map<string, GinTypeDef>([
      ['Task', { name: 'obj', props: { title: { type: { name: 'text' } }, owner: { type: { name: 'Person' } }, subtasks: { type: { name: 'optional', generic: { T: { name: 'list', generic: { V: { name: 'Task' } } } } } } } }],
      ['Person', { name: 'obj', props: { name: { type: { name: 'text' } } } }],
    ]);
    const registry: GinRegistryLike = { version: 1, named: () => named };
    interface Task { title: string; owner: { name: string }; subtasks?: Task[] }

    const SaveTask = a
      .declare<{ Task: Task }>()
      .dynamic((reg: GinRegistryLike) => ginNamedTypes<{ Task: Task }>(reg), { key: (reg) => reg.version })
      .result(a.object({ task: a.ref('Task') }));
    expectTypeOf<a.infer<typeof SaveTask>>().toEqualTypeOf<{ task: Task }>();

    const r = SaveTask.render(OPENAI_STRICT, registry);
    expect(Object.keys(r.jsonSchema.$defs as object).sort()).toEqual(['Person', 'Task']);
    const res = r.parse({ task: { title: 'a', owner: { name: 'p' }, subtasks: [{ title: 'b', owner: { name: 'q' }, subtasks: null }] } });
    expect(res.ok && res.value).toEqual({ task: { title: 'a', owner: { name: 'p' }, subtasks: [{ title: 'b', owner: { name: 'q' } }] } });
  });

  it('typ / fn values are refs into the gin grammar module', () => {
    expect(fromGin({ name: 'typ' })).toMatchObject({ kind: 'ref', name: 'TypeDef' });
    expect(fromGin({ name: 'fn' })).toMatchObject({ kind: 'ref', name: 'Expr' });
  });
});
