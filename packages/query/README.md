# @aeye/query

An **LLM-friendly relational query language**, in-memory runtime, and SQL
converter. You define *Types* (type-like entities) with *Fields*; from that an
LLM (or a developer) can build a **typed, validated, runnable** query — a
`select` / `insert` / `update` / `delete` / set-operation / CTE / single
expression. A built query resolves to an output type, has typed bind params,
can be cost-bounded, run in-memory, converted to SQL (base + Postgres),
auto-paginated, and **drilled down** (aggregate un-ravelling).

It is fully standalone (only depends on `zod`) and obsessively type-safe: no
`any`, no `unknown` in public APIs, no casts; every polymorphic node is a
discriminated union so handling is exhaustively checkable.

```bash
npm install        # from the monorepo root (workspace)
npm run typecheck  # tsc --noEmit
npm test           # vitest
npm run examples   # runnable, end-to-end tour (examples/)
```

## The type / field model

A `Type` is a named collection of `Field`s plus index + cardinality estimates.
Each field has a `FieldType` (one of `number`, `text`, `money`, `bool`,
`relation`, `date`, `timestamp`, `json`, `array`); nullability lives on the
*field*, not the field type.

An `array` field is an ordered collection. It carries optional `minItems` /
`maxItems` element-count bounds and an optional `item` element field type
(omit `item` for heterogeneous / unknown elements). Because `item` is itself a
field type, arrays nest (`array<array<number>>`). `inferType` detects arrays
from sampled rows and infers the element type from homogeneous scalars.

```ts
// array of text tags, 0–8 items
{ name: 'tags', type: { kind: 'array', item: { kind: 'text' }, maxItems: 8 }, nullable: true }
```

Relations carry a target Type and a cardinality `count`: a relation field's
**name is the join key** for all purposes — `count === 1` is belongs-to (the FK
lives on this type), `count > 1` is has-many. There are no explicit FK fields.
A belongs-to relation may set `inverseRelation` to have its target Type
automatically gain the matching has-many field pointing back. The join key on
either side resolves through each Type's *identity field* (the field of its
first unique single-field index, else the field named `id`).

Indexes are **composite**: an ordered list of parts, each with a prefix
distinct-row `count` (non-increasing); the index is unique iff its last part's
`count === 1`. Text matching is **case-insensitive by default** — set a text
field's `sensitive: true` for case-sensitive matching. A Type may also be
flagged `semantic` / `search` to make it eligible for embedding similarity /
full-text search even when no individual field is flagged.

```ts
import { createRegistry, QueryEngine, arrayExecutor, type TypeDef } from '@aeye/query';

const userDef: TypeDef = {
  name: 'user',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
    { name: 'age', type: { kind: 'number', whole: true }, nullable: true },
  ],
  // unique single-field index on `id` ⇒ `id` is the identity / join key.
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, count: 1 }] }],
  count: 1000,
  bytes: 64,
};

const orderDef: TypeDef = {
  name: 'order',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    // belongs-to user; materializes `user.orders` (has-many) pointing back.
    { name: 'userId', type: { kind: 'relation', to: 'user', count: 1, inverseRelation: 'orders' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, count: 1 }] }],
  count: 5000,
  bytes: 48,
};

const registry = createRegistry();
const user = registry.parseType(userDef);
const order = registry.parseType(orderDef);
registry.registerType(user);
registry.registerType(order);

const engine = new QueryEngine(registry, {
  executors: { user: arrayExecutor(userRows) }, // wire data for in-memory runs
});
```

You can also **infer** a `TypeDef` straight from raw JSON rows:

```ts
import { inferType } from '@aeye/query';
const def = inferType('user', userRows); // field types + nullability inferred
```

## Build, validate, and run a query

A query is plain JSON (a `QueryDef`). Validate it to get LLM-friendly
`Problems`, then run it in-memory.

```ts
const select = {
  kind: 'select',
  fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
  from: { kind: 'type', type: 'user' },
  where: [{
    kind: 'comparison', op: '>',
    left: { kind: 'field-ref', source: 'user', field: 'age' },
    right: { kind: 'literal', value: 30 },
  }],
} as const;

const problems = engine.validateQuery(select);   // structure + params + per-Type hooks
if (!problems.hasErrors) {
  const result = await engine.run(select);        // { rows, fields, outputType }
}
```

### Sources & aliasing

Every source is referenced by its **type name** — there is no alias to invent or
keep in sync:

