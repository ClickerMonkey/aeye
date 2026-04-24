/**
 * dump-code.ts — register a mix of Extension examples (same set as
 * dump-schema) and write each type's `toCode()` output to
 * `code-dump.txt` (gitignored). Handy for eyeballing how docs,
 * options, and nested composites render as TS-ish code.
 *
 * Run with:  npm run dump-code
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry, type Registry } from '../src/index';
import type { Type } from '../src/type';

const __dirname = dirname(fileURLToPath(import.meta.url));

function registerExamples(r: Registry): Type[] {
  const add = (t: Type): Type => { r.register(t); return t; };

  // ── primitives ────────────────────────────────────────────────────────
  const Positive = add(r.extend('num', {
    name: 'Positive',
    docs: 'a number greater than zero',
    options: { min: 0 },
  }));
  const Percent = add(r.extend('num', {
    name: 'Percent',
    docs: 'a whole number between 0 and 100',
    options: { min: 0, max: 100, whole: true },
  }));
  const Email = add(r.extend('text', {
    name: 'Email',
    docs: 'RFC-ish email address',
    options: { pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
  }));
  const NonEmpty = add(r.extend('text', {
    name: 'NonEmpty',
    docs: 'any non-empty string',
    options: { minLength: 1 },
  }));

  // ── composites ────────────────────────────────────────────────────────
  const Task = add(r.extend('object', {
    name: 'Task',
    docs: 'a to-do item',
    props: {
      title: { type: r.text({ minLength: 1 }), docs: 'short headline' },
      done:  { type: r.bool(),                 docs: 'completed?' },
      due:   { type: r.optional(r.date()),     docs: 'optional deadline' },
    },
    init: {
      docs: 'create a Task with just a title; due is optional',
      args: r.obj({
        title: { type: r.text({ minLength: 1 }) },
        due:   { type: r.optional(r.date()) },
      }),
      run: { kind: 'native', id: 'task.init' },
    },
  }));
  const User = add(r.extend('object', {
    name: 'User',
    docs: 'a registered account',
    props: {
      id:    { type: r.parse({ name: 'Email' }),        docs: 'primary key' },
      name:  { type: r.parse({ name: 'NonEmpty' }) },
      tasks: { type: r.list(r.parse({ name: 'Task' })), docs: 'everything assigned' },
    },
  }));
  const Pair = add(r.extend(r.tuple([r.text(), r.num()]), {
    name: 'Pair',
    docs: 'a (label, value) pair',
  }));
  const Scores = add(r.extend(r.map(r.text(), r.num()), {
    name: 'Scores',
    docs: 'named numeric scores',
  }));
  const Priority = add(r.extend(
    r.enum({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' }, r.text()),
    { name: 'Priority', docs: 'work-item urgency' },
  ));

  // Generic interface — Addable<T> with an `add(other: T): T` method.
  const Addable = add(r.extend('interface', {
    name: 'Addable',
    docs: 'a type that supports addition with another T',
    generic: { T: r.any() },
    props: {
      add: {
        type: r.fn(r.obj({ other: { type: r.generic('T') } }), r.generic('T')),
        docs: 'combine with another value',
      },
    },
  }));

  // Non-generic interface — Named with `name: text`.
  const Named = add(r.extend('interface', {
    name: 'Named',
    docs: 'anything with a display name',
    props: {
      name: { type: r.text({ minLength: 1 }), docs: 'human-readable label' },
    },
  }));

  return [Positive, Percent, Email, NonEmpty, Task, User, Pair, Scores, Priority, Addable, Named];
}

function main(): void {
  const r = createRegistry();
  const named = registerExamples(r);

  const sections: string[] = [];

  // ── Built-in type classes (anonymous, default instances) ──────────────
  const builtinLines: string[] = [];
  for (const cls of r.typeClasses()) {
    let inst: Type;
    try {
      inst = cls.from({ name: cls.NAME }, r);
    } catch {
      continue; // skip classes whose default construction needs args (e.g. tuple)
    }
    builtinLines.push(`  ${cls.NAME.padEnd(11)} → ${inst.toCode()}`);
  }
  sections.push(`# Built-in type classes\n${builtinLines.join('\n')}`);

  // ── A few anonymous narrow instances ──────────────────────────────────
  const narrowInstances: Array<[string, Type]> = [
    ['num({min:0,max:100,whole:true})',  r.num({ min: 0, max: 100, whole: true })],
    ['text({minLength:1})',              r.text({ minLength: 1 })],
    ['list(num())',                      r.list(r.num())],
    ['map(text(), num())',               r.map(r.text(), r.num())],
    ['tuple([text, num, bool])',         r.tuple([r.text(), r.num(), r.bool()])],
    ['optional(text())',                 r.optional(r.text())],
    ['nullable(num())',                  r.nullable(r.num())],
    ['or([num, text])',                  r.or([r.num(), r.text()])],
    ['obj({name, age})',                 r.obj({
                                           name: { type: r.text({ minLength: 1 }), docs: 'user handle' },
                                           age:  { type: r.num({ whole: true, min: 0 }) },
                                         })],
    ['fn((args) => text)',               r.fn(r.obj({ who: { type: r.text() } }), r.text())],
  ];
  const narrowLines = narrowInstances.map(([label, t]) =>
    `  ${label.padEnd(34)} → ${t.toCode()}`);
  sections.push(`# Anonymous narrow instances\n${narrowLines.join('\n')}`);

  // ── Registered named types (Extensions) ───────────────────────────────
  const namedLines = named.map((t) => `  ${t.name.padEnd(10)} → ${t.toCode()}`);
  sections.push(`# Registered named types\n${namedLines.join('\n')}`);

  // ── Nested composites using named types ───────────────────────────────
  const Email = r.parse({ name: 'Email' });
  const Task  = r.parse({ name: 'Task' });
  const nested: Array<[string, Type]> = [
    ['list(Email)',           r.list(Email)],
    ['list(Task)',            r.list(Task)],
    ['map(Email, Task)',      r.map(Email, Task)],
    ['optional(Task)',        r.optional(Task)],
    ['obj with Email field',  r.obj({
                                 owner:  { type: Email, docs: 'who owns this' },
                                 task:   { type: Task },
                               })],
  ];
  const nestedLines = nested.map(([label, t]) =>
    `  ${label.padEnd(24)} → ${t.toCode()}`);
  sections.push(`# Nested composites using named types\n${nestedLines.join('\n')}`);

  // ── Full type definitions (toCodeDefinition) ─────────────────────────
  // For generic classes, construct the "class-level" instance with generic
  // PARAMETER placeholders (V, K, T, …) so the rendered body shows `V`
  // instead of the default-fallback `any`.
  const genericDefaults: Record<string, () => Type> = {
    list:     () => r.list(r.generic('V')),
    map:      () => r.map(r.generic('K'), r.generic('V')),
    optional: () => r.optional(r.generic('T')),
    nullable: () => r.nullable(r.generic('T')),
    not:      () => r.not(r.generic('T')),
    fn:       () => r.fn(r.generic('Args'), r.generic('Returns')),
  };
  const defs: Array<[string, Type]> = [];
  for (const cls of r.typeClasses()) {
    const custom = genericDefaults[cls.NAME];
    try {
      defs.push([cls.NAME, custom ? custom() : cls.from({ name: cls.NAME }, r)]);
    } catch {
      // skip classes whose default construction needs args
    }
  }
  for (const t of named) defs.push([t.name, t]);
  const defBlocks = defs.flatMap(([label, t]) => {
    try {
      return [t.toCodeDefinition()];
    } catch (err) {
      return [`// ${label}: could not render (${(err as Error).message})`];
    }
  });
  sections.push(`# Type definitions (toCodeDefinition)\n\n${defBlocks.join('\n\n')}`);

  const out = resolve(__dirname, '..', 'code-dump.txt');
  writeFileSync(out, sections.join('\n\n') + '\n');

  console.log(`✓ wrote ${out}`);
  console.log(`  registered types: ${r.namedTypeList().map((t) => t.name).join(', ')}`);
}

main();
