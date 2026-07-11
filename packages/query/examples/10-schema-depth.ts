/**
 * Example 10 — graduated schema DEPTH.
 *
 * The LLM-facing schema is dialed PER AXIS via `depth` (instead of a binary
 * `strict`): `refs` (field-ref + relation join `on`), `typeNames`, `functions`, and
 * `filters` each tighten independently from `open` (free strings) up to
 * `paired` / `typed`. `maxEnumSize` auto-degrades any axis whose enumeration
 * would blow past a budget.
 *
 * This demo builds the Expr schema at several depths over the example Types +
 * the shipped default function library, and for each prints a compact SHAPE
 * SIGNAL: the resolved per-axis levels, plus whether three deliberately-wrong
 * exprs are accepted or rejected —
 *  - a CROSS-TYPE field-ref (`user.price`; `price` belongs to `product`),
 *  - an UNKNOWN function (`bogus`),
 *  - an UNKNOWN argument name to a real function (`upper({ wrong })`).
 * It asserts nothing; it just illustrates how the knobs change the schema.
 */
import {
  e,
  buildSchemas,
  resolveSchemaDepth,
  type BuildSchemasOptions,
  type ExprDef,
  type QuerySchemas,
} from '../src/index';
import { createExampleFixture } from './schema';
import type { ExampleReport } from './_util';

/** The three probe exprs (each is INVALID under a sufficiently tight depth). */
const CROSS_TYPE_REF: ExprDef = e.ref('user', 'price').toJSON();
const UNKNOWN_FN: ExprDef = e.fn('bogus').toJSON();
const UNKNOWN_ARG: ExprDef = e.fn('upper', { wrong: e.value('x') }).toJSON();

/** `accept` / `reject` for one probe against a built Expr schema. */
function probe(schemas: QuerySchemas, def: ExprDef): string {
  return schemas.Expr.safeParse(def).success ? 'accept' : 'reject';
}

export async function run(): Promise<ExampleReport> {
  const { engine } = createExampleFixture();
  const output: string[] = [];

  // A spread of depths, loosest → tightest, plus a `maxEnumSize` degrade demo.
  const configs: ReadonlyArray<{ label: string; opts: BuildSchemasOptions }> = [
    { label: 'open (all positions free strings)', opts: { depth: 'open' } },
    { label: 'refs=types', opts: { depth: { refs: 'types' } } },
    { label: 'refs=paired', opts: { depth: { refs: 'paired' } } },
    { label: 'functions=names', opts: { depth: { functions: 'names' } } },
    { label: 'functions=typed', opts: { depth: { functions: 'typed' } } },
    { label: 'paired (all axes locked)', opts: { depth: 'paired' } },
    {
      label: 'functions=typed + maxEnumSize=3 (20 scalars > 3 ⇒ degrades to open)',
      opts: { depth: { functions: 'typed' }, maxEnumSize: 3 },
    },
  ];

  for (const { label, opts } of configs) {
    const schemas = buildSchemas(engine, opts);
    const d = resolveSchemaDepth(engine, opts);
    output.push(`- ${label}`);
    output.push(`    resolved: refs=${d.refs} typeNames=${d.typeNames} functions=${d.functions} filters=${d.filters}`);
    output.push(`    cross-type field-ref user.price: ${probe(schemas, CROSS_TYPE_REF)}`);
    output.push(`    unknown function bogus():        ${probe(schemas, UNKNOWN_FN)}`);
    output.push(`    unknown arg upper({ wrong }):    ${probe(schemas, UNKNOWN_ARG)}`);
  }

  // A demo never has UNEXPECTED errors — the rejections above are the point.
  return { title: 'Schema depth — per-axis tightness + maxEnumSize degrade', output, errors: 0 };
}
