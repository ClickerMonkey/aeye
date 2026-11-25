/**
 * dump-schema.ts — build a full `{ expr, type }` schema (`GinGrammar`) with a
 * mix of Extension examples over the built-in types, render it as core sends
 * it to an OpenAI strict model, and write the result to `schema-dump.json` (gitignored).
 *
 * Run with:  npm run dump-schema
 *
 * Edit the `registerExamples` block below to play with different types,
 * constraints, docs, or options — the output is a plain JSON Schema
 * suitable for eyeballing, diffing, or feeding to a JSON-schema viewer.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { a, OPENAI_STRICT } from '@aeye/schema';
import { createRegistry, GinGrammar, type Registry } from '../src/index';

const __dirname = dirname(fileURLToPath(import.meta.url));

function registerExamples(r: Registry): void {
  // ── primitives ────────────────────────────────────────────────────────
  r.register(r.extend('num', {
    name: 'Positive',
    docs: 'a number greater than zero',
    options: { min: 0 },
  }));

  r.register(r.extend('num', {
    name: 'Percent',
    docs: 'a whole number between 0 and 100',
    options: { min: 0, max: 100, whole: true },
  }));

  r.register(r.extend('text', {
    name: 'Email',
    docs: 'RFC-ish email address',
    options: { pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
  }));

  r.register(r.extend('text', {
    name: 'NonEmpty',
    docs: 'any non-empty string',
    options: { minLength: 1 },
  }));

  // ── composites ────────────────────────────────────────────────────────
  r.register(r.extend('object', {
    name: 'Task',
    docs: 'a to-do item',
    props: {
      title: { type: r.text({ minLength: 1 }), docs: 'short headline' },
      done:  { type: r.bool(),                 docs: 'completed?' },
      due:   { type: r.optional(r.date()),     docs: 'optional deadline' },
    },
  }));

  r.register(r.extend('object', {
    name: 'User',
    docs: 'a registered account',
    props: {
      id:    { type: r.parse({ name: 'Email' }), docs: 'primary key' },
      name:  { type: r.parse({ name: 'NonEmpty' }) },
      tasks: { type: r.list(r.parse({ name: 'Task' })), docs: 'everything assigned' },
    },
  }));

  // Named tuple — cross-extending the anonymous tuple class.
  r.register(r.extend(r.tuple([r.text(), r.num()]), {
    name: 'Pair',
    docs: 'a (label, value) pair',
  }));

  // Named map with specific K/V.
  r.register(r.extend(r.map(r.text(), r.num()), {
    name: 'Scores',
    docs: 'named numeric scores',
  }));

  // Named enum — cross-extend an inline enum instance (same pattern as
  // the named tuple above; the bare `enum` class has no values to widen
  // against, so going through an instance sidesteps `narrow`).
  r.register(r.extend(
    r.enum({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' }, r.text()),
    { name: 'Priority', docs: 'work-item urgency' },
  ));
}

function main(): void {
  const r = createRegistry();
  registerExamples(r);

  // The schema the user asked for: a program and a type, from gin's grammar, as OpenAI strict sees it.
  const topLevel = GinGrammar.result(a.object({ expr: a.ref('Expr'), type: a.ref('TypeDef') }));
  const jsonSchema = topLevel.bind(r, { newStrict: true }).render(OPENAI_STRICT).jsonSchema;

  const out = resolve(__dirname, '..', 'schema-dump.json');
  writeFileSync(out, JSON.stringify(jsonSchema, null, 2) + '\n');

  // Tiny summary so the run is visible.
  const named = r.namedTypeList().map((t) => t.name);
  console.log(`✓ wrote ${out}`);
  console.log(`  registered types: ${named.join(', ')}`);
  console.log(`  schema size:      ${JSON.stringify(jsonSchema).length.toLocaleString()} chars`);
}

main();
