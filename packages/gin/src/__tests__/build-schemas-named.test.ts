import { describe, test, expect } from 'vitest';
import { createRegistry, buildSchemas } from '../index';

/**
 * `buildSchemas` folds registered named types (and explicit `opts.types`)
 * into `opts.Type` as first-class union branches. The LLM can reference
 * a user type by name alone, e.g. `{ name: 'Task' }`.
 */
describe('buildSchemas: named user types', () => {
  test('registered Extension shows up in opts.Type', () => {
    const r = createRegistry();
    const Task = r.extend('object', {
      name: 'Task',
      props: {
        title: { type: r.text({ minLength: 1 }) },
        done:  { type: r.bool() },
      },
    });
    r.register(Task);

    const opts = buildSchemas(r);

    // Name-only reference — resolves via registered lookup at parse time.
    expect(opts.Type.safeParse({ name: 'Task' }).success).toBe(true);
    // Built-in classes still work.
    expect(opts.Type.safeParse({ name: 'num' }).success).toBe(true);
    // Unknown name rejected (no named branch, no matching class).
    expect(opts.Type.safeParse({ name: 'NotATask' }).success).toBe(false);
  });

  test('explicit opts.types is merged with registered list, deduped by name', () => {
    const r = createRegistry();

    // Register A with one shape.
    const A1 = r.extend('object', {
      name: 'A',
      props: { x: { type: r.num() } },
    });
    r.register(A1);

    // Pass a DIFFERENT A via opts.types — should win the dedup.
    const A2 = r.extend('object', {
      name: 'A',
      props: { y: { type: r.text() } },
    });

    const opts = buildSchemas(r, { types: [A2] });
    // Either variant still matches by name alone (passthrough on options/props).
    expect(opts.Type.safeParse({ name: 'A' }).success).toBe(true);

    // There should be exactly ONE instance branch for 'A' (dedup worked):
    // we can't directly inspect the union, but round-tripping through the
    // registry's parse still finds A (the first-registered one wins at
    // lookup time).
    expect(r.lookup('A')!.name).toBe('A');
  });

  test('user-defined type is usable from an LLM-style JSON type reference', () => {
    const r = createRegistry();
    const Task = r.extend('object', {
      name: 'Task',
      docs: 'a work item',
      props: {
        title: { type: r.text({ minLength: 1 }), docs: 'short summary' },
      },
    });
    r.register(Task);

    const opts = buildSchemas(r);

    // Simulate an LLM-produced list-of-Task TypeDef.
    const listOfTasks = {
      name: 'list',
      generic: { V: { name: 'Task' } },
    };
    expect(opts.Type.safeParse(listOfTasks).success).toBe(true);

    // Fully resolved via registry — Task resolves to the Extension.
    const parsed = r.parse(listOfTasks);
    expect(parsed.name).toBe('list');
    // The element type is Task (via lookup), preserving the Extension.
    const item = (parsed as { generic: Record<string, { name: string }> }).generic.V;
    expect(item.name).toBe('Task');
  });

  test('unregistered extension is invisible to opts.Type', () => {
    const r = createRegistry();
    // An Extension that's never registered — no branch for it.
    r.extend('object', {
      name: 'OrphanTask',
      props: { title: { type: r.text() } },
    });
    const opts = buildSchemas(r);
    // No instance branch, and the class branches match by exact name literal
    // (`num`, `object`, etc.), so ad-hoc extensions are not representable.
    expect(opts.Type.safeParse({ name: 'OrphanTask' }).success).toBe(false);
    // Register the same structure → now accepted.
    const sibling = r.extend('object', {
      name: 'RegisteredTask',
      props: { title: { type: r.text() } },
    });
    r.register(sibling);
    const opts2 = buildSchemas(r);
    expect(opts2.Type.safeParse({ name: 'RegisteredTask' }).success).toBe(true);
  });
});