- **FROM.** `from: { kind: 'type', type: 'user' }` binds under `source: 'user'`.
- **Joins.** A join crosses a **single relation field** — `on` is a
  `{ source, field }` ref (`{ on: { source: 'user', field: 'orders' } }`): the
  bound source to join FROM plus its relation field. The joined rows bind under
  the **target type name**, so field-refs into them use `source: 'order'`.
  **Multi-hop** joins are expressed as **chained** single-hop joins (and the
  `relation-path` expr still covers multi-hop value access). The join key is
  synthesized from the relation — you never write ON. `joinType` (renamed from
  `type`, freeing that key for the Type-name rule) defaults to `left`.
- **DML.** `update` / `delete` / `insert` target a type by name (`type` / `from`
  / `into`) and bind it under that name — DML targets take no alias.

When you need a distinct binding — a **self-join**, or **two instances of the
same Type** — reach for the `aliased` escape hatch on a FROM source
(`{ kind: 'aliased', type: 'user', as: 'u1' }`) or set `as` on a join to override
the bound name of its hop (`{ on: { source: 'u1', field: 'orders' }, as: 'o1' }`).
The `as` on a join is the **collision-breaker**.

> **The `type` vs `source` rule.** `type` is used only where the value MUST be a
> registered Type name (FROM `type`, DML `into` / `type` / `from`, relation `to`,
> a semantic query's `{ type, field }`); `source` is a **bound** name in the
> query's scope (a Type name, a join alias, a CTE, an aliased source) — used by
> `field-ref`, `semantic` / `text-search` / `filters`, and a join's `on.source`.

If two sources end up bound under the same name — two joins landing on one target
type, or a join hop rebinding the FROM / DML target type — the engine reports a
`source.duplicate` validation error pointing you at the `aliased` form (or a join
`as`) to disambiguate.

> **Known limitation.** A self-referential DML that would need two instances of
> its target type (e.g. an `UPDATE user` joined back to `user` via its relations,
> whose hop rebinds `user`) currently errors with `source.duplicate`; an
> aliased-DML target mechanism is a deferred follow-up.

## Execution model

There is ONE execution contract: **run a query, optionally with param values
and filters, and get back `{ rows, fields, total }`**.

```ts
const result = await engine.run(query, { params, filters, includeTotal });
//   result.rows   — the output rows (objects; pass { rows: 'array' } for arrays)
//   result.fields — resolved output fields (name + type + summary metadata)
//   result.total  — pre-limit row count, when run with `includeTotal: true`
```

Everything composes around that one call:

- **Params.** A `param` (`{ kind: 'param', name }`) infers its type from how it
  is used and is bound at run time via `options.params`. Introspect what a built
  query expects with `query.params(engine)` → `ParamDef[]` (name + inferred
  type).
- **Filters.** `options.filters` is a `Record<source, ExprDef | Expr | null>` —
  a single **boolean Expr** per source (or `null` / absent for none). The
  `filters` EXPR in the query is only a placeholder (`{ source, fields? }`); the
  predicate is supplied here, keyed by source, and the placeholder evaluates /
  emits it (vacuously `TRUE` when none is supplied). A filter-builder UI that
  collects `{ field, op, value }` clauses turns them into that bool Expr with
  `compileFilters(source, clauses, registry)` — which validates each clause
  against the source's Type (and the `fields` allowlist + each field type's op
  catalog) and AND-combines them. `query.filterSources()` lists the sources a
  filter may target; an unknown source / field, a disallowed field, or an
  invalid op is a `QueryTypeError`.
- **Total count.** `includeTotal: true` is an **execution-time** option (NOT a
  `SelectDef` field): `run` captures the pre-limit count into `result.total`,
  and `toSQL(query, dialect, { includeTotal: true })` emits
  `COUNT(*) OVER () AS "$total"`.
- **Pagination.** `autoPaginate` adds `limit` / `offset` as bind PARAMS, so
  pagination is just supplying their values:

  ```ts
  import { autoPaginate } from '@aeye/query';
  const paged = autoPaginate(select); // adds { limit: param('limit'), offset: param('offset') }
  paged.params(engine);               // → [{ name:'limit', type:{kind:'number'} }, { name:'offset', … }]
  await engine.run(paged, { params: { limit: 10, offset: 0 } });
  ```

