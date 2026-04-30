import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';

/**
 * Self-referential types (tree `Node` with `children: Node[]`) and mutual
 * cycles (`Task.creator: User` + `User.tasks: list<Task>`) are expressible
 * via `r.alias(name)` — RefType resolves lazily through the registry, so
 * cross-references don't need the target to exist at construction time.
 *
 * These tests pin the behavior end-to-end: construction, rendering,
 * JSON round-trip, cross-registry re-parse, and value parsing through
 * the recursive structure.
 */
describe('recursive types', () => {
  test('self-reference: Node with optional children list', () => {
    const r = createRegistry();
    const Node = r.extend('object', {
      name: 'Node',
      props: {
        value:    { type: r.num() },
        children: { type: r.optional(r.list(r.alias('Node'))) },
      },
    });
    r.register(Node);

    // toCode / toCodeDefinition shouldn't recurse infinitely.
    expect(Node.toCode()).toBe('Node');
    const def = Node.toCodeDefinition();
    expect(def).toContain('type Node extends obj');
    expect(def).toContain('value: num');
    expect(def).toContain('children?: list<Node>');
  });

  test('self-reference: parse a nested value through the ref', () => {
    const r = createRegistry();
    const Node = r.extend('object', {
      name: 'Node',
      props: {
        value:    { type: r.num() },
        children: { type: r.optional(r.list(r.alias('Node'))) },
      },
    });
    r.register(Node);

    // Two levels of nesting exercises the lazy resolve at parse time.
    const parsed = Node.parse({
      value: 1,
      children: [
        { value: 2, children: [] },
        { value: 3 },
      ],
    });
    expect(parsed.type).toBe(Node);
    // The raw carries Value wrappers; just verify the structure is an obj.
    expect(typeof parsed.raw).toBe('object');
    expect(parsed.raw).not.toBeNull();
  });

  test('self-reference: JSON serializes the ref by NAME, not expanded', () => {
    const r = createRegistry();
    const Node = r.extend('object', {
      name: 'Node',
      props: {
        value:    { type: r.num() },
        children: { type: r.optional(r.list(r.alias('Node'))) },
      },
    });
    r.register(Node);

    const json = JSON.stringify(Node.toJSON());
    // The self-reference uses the bare-name shape `{"name":"Node"}` —
    // emitted exactly twice in the props tree: once as the outer
    // type's `name` (the Node type itself) and once as the inner ref
    // inside `children`'s list. No recursive explosion (would be 100s
    // if Node's props were re-inlined inside its own children).
    const matches = json.match(/"name":"Node"/g) ?? [];
    expect(matches.length).toBe(2);
  });

  test('mutual cycle: Task ↔ User', () => {
    const r = createRegistry();
    const Task = r.extend('object', {
      name: 'Task',
      props: {
        title:   { type: r.text({ minLength: 1 }) },
        creator: { type: r.alias('User') },
      },
    });
    r.register(Task);

    const User = r.extend('object', {
      name: 'User',
      props: {
        name:  { type: r.text() },
        tasks: { type: r.list(r.alias('Task')) },
      },
    });
    r.register(User);

    expect(Task.toCode()).toBe('Task');
    expect(User.toCode()).toBe('User');

    const taskDef = Task.toCodeDefinition();
    expect(taskDef).toContain('creator: User');
    const userDef = User.toCodeDefinition();
    expect(userDef).toContain('tasks: list<Task>');
  });

  test('mutual cycle: round-trips through JSON into a fresh registry', () => {
    const r = createRegistry();
    const Task = r.extend('object', {
      name: 'Task',
      props: {
        title:   { type: r.text() },
        creator: { type: r.alias('User') },
      },
    });
    r.register(Task);
    const User = r.extend('object', {
      name: 'User',
      props: {
        name:  { type: r.text() },
        tasks: { type: r.list(r.alias('Task')) },
      },
    });
    r.register(User);

    const r2 = createRegistry();
    // Order matters only for types referenced BEFORE registration;
    // RefType is lazy, so either order works.
    r2.register(r2.parse(Task.toJSON()));
    r2.register(r2.parse(User.toJSON()));

    const Task2 = r2.parse({ name: 'Task' });
    expect(Task2.toCodeDefinition()).toContain('creator: User');

    const User2 = r2.parse({ name: 'User' });
    expect(User2.toCodeDefinition()).toContain('tasks: list<Task>');
  });

  test('ref to an unregistered name resolves lazily — placeholder semantics', () => {
    const r = createRegistry();
    const ref = r.alias('DoesNotExist');
    // Construction + toJSON don't touch resolve().
    expect(ref.toCode()).toBe('DoesNotExist');
    // Bare-name JSON form — no `ref` wrapper.
    expect(ref.toJSON().name).toBe('DoesNotExist');
    // Unresolved alias acts as a permissive placeholder (matches the
    // unbound-generic behavior). Once `DoesNotExist` is registered,
    // future calls would delegate to that target.
    expect(ref.valid({})).toBe(true);
    expect(ref.compatible(r.num())).toBe(true);
  });
});