- **Drill-down.** `drillDownInto` rebuilds the underlying-rows query and extracts
  the drill PARAMS from a chosen aggregated row — then it is the same `run` call
  with those params (see [Drill-down](#drill-down)).

`toSQL` accepts the same `params` and `filters` options and emits them
identically, so emitted SQL matches what would run.

## SQL conversion

The same query emits SQL for any registered dialect. The base dialect uses `?`
placeholders; Postgres uses `$1`, `$2`, … . Relation joins synthesize their ON
clause from the relation key — you never write it.

```ts
const base = engine.toSQL(select, 'base');         // { sql, params }
const pg   = engine.toSQL(select, 'postgres', { params: { minTotal: 50 } });
```

## Type backing & Access / Computed

The conceptual model the LLM sees — a `TypeDef`'s flat list of fields — can be
**arbitrarily richer behind the scenes**. A `TypeBacking` is plain dev-side
TypeScript you register *alongside* the Type (`registry.registerType(type,
backing)`, or `new QueryEngine(registry, { backings })`); the JSON `TypeDef` /
`FieldDef` are **never touched**, so the schema stays minimal. A backing can
remap the real source table, compute fields, auto-join other Types, and gate
rows / fields — all resolved IDENTICALLY in `engine.run` and `engine.toSQL`.

Two primitives compose everything. Each offers a dual `expr` path plus per-mode
overrides — **SQL** resolves `sql` then `expr`; the **runtime** resolves `run`
then `expr`:

- **`Access`** — a security *predicate*. It resolves to a predicate `Expr`
  (apply it), `true` (visible), `false` (denied), or `undefined` (no-op).
- **`Computed`** — a field *value* producer (replaces the stored column). It
  always yields a value.

```ts
const backing: TypeBacking = {
  name: 'projects',                       // real table ⇒ FROM "projects" AS "project"
  access: { /* RLS — see below */ },
  joins: { /* named hidden joins — see below */ },
  fields: { /* per-field compute / access / remap */ },
};
registry.registerType(project, backing);  // the TypeDef the LLM sees is unchanged
```

`examples/11-computed-fields.ts` is the end-to-end demo: one simple `project`
Type backed by `projects` + `users` + `tasks`, run in-memory AND emitted to SQL.

## Computed fields

A `FieldBacking.compute` supplies a field's value. The primary path is a dual
`expr` (one `Expr` both emitted to SQL and evaluated in memory); `sql` / `run`
override per mode. A bare `name` just remaps the stored column.

```ts
fields: {
  // dual expr: the auto-joined owner's name (one definition, both modes).
  ownerName: { joins: ['owner'], compute: { expr: () => registry.parseExpr(
    { kind: 'field-ref', source: joinAlias('project', 'owner'), field: 'name' }) } },

  // per-mode override: format money in SQL one way, in memory another.
  budgetLabel: { compute: {
    sql: (alias, ctx) => SqlText.concat([SqlText.raw("'$' || "), ctx.dialect.field(alias, 'budget')]),
    run: (row) => Value.of(`$${row['project']?.['budget'] ?? 0}`),
  } },

  legacyNote: { name: 'note' },           // remap: read the stored `note` column
}
```

Compute / access exprs that reach into other sources flow through the join
planner, so two fields reading the **same** auto-join collapse to ONE join.

## RLS & FLS

Same `Access` primitive, two scopes — both apply in `run` AND `toSQL`:

- **RLS** (`TypeBacking.access`) — a row filter for every occurrence of the
  Type. A predicate is ANDed into the SQL `WHERE` and filters executor rows on
  load; `false` ⇒ no rows (`WHERE FALSE`); `true` / `undefined` ⇒ no filter.
  Combines (AND) with any `RlsProvider` passed to `run` / `toSQL`.
- **FLS** (`FieldBacking.access`) — a per-field gate. A predicate emits
  `CASE WHEN <pred> THEN <value> ELSE NULL END` (nulled in memory when false);
  `false` ⇒ a constant `NULL`; `true` / `undefined` ⇒ the plain value.

```ts
// RLS: only the current org's rows (orgId is NOT a conceptual field — pure backing).
access: { expr: () => registry.parseExpr(
  { kind: 'comparison', op: '=', left: ref('project', 'orgId'), right: lit(currentOrg) }) },

// FLS: `secretField` is visible only for active projects, reading stored `secret`.
secretField: { name: 'secret', access: { expr: () => registry.parseExpr(
  { kind: 'comparison', op: '=', left: ref('project', 'status'), right: lit('active') }) } },
```

## Named joins & LATERAL

`TypeBacking.joins` declares **named, hidden** joins; a field opts in via
`FieldBacking.joins: [name]`. Each join is added to a query **once, only if a
referencing field is emitted**, and deduped by name — so N fields sharing one
join collapse to a single planned join (its alias is `joinAlias(source, name)`).
A `JoinSpec` is either a `relation` (reuses the shared relation-join machinery)
or a `lateral` (a correlated sub-select):

```ts
joins: {
  // a belongs-to relation auto-join (shared by every field reading the owner).
  owner: { expr: (alias) => ({ kind: 'relation', source: alias, relation: 'owner' }) },

  // a LATERAL aggregate over a has-many — `taskCount` + `totalHours` share it.
  taskStats: { expr: () => ({ kind: 'lateral', joinType: 'left',
    query: (outer) => ({ kind: 'select',
      fields: [
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'cnt' },
        { expr: { kind: 'aggregate', function: 'sum', args: { value: ref('task', 'hours') } }, as: 'hrs' },
      ],
      from: { kind: 'type', type: 'task' },
      where: [cmp('=', ref('task', 'projectId'), ref(outer, 'id'))] }) }) },
}
```

A `lateral`'s `pick` names the column a no-`compute` field defaults to. Postgres
emits `LEFT JOIN LATERAL (…) ON true`; the portable base dialect degrades to
`LEFT JOIN LATERAL (…) ON 1 = 1` (a documented correlated-subquery fallback) and
the runtime evaluates the sub-select per outer row.

## Filters and params

A `filters` expression is an **LLM-opaque placeholder** bound to a source, with
an optional `fields` allowlist — `{ kind: 'filters', source, fields? }`. The LLM
never authors the predicate. At **execution time** the developer supplies a
single **boolean `Expr`** per source (keyed by source); the placeholder
evaluates / emits it, vacuously `TRUE` when none is supplied. A filter-builder
UI that collects `{ field, op, value }` clauses turns them into that bool Expr
with `compileFilters` — each field type exposes its own operator catalog
(numbers get `gte`/`between`, text gets `contains`/`startsWith`, …) and the
clauses AND-combine.

```ts
import { compileFilters } from '@aeye/query';

// In the query: just a placeholder + an allowlist (no predicate).
where: [{ kind: 'filters', source: 'product', fields: ['category', 'price'] }]

// At run time: compile the clauses to ONE bool Expr (validated against the
// `fields` allowlist + each field type's op catalog), keyed by source.
const productFilter = compileFilters(
  'product',
  [
    { field: 'category', op: 'eq', value: 'hardware' },
    { field: 'price', op: 'gte', value: 30 },
  ],
  engine.registry,
);
await engine.run(select, { filters: { product: productFilter } });
```

## Semantic & text search

Both are bound to a **source** with an OPTIONAL `field` (omit to target the
whole source):

- **`semantic`** — `{ kind: 'semantic', source, field?, query }` scores a row's
  embedding against `query`, which is a literal string, a `param`, or a
  `{ type, field }` ref to ANOTHER semantic Type+field (whose embedding becomes
  the query vector). The source/field must be semantic-eligible (a Type flagged
  `semantic`, or a `semantic`/`search` text field). Requires an embedder.
- **`text-search`** — `{ kind: 'text-search', source, field?, query }` is a
  full-text predicate; `query` is a literal string or a `param`. Whole-source
  search needs a searchable Type; a narrowed `field` must be a text field.

```ts
{ kind: 'semantic', source: 'doc', field: 'body', query: 'quarterly revenue' }
{ kind: 'semantic', source: 'doc', query: { type: 'doc', field: 'title' } }
{ kind: 'text-search', source: 'user', field: 'email', query: 'ada' }
```

In the LLM schema these participate in **depth** like field-refs: at `paired`
the `source` is a Type and the `field` enum is restricted to that Type's
semantic / text fields.

### Array fields and operations

An `array` field's catalog is: `contains` (a single element is present),
`containsAny` / `containsAll` (overlap / superset against an element list),
`isEmpty` / `notEmpty`, the length filters `lengthEq` / `lengthGt` /
`lengthGte` / `lengthLt` / `lengthLte`, and `isNull` / `notNull`. The
containment family compiles to the `array-op` predicate expression; the length
family compiles to a `comparison` over the builtin `arrayLength(field)` scalar
function; emptiness reduces to a length test. (When the element type is a
non-`sensitive` text type, element matching is case-insensitive, like text.)

```ts
// In the query: an array-aware filters placeholder over `tags`…
where: [{ kind: 'filters', source: 'user', fields: ['tags'] }]
// …and at run time, compile the array clauses (contains + length) to one Expr:
const tagFilter = compileFilters(
  'user',
  [
    { field: 'tags', op: 'contains', value: 'beta' },
    { field: 'tags', op: 'lengthGte', value: 2 },
  ],
  engine.registry,
);
await engine.run(select, { filters: { user: tagFilter } });

// the underlying predicate, written directly:
{ kind: 'array-op', op: 'containsAny', target: { kind: 'field-ref', source: 'user', field: 'tags' },
  value: [{ kind: 'literal', value: 'admin' }, { kind: 'literal', value: 'beta' }] }
```

**Dialect support.** Array operations are **Postgres-native**: `contains` →
`value = ANY(col)`, `containsAll` → `col @> ARRAY[…]`, `containsAny` →
`col && ARRAY[…]`, and length → `cardinality(col)`. The portable **base (ANSI)
dialect has no array operators**, so containment (`contains` / `containsAny` /
`containsAll`) throws a clear `QueryTypeError` (`array-op.unsupported-dialect`)
rather than emit wrong SQL; emptiness and the length filters still work there
via `COALESCE(json_array_length(col), 0)`.

A `param` (`{ kind: 'param', name }`) infers its type from how it is used and
is bound at run/emit time. A filter predicate is likewise supplied at EXECUTION
time via `engine.run(query, { filters: { <source>: boolExpr } })` — the
placeholder evaluates it dynamically against the bound source (see
[Execution model](#execution-model)). `autoPaginate` turns a query into a
reusable, paged artifact by binding `limit` / `offset` to params (idempotently):

```ts
import { autoPaginate } from '@aeye/query';
const paged = autoPaginate(select);   // adds { limit: param('limit'), offset: param('offset') }
await engine.run(paged, { params: { limit: 10, offset: 0 } });
```

## CTEs

A `WITH` statement (`{ kind: 'cte', ctes, final }`) carries a list of named CTE
entries consumed by a `final` query. An entry is one of two **distinct** shapes,
structurally discriminated:

- **Non-recursive** — `{ name, query }`.
- **Recursive** — `{ name, base, recursive }`: a `base` seed query UNION-ed with
  a `recursive` arm that reads the CTE's own accumulating rows until a fixpoint
  (iteration-capped). Recursion is its OWN shape — there is no `recursive?` flag
  on the plain entry.

```ts
{ kind: 'cte',
  ctes: [{ name: 'descendants',
           base:      /* seed select */,
           recursive: /* select that reads `descendants` */ }],
  final: { kind: 'select', from: { kind: 'type', type: 'descendants' }, fields: [/* … */] } }
```

## Drill-down

`drillDown` rebuilds the query that returns the **underlying rows** behind an
aggregate — PARAMETERIZED: each GROUP BY key is pinned to a bind param
(`key = param(name)`), so the drilled query is reusable. It returns the rebuilt
`query`, the `params` (a `DrillParam[]` mapping each output `field` → its
`name`), and any `warnings`.

```ts
import { drillDown, drillDownInto } from '@aeye/query';

// The reusable, parameterized drilled query + its field → param mapping.
const d = drillDown(revenuePerUser, engine);
//   d.params → [{ name:'userId', field:'userId', key: { kind:'field-ref', source:'order', field:'userId' } }]

// Or drill into ONE aggregated row: extract its key values, then it's the same
// run call. (This is the old literal-baking behavior, now param-driven.)
const into = drillDownInto(revenuePerUser, groupRow, engine);
if ('query' in into) {
  const underlying = await engine.run(into.query, { params: into.params }); // that row's orders
}
```

The param NAME is derived from the carrying output field (sanitized to a valid
identifier; suffixed `_2`, `_3`, … on collision with a param the query already
uses). Failure cases (`drill.no-aggregation` / `non-invertible` /
`having-aggregate` / `window-unsupported`) return LLM-friendly `Problems`.

## Cost

Every query has a bottom-up `{ rows, bytes }` estimate driven by Type counts +
indexes. Constraints reject over-budget queries during validation.

```ts
const cost = engine.cost(select);                                   // { rows, bytes }
const problems = engine.validateQuery(select, undefined, { maxRows: 100 });
// → cost.rows-exceeded when the estimate blows past the cap
```

## Functions

All four function shapes are uniform: declare a `FunctionDef` (name, shape,
**named** params, output) with `registerFunction`, then pair it with a
shape-tagged runtime via `registerFunctionRun`. Calls reference the function by
name with **named arguments** (`args: { paramName: <expr> }`):

```ts
// scalar — initials(value: text): text
registry.registerFunction({
  name: 'initials', shape: 'scalar',
  params: [{ name: 'value', type: { kind: 'text' } }],
  output: { kind: 'text' },
});
registry.registerFunctionRun('initials', {
  shape: 'scalar',
  run: (args) => Value.of(args.value.toText().split(/\s+/).map((w) => w[0]).join('')),
});

// reference it by name with NAMED args:
// { kind: 'function-call', function: 'initials', args: { value: <expr> } }
```

The four shapes differ only in what their `run` receives:

| shape       | `run(...)` signature                          | example       |
| ----------- | --------------------------------------------- | ------------- |
| `scalar`    | `(args, ctx)` → one value                     | `upper`       |
| `tabular`   | `(args, ctx)` → rows                          | `rangeRows`   |
| `aggregate` | `(rows, ctx)` → one value over a group        | `sum`, `count`|
| `window`    | `(partition, index, ctx)` → value per row     | `row_number`  |

`count(*)` is the empty-args convention: `{ kind: 'aggregate', function:
'count', args: {} }`. The registry ships a **default library** (~30 functions
across all shapes — `upper`/`concat`/`coalesce`/…, `sum`/`avg`/`min`/`max`/
`count`, `row_number`/`rank`/`lag`/…) registered by `createRegistry()`, so they
are discoverable and runnable out of the box:

```ts
registry.functionList();            // every FunctionDef (default lib + your own)
describeFunctions(engine);          // a promptable, by-shape listing for an LLM
```

## The LLM loop

The `llm/` surface turns the engine into an LLM tool:

```ts
import { selectTypes, buildSchemas, querySchema, buildQueryTool } from '@aeye/query';

// 1. Narrow the schema to the Types a request needs (semantic ranking).
const types = await selectTypes(engine, 'revenue by customer last month');

// 2. Per-axis `depth` Zod schemas (see "Schema depth" below). `'paired'` locks
//    every axis: Type-name positions are enum-locked, field refs are TYPE+FIELD
//    pairs (an `order` source can't be paired with a `user`-only field),
//    relation paths are rooted at a known Type, and function calls are typed.
const schemas = buildSchemas(engine, { depth: 'paired', types });

// 3. Or get the tool-input schema, which falls back to a string description
//    past `max` Types (shouldUseStringSchema). `depth` / `functions` thread
//    straight through to `buildSchemas`.
const schema = querySchema(engine, { types, depth: 'paired' });

// 4. A framework-neutral tool: validate → build a runnable Query → (optionally) run.
//    Its `instructions` reflect the active depth + the selected functions.
const tool = buildQueryTool(engine, { run: true, depth: 'paired' });
const built = await tool.build({ query: someQueryDef });
//   built.query / built.problems / built.report / built.result
```

See `examples/` for an end-to-end, runnable tour of all of the above.

## Schema depth

`buildSchemas` / `querySchema` / `buildQueryTool` constrain the LLM-facing
schema along **four independent axes**, each dialed by `depth`:

| axis        | levels (loose → tight)                       | constrains                               |
| ----------- | -------------------------------------------- | ---------------------------------------- |
| `refs`      | `open` · `types` · `fields` · `both` · `paired` | `field-ref` / `relation-path` source + field |
| `typeNames` | `open` · `enum`                              | bare Type-name positions (`from`, `into`, …) |
| `functions` | `open` · `names` · `typed`                   | function name + named-arg objects        |
| `filters`   | `open` · `paired`                            | the `filters` clause `(field, op)` pairs |

Pass a full `SchemaDepth` object, a partial one (unset axes stay loose), or a
preset string: `'open'` (every axis loose — free strings) and `'paired'` (every
axis tight). The deprecated `strict: true` / `false` are sugar for
`'paired'` / `'open'`.

```ts
buildSchemas(engine, { depth: { refs: 'paired', functions: 'typed' } });
buildSchemas(engine, { depth: 'open' });                 // ≡ strict: false
buildSchemas(engine, { depth: 'paired' });               // ≡ strict: true

// FunctionSelector — which functions appear in the names/typed schema + prompt:
buildSchemas(engine, { depth: { functions: 'names' }, functions: { scalar: ['upper', 'lower'] } });

// maxEnumSize — AUTO-DEGRADE any axis whose enumeration exceeds the budget one
// level looser, so a large catalog never produces an unusable schema:
buildSchemas(engine, { depth: 'paired', maxEnumSize: 50 });
```

`examples/10-schema-depth.ts` prints, per depth, whether a cross-type field-ref
/ unknown function / unknown argument is accepted or rejected.

### Capability gating

INDEPENDENT of depth, the generated `Expr` union **omits any expr kind the
available Types / functions can't use**, so the model is never offered an
unusable construct. A kind appears only when it is applicable:

| kind | available when |
| ---- | -------------- |
| `semantic` | some Type is semantic-eligible (`isSemantic()`) |
| `text-search` | some Type is searchable (`isSearchable()`) |
| `array-op` | some Type has an `array` field |
| `relation-path`, joins | some Type has a relation field |
| `tabular-function-call` | ≥1 selected `tabular` function |
| `aggregate` / `window` / `function-call` | ≥1 selected function of that shape |
| `filters` | some Type has filterable fields |

The always-usable core (literal / param / binary / unary / comparison / logical
/ in / between / is-null / exists / case / `field-ref` / subquery) is never
gated. When no Type has a relation, the `joins` array is gated out of `Select`
too (it accepts only an empty / absent list).

## Interactive CLI

`examples/cli.ts` is a small REPL (in the spirit of `ginny`) that ties the
whole loop together: it loads whatever JSON data lives in a data directory,
infers a `Type` per file, then lets you type a natural-language request and
have an LLM build → (auto-repair) → run a query against the inferred schema.

```bash
npm run cli                 # loads examples/data (users / orders / products)
npm run cli ./path/to/data  # load a custom directory of *.json files
```

Each `*.json` file must hold a **JSON array of objects**. The Type name comes
from the filename: it is **singularized + capitalized** (`users.json`→`User`,
`orders.json`→`Order`, `categories.json`→`Category`). Files that aren't a JSON
array are skipped with a warning.

The REPL needs an AI provider; set one of these (env vars, mirroring ginny):

| Env var              | Provider                                                |
| -------------------- | ------------------------------------------------------- |
| `OPENAI_API_KEY`     | OpenAI                                                  |
| `OPENROUTER_API_KEY` | OpenRouter                                              |
| AWS credentials      | AWS Bedrock (env vars / `aws sso login` / IAM role / …) |
| `QUERY_MODEL`        | *(optional)* pin a specific model id                    |

With no provider configured the CLI prints which env var to set and exits
cleanly (it never crashes). The REPL builds the tool at a tight default depth
(`refs: 'paired'`, `typeNames: 'enum'`, `functions: 'typed'`, `filters:
'paired'`, with a `maxEnumSize` so large catalogs degrade gracefully). REPL
commands: `:types`, `:fns` (list callable functions by shape), `:depth <spec>`
(switch schema tightness at runtime — a preset like `:depth open` / `:depth
paired`, or per-axis `:depth functions=names refs=types`), `:sql` (toggle
emitting base + postgres SQL per query), `:data <dir>` (reload), `:help`,
`:exit`.

```text
@aeye/query CLI — data: .../examples/data

Loaded Types:
  Order (6 fields): id, userId, productId, total, status, createdAt
  Product (4 fields): id, name, price, category
  User (5 fields): id, name, age, email, city

query> users in London ordered by name

2 row(s):
┌─────────┬─────────────────┬──────────┐
│ (index) │ name            │ city     │
├─────────┼─────────────────┼──────────┤
│ 0       │ 'Ada Lovelace'  │ 'London' │
│ 1       │ 'Cleo Nguyen'   │ 'London' │
└─────────┴─────────────────┴──────────┘
fields: name:text, city:text
```

Under the hood each request runs the package's LLM surface: `selectTypes`
narrows the schema when there are many Types, `buildQueryTool(engine).schema`
constrains the model's output, and `buildQueryTool(engine).build(...)`
validates + parses it into a runnable `Query` — surfacing LLM-friendly
`Problems` that drive a single automatic repair round before running.

