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

A relation field can be **compared directly to a value** in `= <> in notIn`,
where the value is an object keyed by the target's **primary key** (single or
composite) — `{ kind: 'comparison', op: '=', left: relRef, right: { kind:
'param', name: 'u' } }` with `:u = { id: 5 }` (a single-key relation also
accepts a bare scalar). A **belongs-to** matches its FK columns; a **has-many**
matches by **membership** — `= value` is a correlated `EXISTS` testing that the
value's key is in the related set (`<>` / `notIn` → `NOT EXISTS`). Two relations
of the same target compare by their FK key (`order.customer = invoice.customer`);
a has-many may not be compared to another relation. Ordering / LIKE on a relation
is rejected — a relation compares by identity, not order.

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

### Building expressions with `e.*`

Hand-writing the raw `ExprDef` JSON above gets verbose fast. The **`e.*`
builder** composes the same trees with terse, fully-typed function calls — and
each `e.*` returns a **real `Expr` instance** (the exact subclass), so it is
strictly more capable than a def factory:

```ts
import { e } from '@aeye/query';

// e.eq(...) is a ComparisonExpr, e.and(...) a LogicalExpr, e.ref(...) a FieldRefExpr, …
const cond = e.and(
  e.eq(e.ref('task', 'done'), e.value(true)),
  e.gt(e.ref('task', 'hours'), e.value(0)),
);
```

There is **one builder per expression kind**, grouped as: leaves (`value`/`lit`,
`param`, `ref`, `path`, `output`, `excluded`, `filters`), arithmetic
(`add`/`sub`/`mul`/`div`/`mod`, `neg`/`pos`), comparison
(`eq`/`neq`/`lt`/`lte`/`gt`/`gte`/`like`/`notLike`/`ilike`), logical
(`and`/`or`/`not`), predicates (`isNull`/`notNull`, `between`/`notBetween`,
`inList`/`notInList`, `inSubquery`/`notInSubquery`, `exists`/`notExists`), array
ops (`contains`/`containsAny`/`containsAll`/`isEmpty`/`notEmpty`), `case`/`when`,
calls (`fn`, `agg`/`count`/`countStar`/`sum`/`avg`/`min`/`max`, `window`,
`tableFn`), `subquery`, and search (`textSearch`, `semantic`). Every function is
also a named export (`import { eq, and, ref } from '@aeye/query'`).

**Run or emit a built expr standalone** — the engine normalizes either an `Expr`
or a raw `ExprDef`:

```ts
// Evaluate against a row (defaults to an empty row for constant predicates):
const v = await engine.evaluateExpr(e.gt(e.ref('task', 'hours'), e.value(0)), {
  task: { hours: 5 },
});                                         // Value(true)

// Emit SQL + ordered bind params for a dialect (params never interpolated):
const { sql, params } = engine.exprToSQL(cond, 'postgres');
// sql:    ("task"."done" = $1 AND "task"."hours" > $2)
// params: [true, 0]
```

**Embed a built expr into a query** via `.toJSON()` — a query def's `where` /
`order` / field slots are `ExprDef`, and `.toJSON()` is the free wire form:

```ts
const select = {
  kind: 'select',
  fields: [{ expr: e.ref('user', 'name').toJSON() }],
  from: { kind: 'type', type: 'user' },
  where: [e.gt(e.ref('user', 'age'), e.value(30)).toJSON()],
} as const;
```

`registry.parseExpr` is a **pass-through** for an already-built `Expr`, so built
and parsed exprs compose freely.

### Sources & aliasing

Every source is referenced by its **type name** — there is no alias to invent or
keep in sync:

- **FROM.** `from: { kind: 'type', type: 'user' }` binds under `source: 'user'`.
- **Joins.** A join crosses a **single relation field** — `on` is a
  `{ kind: 'relation', source, field, as }` ref
  (`{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' } }`):
  the bound source to join FROM, its relation field, and the **required alias**
  the joined rows bind under (field-refs into them then use `source: 'order'`).
  **Multi-hop** joins are expressed as **chained** single-hop joins, and reading a
  value across a relation is a join + a plain `{ source, field }` field-ref (there
  is no separate relation-path expr). The relation key is synthesized — you never
  write ON. A join can also add a **fresh source** — `on` may instead be a
  `type` / `aliased` / `subquery` / `function` source, with `and` as its ON (a
  manual join). `joinType` (freeing `type` for the Type-name rule) defaults to
  `left`.
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

### Output references (`groupBy` / `orderBy` / `having`)

A SELECT's `groupBy`, `order`, and `having` can reference a **projected output
field by name** instead of repeating its expression — via
`{ kind: 'output', name }`. The `name` is the output's `as`, or its natural
derived name (a field-ref's field, an aggregate's function name). The reference **EXPANDS to** (delegates to) the
referenced select item's expression: the SQL emits the target's SQL (portable
across dialects, in every clause), and the runtime re-evaluates the target — so
a group key re-computes over the source row while an ORDER BY / HAVING ref
re-computes over the group (including an aggregate target). This keeps queries
smaller and removes a whole class of GROUP BY / ORDER BY mismatches.

```ts
// Revenue per user, grouped + ordered by output name — the `sum` / `userId`
// expressions are written ONCE, in `fields`.
const revenuePerUser = {
  kind: 'select',
  fields: [
    { expr: { kind: 'field-ref', source: 'order', field: 'userId' }, as: 'userId' },
    { expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'field-ref', source: 'order', field: 'total' } } }, as: 'revenue' },
  ],
  from: { kind: 'type', type: 'order' },
  groupBy: [{ kind: 'output', name: 'userId' }],   // ← by output name, not the expr
  having:  [{ kind: 'comparison', op: '>', left: { kind: 'output', name: 'revenue' }, right: { kind: 'literal', value: 100 } }],
  order:   [{ expr: { kind: 'output', name: 'revenue' }, dir: 'desc' }],
} as const;
```

It is valid **only** in those three clause positions — in WHERE, a join `on`, or
any general expression argument (where no outputs are bound) it fails validation
with `output.not-available`. An unknown name reports `output.unknown`, and using
one as a GROUP BY key whose target is an aggregate reports `output.aggregate`
(you cannot group BY an aggregate). The LLM schema offers `output` in exactly
those `groupBy` / `orderBy` / `having` positions and nowhere else. `drillDown`
expands any `output` references against the original projection before it
un-ravels the aggregates, so a drilled query never dangles.

## Write model & permissions

Types and fields declare **what write operations are possible**, and that flows
into BOTH validation AND the LLM-facing schema — so the generated schema never
offers a write the engine would reject.

- **Type permissions.** `insertable` / `updatable` / `deletable` on a `TypeDef`
  (each default **true**). A restricted Type is rejected by validation
  (`insert.type-readonly` / `update.type-readonly` / `delete.type-readonly`), the
  schema **drops the DML kind** when no Type permits it, and each DML's
  target-name enum is filtered (`into` → insertable, `update.type` → updatable,
  `delete.from` → deletable).
- **Field permissions.** `insertable` / `updatable` on a `FieldDef` (default
  **true**). A **computed** field (`FieldBacking.compute`) defaults to
  `insertable:false, updatable:false` (override with an explicit flag).
  Validation rejects a listed non-insertable field (`insert.field-readonly`) / an
  assigned non-updatable field (`update.field-readonly`); the paired schema
  offers only insertable `fields` / updatable `set` fields.
- **Insert-requiredness (one rule).** A field is REQUIRED on insert iff it is
  **insertable AND non-nullable AND has no default AND is not computed** —
  otherwise optional or excluded. A shared `requiredOnInsert` helper drives both
  the schema (required-vs-optional in paired mode) and validation
  (`insert.missing-required`, listing the missing names).
- **Defaults live on the backing.** `FieldBacking.default` is a `Value` or a
  factory `() => Value | Promise<Value>` — its presence alone makes the field
  optional-on-insert (no `hasDefault` flag). At **runtime** an omitted defaulted
  field is materialized (value evaluated / factory awaited, per row) into the
  record; in **SQL** the column is left out of the INSERT so the DB's own column
  `DEFAULT` fills it (a JS-factory default is runtime-only).
- **Per-field expr restrictions.** `FieldDef.exprs` = `{ not: ExprKind[] }` or
  `{ only: ExprKind[] }` NARROWS which expr kinds may target the field (never
  enables one the field TYPE disallows). `field.allowsExpr(kind)` respects both.
  Validation reports `field.expr-denied` at the use site — a standalone
  `field-ref`, a gating operator's DIRECT field-ref operand (`comparison` /
  `between` / `in` / `is-null` / `array-op`), and the field-naming exprs
  (`text-search` / `text-score` / `semantic` / `filters`). The paired schema
  omits an excluded field from the relevant enum, and gates a kind away entirely
  when every candidate field excludes it.

```ts
const doc: TypeDef = {
  name: 'doc', count: 1000, bytes: 256,
  fields: [
    { name: 'id',    type: { kind: 'text' } },                      // required on insert
    { name: 'title', type: { kind: 'text' } },                      // required
    { name: 'views', type: { kind: 'number' }, updatable: false },  // write-once
    { name: 'notes', type: { kind: 'text' }, nullable: true },      // optional
  ],
};
// `createdAt` is optional-on-insert (has a default) and materialized at runtime.
const backing: TypeBacking = {
  fields: { createdAt: { default: () => Value.of(new Date().toISOString()) } },
};
```

## Execution model

There is ONE execution contract: **run a query, optionally with param values
and filters, and get back `{ rows, fields, total }`**.

```ts
const result = await engine.run(query, { params, filters, includeTotal });
//   result.rows   — the output rows (objects; pass { rows: 'array' } for arrays)
//   result.fields — resolved output fields (name + type + summary metadata)
//   result.total  — pre-limit row count, when run with `includeTotal: true`
```

Each field's `type` is the full `ResolvedType`. A **computed** one carries
`aggregate` (does a group collapse happen anywhere in this expression?) and
`aggregateFn` — the APPLIED aggregate's name, present exactly when the value IS
one aggregate call. `sum(hours) as total_hours` reports `aggregateFn: 'sum'`
under any alias; `max(a) - min(b)` reports `aggregate: true` with NO
`aggregateFn` (it contains aggregates but is none); a window over an
aggregate-shaped function reports neither. Read it rather than inferring the
function from the output column NAME, which cannot see through an alias and
mistakes `hours * 2 as count` for an aggregate.

Everything composes around that one call:

- **Params.** A `param` (`{ kind: 'param', name }`) infers its type from how it
  is used and is bound at run time via `options.params`. Introspect what a built
  query expects with `query.params(engine)` → `ParamDef[]` (name + inferred
  type).
- **Filters.** `options.filters` is a `Record<source, ExprDef | Expr | null>` —
  a single **boolean Expr** per source (or `null` / absent for none). The
  `filters` EXPR in the query is only a placeholder (`{ source, fields? }`); the
  predicate is supplied here, keyed by source, and the placeholder evaluates /
  emits it (vacuously `TRUE` when none is supplied). Introspect which sources a
  built query exposes — and the fields each offers — with
  `query.filters(engine)` → `Record<source, { fields: QueryField[] }>` (each
  field is name + resolved type + nullability + field-type kind, restricted to
  the placeholder's `fields` allowlist when it sets one). Build the per-source
  bool Expr however you like — e.g. a `comparison` / `logical` `ExprDef`, or one
  produced by your own filter-builder UI. `query.filterSources()` still lists the
  sources a filter may target; an unknown source or field is a `QueryTypeError`.
- **Total count.** `includeTotal: true` is an **execution-time** option (NOT a
  `SelectDef` field): `run` captures the pre-limit count into `result.total`,
  and `toSQL(query, dialect, { includeTotal: true })` emits
  `COUNT(*) OVER () AS "$total"`.

  It applies to the **ENTRY query only** — never a CTE body, a set-operation
  arm, or a FROM subquery. `$total` is a PROJECTED column, so an arm that
  carried it would take part in the set comparison and change the **rows**:
  `UNION` would stop de-duplicating, and `INTERSECT` / `EXCEPT` would compare
  per-arm counts they were never meant to see. A query whose entry is a **set
  operation therefore reports no total at all** (`result.total` is `undefined`;
  the SQL carries no `$total`) rather than a wrong one — both engines agree.
  To page a set operation *and* count it, wrap it in a SELECT and count there:

  ```ts
  const counted = {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 's', field: 'id' } }],
    from: { kind: 'subquery', as: 's', query: theUnion },
    limit: 20,
  } satisfies SelectDef;
  await engine.run(counted, { includeTotal: true }); // → { rows, total }
  ```
- **Pagination.** `autoPaginate` adds `limit` / `offset` as bind PARAMS, so
  pagination is just supplying their values:

  ```ts
  import { autoPaginate } from '@aeye/query';
  const paged = autoPaginate(select); // adds { limit: param('limit'), offset: param('offset') }
  paged.params(engine);               // → [{ name:'limit', type:{kind:'number'} }, { name:'offset', … }]
  await engine.run(paged, { params: { limit: 10, offset: 0 } });
  ```

  It pages exactly the kinds that HAVE a row bound: a **`select`** (its own
  LIMIT / OFFSET), a **set operation** (`union` / `intersect` / `except` — the
  SET-LEVEL bound over the combined rows, never an arm's, since paging an arm
  would change which rows the set operation compares), and a **`cte`**, which is
  paged through its `final` query (a CTE body is an intermediate result). Every
  other kind — `insert` / `update` / `delete` / `expr` — has no bound to bind and
  **throws** `QueryTypeError` with code `paginate.unsupported-kind`. Ask first
  with `canAutoPaginate(query)` when you hold an arbitrary `QueryDef`.

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
remap the real source table, compute fields, auto-join other Types, gate
rows / fields, and point full-text / semantic search at hidden physical fields —
all resolved IDENTICALLY in `engine.run` and `engine.toSQL`.

Two primitives compose everything. Each offers a dual `expr` path plus per-mode
overrides — **SQL** resolves `sql` then `expr`; the **runtime** resolves `run`
then `expr`. Every factory (`expr` / `sql` / `run`) is handed the **`alias` the
Type is bound under for this occurrence** and MUST use it for every reference
(never hardcode the Type name) — so when a Type is aliased (multiple joins to the
same Type, a self-join, an `{kind:'aliased'}` FROM) the references resolve to the
correct source:

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
  // dual expr: the auto-joined owner's name (one definition, both modes). Read
  // the named join off the BOUND `alias` with `e.ref`, never a literal type name.
  ownerName: { joins: ['owner'], compute: { expr: (alias) => e.ref(joinAlias(alias, 'owner'), 'name') } },

  // per-mode override: format money in SQL one way, in memory another. Both use
  // the bound `alias` (`row[alias]`), never a hardcoded key.
  budgetLabel: { compute: {
    sql: (alias, ctx) => SqlText.concat([SqlText.raw("'$' || "), ctx.dialect.field(alias, 'budget')]),
    run: (alias, row) => Value.of(`$${row[alias]?.['budget'] ?? 0}`),
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
access: { expr: (alias) => e.eq(e.ref(alias, 'orgId'), e.value(currentOrg)) },

// FLS: `secretField` is visible only for active projects, reading stored `secret`.
secretField: { name: 'secret', access: { expr: (alias) => e.eq(e.ref(alias, 'status'), e.value('active')) } },
```

## Default conditions (soft scope)

`TypeBacking.defaultConditions` is a **soft, suppressible** default scope —
archived / soft-delete filtering the query can **reveal past**, unlike RLS. Each
`DefaultCondition` is `{ where, without?, ops?, description? }`:

- **`where`** — an `Access` predicate (dual `{ expr }` / `sql` / `run`, resolved
  exactly like RLS: `false` ⇒ no rows, `true` / `undefined` ⇒ no filter, else
  ANDed) applied while the condition is **active**, per bound occurrence.
- **`without`** — referencing any of these fields **on that source** in a
  **condition position** (the query's `where` / `having`, or a JOIN's `and`)
  **lifts** the scope for that source. A reference in a select item / ORDER BY /
  GROUP BY does **not** lift it, and each bound alias (incl. a self-join) is
  decided independently. Omitted ⇒ derived from the fields `where.expr` reads (a
  `sql`/`run`-only `where` with no `without` is then **always-on** — set it
  explicitly to make it liftable).
- **`ops`** — which row-filtering ops it scopes (default
  `['select', 'update', 'delete']`; **INSERT is never scoped**).
- **`description`** — an optional terse LLM-facing note (else auto-summarized in
  `describeType`).

RLS still always applies and is **never** suppressed; a default condition ANDs in
alongside it.

```ts
// Archived files: every query is scoped to `archivedAt IS NULL`…
defaultConditions: [{ where: { expr: (alias) => e.isNull(e.ref(alias, 'archivedAt')) } }],

// …until a query FILTERS on `archivedAt` (e.g. WHERE archivedAt IS NOT NULL),
// which lifts the scope for that source and reveals the archived rows.
```

## Default ordering

`TypeBacking.defaultOrder` declares a Type's **natural sort** — the `ORDER BY` a
SELECT gets when it specifies **none** (and ordering is meaningful). A
`DefaultOrder` is `{ by: DefaultOrderTerm[]; applyTo? }`; each `DefaultOrderTerm`
is `{ by: Computed; dir?; nulls? }` whose `by` is the sort **key** — the same
dual `{ expr }` / `sql` / `run` `Computed` computed fields use, so one key
**emits to SQL and sorts in memory identically** (`dir` default `'asc'`; `nulls`
else direction-based — asc ⇒ nulls first, desc ⇒ last — matching an explicit
ORDER BY).

It applies only when the **FROM** binds the backed Type (joins never contribute
their default order), the query has **no explicit `order`**, and it is **not
aggregated** (no `groupBy`, no bare aggregate) and **not `DISTINCT`** — both are
skipped (a base-field order is meaningless post-aggregation; a non-selected
DISTINCT key is illegal SQL).

`applyTo` scopes **which** selects receive it:

- **`'result'`** (default) — the **root** query being run/emitted, **or** any
  `LIMIT`/`OFFSET` select.
- **`'paginated'`** — only a `LIMIT`/`OFFSET` select.
- **`'all'`** — every eligible select over the Type (incl. subqueries / CTEs).

The root is tracked by an `isRoot` marker threaded from `engine.run` /
`engine.toSQL` onto the runtime / SQL context; nested queries (a subquery /
EXISTS / IN subquery, a FROM subquery, a CTE body, a set-op branch) run and emit
**non-root**. SELECT-only — DML is never reordered.

```ts
// Newest-first by default: an unsorted SELECT over the Type gets
// `ORDER BY "t"."createdAt" DESC`.
defaultOrder: { by: [{ by: { expr: (alias) => e.ref(alias, 'createdAt') }, dir: 'desc' }] },
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
  // The lateral correlates via `outer` (the planner passes this backed Type's
  // bound alias to `query`); the inner FROM (`task`) is its own scope.
  taskStats: { expr: (alias) => ({ kind: 'lateral', joinType: 'left',
    query: (outer) => ({ kind: 'select',
      fields: [
        { expr: e.countStar().toJSON(), as: 'cnt' },
        { expr: e.sum(e.ref('task', 'hours')).toJSON(), as: 'hrs' },
      ],
      from: { kind: 'type', type: 'task' },
      where: [e.eq(e.ref('task', 'projectId'), e.ref(outer, 'id')).toJSON()] }) }) },
}
```

A `lateral`'s `pick` names the column a no-`compute` field defaults to. Postgres
emits `LEFT JOIN LATERAL (…) ON true`; the portable base dialect degrades to
`LEFT JOIN LATERAL (…) ON 1 = 1` (a documented correlated-subquery fallback) and
the runtime evaluates the sub-select per outer row.

## Relation-join backing (physical FK columns / custom ON)

By default a relation join's `ON` is synthesized from the relation field's
**name** convention (`source.<local> = target.<foreign>`). `FieldBacking.relation`
(on a relation-typed field only) overrides that with **explicit, LLM-hidden
physical foreign-key columns** — the conceptual `FieldDef` / `TypeDef` the model
sees never change.

```ts
const backing: TypeBacking = {
  fields: {
    // `comment_rating.user` belongs-to `user`; the hidden physical FK is `user_id`.
    user: { relation: { keys: [{ local: 'user_id', foreign: 'id' }] } },
  },
};
// A user's ratings (the materialized inverse has-many) then emits
//   … LEFT JOIN "comment_rating" ON "user"."id" = "comment_rating"."user_id"
// and the belongs-to direction emits the mirror `ON "comment_rating"."user_id" = "user"."id"`.
```

- **`keys: [{ local, foreign? }]`** — physical key-column pairs, **all ANDed**
  (composite FKs: `keys: [{ local: 'a_id', foreign: 'a' }, { local: 'b_id',
  foreign: 'b' }]` ⇒ `ON src.a_id = tgt.a AND src.b_id = tgt.b`). `local` is the
  column on the side that **declares** the relation; `foreign` is the column on
  the **target** and defaults to the target's identity field.
- **The backing lives on the owning belongs-to relation.** A materialized inverse
  has-many **reuses the same FK** (its forward relation's backing, orientation
  swapped) — you declare it once.
- **`on`** — a fully custom, alias-correct `ON` (overrides `keys`). `{ expr }` is
  the dual path (one predicate emitted to SQL **and** evaluated in memory); `sql`
  / `run` are per-mode overrides. Each factory receives the two **bound aliases**
  (`localAlias` = the declaring side, `joinedAlias` = the target), so
  aliased / self-joins resolve.

Every ON site honors the backing — authored relation joins (value + at runtime),
the `TypeBacking.joins` relation spec, and joined UPDATE/DELETE — so SQL and the
in-memory runtime always agree. `JoinDef.and`
is still ANDed onto whatever `ON` the backing produces. With no backing the
convention is used unchanged (fully backward-compatible).

## Filters and params

A `filters` expression is an **LLM-opaque placeholder** bound to a source, with
an optional `fields` allowlist — `{ kind: 'filters', source, fields? }`. The LLM
never authors the predicate. At **execution time** the developer supplies a
single **boolean `Expr` / `ExprDef`** per source (keyed by source); the
placeholder evaluates / emits it, vacuously `TRUE` when none is supplied.

Introspect what a built query exposes with `query.filters(engine)`: it returns
`Record<source, { fields: QueryField[] }>` — for every `filters` placeholder,
its bound source mapped to the fields available on it (each with name, resolved
type, nullability, and field-type kind), restricted to the placeholder's
`fields` allowlist when set. A UI renders controls from that, then supplies the
resulting bool `Expr` at run time.

```ts
// In the query: just a placeholder + an allowlist (no predicate).
where: [{ kind: 'filters', source: 'product', fields: ['category', 'price'] }]

// Introspect the exposed source → fields.
const exposed = engine.registry.parseQuery(select).filters(engine);
// → { product: { fields: [{ name:'category', … }, { name:'price', … }] } }

// At run time: supply ONE bool ExprDef per source (built however you like — here
// with the `e.*` builder, whose `.toJSON()` is the wire `ExprDef`).
const productFilter: ExprDef = e.and(
  e.eq(e.ref('product', 'category'), e.value('hardware')),
  e.gte(e.ref('product', 'price'), e.value(30)),
).toJSON();
await engine.run(select, { filters: { product: productFilter } });
```

## Semantic & text search

Both are bound to a **source** with an OPTIONAL `field` (omit to target the
whole source):

- **`semantic`** — `{ kind: 'semantic', source, field?, query }` scores a row's
  embedding against `query`, which is a literal string, a `param`, a
  `{ source, field }` ref to ANOTHER **bound** source + semantic field (the
  cross-source **pairing** form), or a `{ type, field }` ref that resolves to the
  single bound source of that Type. The source/field must be semantic-eligible (a
  Type flagged `semantic`, or a `semantic`/`search` text field). Requires an
  embedder.
- **`text-search`** — `{ kind: 'text-search', source, field?, query }` is a
  full-text **predicate** (a boolean); `query` is a literal string or a `param`.
  Whole-source search needs a searchable Type; a narrowed `field` must be a text
  field.
- **`text-score`** — `{ kind: 'text-score', source, field?, query }` is the
  numeric **relevance** counterpart of `text-search` (same eligibility). It
  resolves to a **number** — usable in SELECT + ORDER BY — so "top N by text
  relevance" works. Postgres emits `ts_rank`; the base (ANSI) dialect degrades to
  a numeric `0/1` match. Build it with `e.textScore(source, query, field?)`.

```ts
{ kind: 'semantic', source: 'doc', field: 'body', query: 'quarterly revenue' }
{ kind: 'semantic', source: 'doc', query: { source: 'topic', field: 'label' } } // pairing
{ kind: 'text-search', source: 'user', field: 'email', query: 'ada' }
{ kind: 'text-score',  source: 'doc',  field: 'body',  query: 'revenue' }
```

In the LLM schema these participate in **depth** like field-refs: at `paired`
the `source` is a Type and the `field` enum is restricted to that Type's
semantic / text fields.

### Scoring & ranking — pairing + text relevance

Both `semantic` (pairing) and `text-score` produce a **number** you can put in
SELECT and `ORDER BY … DESC LIMIT N`, so a query returns the top-N by relevance.

- **Cross-Type semantic pairing.** Join (or cross-join) two Types so BOTH are
  bound, then score one against the other's embedding. `toSQL` emits the
  dialect's `similarity` over BOTH bound aliases' vectors (each side's hidden
  `SemanticBacking.vectorField` if backed, else the default `<alias>."embedding"`
  fragment), so a self-pairing of two aliases of ONE Type works too:

  ```sql
  -- FROM paper JOIN topic … , fields: [ id, semantic(paper, {source:'topic',field:'label'}) as score ]
  SELECT "paper"."id", (1 - ("paper"."emb" <=> "topic"."embedding")) AS "score"
  FROM "paper" … INNER JOIN "topic" … ORDER BY "score" DESC LIMIT 10
  ```

  Validation requires BOTH sides be bound and semantic-eligible: an unbound
  reference is `semantic.query-unbound`; a `{ type }` bound more than once is
  `semantic.query-ambiguous` (use the `{ source }` form to disambiguate). The
  base dialect degrades similarity to `0` (never throws).

- **Numeric text score.** `text-score` ranks by full-text relevance:
  `ts_rank(to_tsvector(col), plainto_tsquery(query))` in Postgres (honoring a
  `SearchBacking`'s hidden `vectorField` / `language` / boolean `sql` override,
  the last lifted to a numeric `0/1`); the base dialect degrades to
  `CASE WHEN <LIKE> THEN 1 ELSE 0 END`. In memory it is a deterministic
  token-overlap fraction (honoring `SearchBacking.run`). See
  `examples/13-scoring-ranking.ts`.

### Search & semantic backing

A Type / field flagged `search` / `semantic` in the (unchanged, minimal) schema
very often has a **physical field hidden from the type system** that already
holds a precomputed `tsvector` (full-text) or `pgvector` embedding. A backing
says **how** search / similarity runs per Type or field — most importantly by
pointing at that hidden field. Both `TypeBacking` (whole-type) and `FieldBacking`
(per-field) take an optional `search?: SearchBacking` and `semantic?:
SemanticBacking`; a **field-level** backing overrides the **type-level** one.

```ts
const backing: TypeBacking = {
  // WHOLE-TYPE: point at hidden precomputed fields (NOT conceptual fields).
  search:   { vectorField: 'search_tsv', language: 'english' }, // a tsvector field
  semantic: { vectorField: 'embedding' },                       // a pgvector field
  fields: {
    // FIELD-LEVEL override wins for a field-narrowed `text-search` / `semantic`.
    title: { search: { vectorField: 'title_tsv' }, semantic: { vectorField: 'title_vec' } },
  },
};
```

**Knobs** (each factory takes the bound `alias` **first** and must reference it,
so aliased / self-joined sources resolve correctly):

- `vectorField` — the hidden physical field, referenced as `<alias>."<field>"`.
  In Postgres a `SearchBacking.vectorField` emits the precomputed-tsvector
  predicate `<alias>."f" @@ plainto_tsquery('<language>', $n)` (**not** re-wrapped
  in `to_tsvector`); a `SemanticBacking.vectorField` is the left operand of the
  dialect's `similarity`, with the query vector bound as a `$n::vector` param.
- `language` — the text-search config for `plainto_tsquery` (default `'english'`).
- `sql` — a full SQL override → a **boolean** predicate (search) / **numeric**
  score (semantic). Given `(alias, query|queryVector, ctx)`.
- `run` — a full runtime override → `boolean` (search) / `number` (semantic).
- `SemanticBacking.vector` — where the row's embedding comes from at runtime
  (an alternative to `vectorField`), returning `number[]` or `null`.
- `SemanticBacking.embedder` — a per-Type / per-field embedder for the **query**
  text (else the run / engine embedder).

**Precedence** (both modes): a full `sql` / `run` override wins; else the hidden
`vectorField` (or `vector` producer) is used; else today's default (the dialect's
`textSearch` / `similarity` over the conceptual text fields, or an in-memory
token match / embed-the-row-text). `toSQL` stays synchronous — the async embedder
is **never** called there; the query vector is a bound param.

The **base (ANSI) dialect degrades gracefully** and never throws: a tsvector
field falls back to a case-insensitive `LIKE`, and vector similarity to a
constant `0`. See `examples/12-search-backing.ts`.

### Array fields and operations

An `array` field is queried with the `array-op` predicate expression: `contains`
(a single element is present), `containsAny` / `containsAll` (overlap / superset
against an element list), and `isEmpty` / `notEmpty`. Element count is a
`comparison` over the builtin `arrayLength(field)` scalar function. (When the
element type is a non-`sensitive` text type, element matching is
case-insensitive, like text.)

```ts
// containment — a single element is present:
{ kind: 'array-op', op: 'contains', target: { kind: 'field-ref', source: 'user', field: 'tags' },
  value: { kind: 'literal', value: 'beta' } }

// overlap against an element list:
{ kind: 'array-op', op: 'containsAny', target: { kind: 'field-ref', source: 'user', field: 'tags' },
  value: [{ kind: 'literal', value: 'admin' }, { kind: 'literal', value: 'beta' }] }

// element count ≥ 2 via the builtin arrayLength function:
{ kind: 'comparison', op: '>=',
  left: { kind: 'function-call', function: 'arrayLength', args: { arr: { kind: 'field-ref', source: 'user', field: 'tags' } } },
  right: { kind: 'literal', value: 2 } }
```

> Build these with the `e.*` array builders (`e.contains` / `e.containsAny` /
> `e.containsAll` / `e.isEmpty` / `e.notEmpty`, and `e.fn('arrayLength', …)`).

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

Each aggregate is replaced by its underlying row-level expression, and `count(*)`
— which has no single value — expands to the FROM type's fields MINUS the ones
the SELECT already projects itself. So `SELECT status, count(*) … GROUP BY status`
drills to `status` plus the remaining columns, with the group key projected ONCE.
The skip is keyed on the EXPRESSION (its canonical form), never on the output
name: two different expressions may legitimately share a name.

## Cost & estimation

Bottom-up estimates driven by each Type's cardinality (`count` rows, `bytes`
per row), its indexes + fixed **selectivity** for predicates (an indexed
equality narrows toward one row; a non-indexed one applies `EQ_SELECTIVITY`),
and per-Type / per-field `changes` rates. Five estimators hang off the engine:

```ts
const cost    = engine.cost(select);        // { rows, bytes } — WORK to produce the result (scanned rows)
const output  = engine.outputCost(select);  // { rows, bytes } — SIZE of the result (delivered rows × projection width)
const affected = engine.affected(update);   // { rows, types: [{ type, rows }] } — rows an INSERT/UPDATE/DELETE (or CTE) mutates
const refs    = engine.references(select);  // { types, fields, functions } — exactly what the query READS
const ttl     = engine.changeInterval(select); // ms until the data behind it could change (0 = always, -1 = never, else fastest rate)

// Constraints reject over-budget queries during validation:
const problems = engine.validateQuery(select, undefined, { maxRows: 100, maxBytes: 1_000_000 });
// → cost.rows-exceeded / cost.bytes-exceeded when the estimate blows past a cap
```

`cost` estimates work (OR-aware, index-probe driven); `outputCost` sizes the
delivered result (post-WHERE/GROUP/DISTINCT, capped by LIMIT/OFFSET);
`affected` counts mutated rows per Type; `references` powers `changeInterval`,
which folds the read Types' / fields' / functions' `changes` rates into a single
freshness / cache-TTL signal. All accept the same execution-time
`options.params` / `filters` / `sort` so the estimate reflects what actually runs.

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
| `window`    | `(partition, index, ctx)` → value per row     | `rowNumber`   |

`count(*)` is the empty-args convention: `{ kind: 'aggregate', function:
'count', args: {} }`. The registry ships a **default library** (60+ functions
across all shapes — `upper`/`concat`/`coalesce`/…, string/math scalars
(`trimLeft`/`padLeft`/`splitPart`/`log`/`iif`/…), `sum`/`avg`/`min`/`max`/
`count`, `rowNumber`/`rank`/`lag`/…) registered by `createRegistry()`, so they
are discoverable and runnable out of the box (see the reference below):

```ts
registry.functionList();            // every FunctionDef (default lib + your own)
describeFunctions(engine);          // a promptable, by-shape listing for an LLM
```

### Function reference

All builtin names are **camelCase** (no underscores). Where the emitted SQL
function name differs from the camelCase name it is shown in the *SQL* column;
otherwise the SQL is `name(args)` on both dialects. `base` is the portable
ANSI dialect, `postgres` the pg dialect (they differ only where noted).

**Window** (`e.window`)

| function                    | SQL (base = postgres) | notes                                   |
| --------------------------- | --------------------- | --------------------------------------- |
| `rowNumber()`               | `row_number()`        | renamed from `row_number`               |
| `rank()`                    | `rank()`              |                                         |
| `denseRank()`               | `dense_rank()`        | renamed from `dense_rank`               |
| `lag(value, offset?, default?)`  | `lag(…)`         |                                         |
| `lead(value, offset?, default?)` | `lead(…)`        |                                         |
| `percentRank()`             | `percent_rank()`      | `(rank − 1) / (N − 1)`                   |
| `cumeDist()`                | `cume_dist()`         |                                         |
| `ntile(n)`                  | `ntile(n)`            | 1-based bucket over `n` equal buckets   |
| `firstValue(value)`         | `first_value(value)`  |                                         |
| `lastValue(value)`          | `last_value(value)`   | full-partition frame (see note below)   |
| `nthValue(value, n)`        | `nth_value(value, n)` | 1-based                                 |

**Scalar — string** (`e.fn`)

| function                              | SQL name        |
| ------------------------------------- | --------------- |
| `lower` `upper` `trim` `length` `substring` `replace` `concat` | *(same)* |
| `trimLeft(value)`                     | `ltrim`         |
| `trimRight(value)`                    | `rtrim`         |
| `left(value, count)` `right(value, count)` | *(same)*   |
| `padLeft(value, length, fill?)`       | `lpad`          |
| `padRight(value, length, fill?)`      | `rpad`          |
| `repeat(value, count)` `reverse(value)` | *(same)*      |
| `indexOf(value, search)`              | `strpos` (1-based, 0 = absent) |
| `startsWith(value, search)`           | `starts_with`   |
| `splitPart(value, delimiter, index)`  | `split_part` (1-based) |
| `concatWs(separator, values)`         | `concat_ws` (`values` = one array arg, like `concat`) |

**Scalar — math** (`e.fn`)

| function                              | SQL name        |
| ------------------------------------- | --------------- |
| `abs` `ceil` `floor` `round` `sqrt` `power` | *(same)*  |
| `mod(value, divisor)` `sign` `exp` `ln` `trunc` `pi()` `random()` | *(same)* |
| `log(base, value)`                    | `log(base, value)` |
| `log10(value)`                        | `log` (pg single-arg `log` is base-10) |
| `degrees` `radians` `sin` `cos` `tan` `asin` `acos` `atan` `atan2(y, x)` | *(same)* |

**Scalar — conditional / other** (`e.fn`)

| function                              | SQL             |
| ------------------------------------- | --------------- |
| `iif(condition, then, else)`          | `(CASE WHEN condition THEN then ELSE else END)` (both dialects) |
| `coalesce` `nullif` `greatest` `least` `arrayLength` | *(same)* |
| `now()`                               | `now()`         |
| `currentDate()`                       | `CURRENT_DATE` (renamed from `current_date`; bare form, no parens) |

**Scalar — date / time** (`e.*`) — temporal inputs accept an ISO date/timestamp
string or a temporal field; the `field` of a selector is a **literal** token
(`'year'`/`'month'`/`'day'`/`'dow'`/`'doy'`/`'week'`/`'hour'`/`'minute'`/
`'second'`/`'quarter'`/`'isodow'`/`'epoch'`) spliced inline (not a bind param).

| function                              | base SQL                         | postgres SQL                          |
| ------------------------------------- | -------------------------------- | ------------------------------------- |
| `currentTime()` `currentTimestamp()`  | `CURRENT_TIME` / `CURRENT_TIMESTAMP` (bare) | *(same)*                   |
| `year/month/day/hour/minute/second(d)`| `EXTRACT(<PART> FROM d)`          | *(same)*                              |
| `dayOfWeek(d)`                        | `EXTRACT(DOW FROM d)`            | *(same)* — `0`=Sun … `6`=Sat          |
| `dayOfYear(d)` `week(d)`              | `EXTRACT(DOY/WEEK FROM d)`       | *(same)* — `week` is the ISO week     |
| `datePart(field, d)`                  | `EXTRACT(<field> FROM d)`        | `date_part('field', d)`               |
| `dateAdd(field, n, d)`                | `d` (degrade — unchanged)       | `(d + (n \|\| ' ' \|\| 'field')::interval)` |
| `dateDiff(field, a, b)`               | `(EXTRACT(field FROM b) − EXTRACT(field FROM a))` | `(date_part('field', b) − date_part('field', a))` — component difference |
| `dateTrunc(field, d)`                 | `d` (degrade — unchanged)       | `date_trunc('field', d)`              |
| `makeDate(year, month, day)`          | `make_date(…)`                  | `make_date(…)`                        |
| `dateFormat(d, format)`               | `to_char(d, fmt)`               | `to_char(d, fmt)` — tokens `YYYY/MM/DD/HH24/HH/MI/SS` |
| `epoch(ts)`                           | `EXTRACT(EPOCH FROM ts)`        | *(same)*                              |
| `fromEpoch(value)`                    | `to_timestamp(value)`           | `to_timestamp(value)`                 |
| `age(a, b)`                           | `age(a, b)`                     | `age(a, b)` — runtime returns whole-day span |

**Scalar — array** (`e.*`) — postgres-native; the base (ANSI) dialect DEGRADES
gracefully (a constant, or the first argument unchanged) and never throws.

| function                              | base SQL (degrade) | postgres SQL                          |
| ------------------------------------- | ------------------ | ------------------------------------- |
| `arrayContains(arr, value)`           | `(1 = 0)`          | `(value = ANY(arr))`                  |
| `arrayAppend(arr, value)`             | `arr`              | `array_append(arr, value)`            |
| `arrayPrepend(arr, value)`            | `arr`              | `array_prepend(value, arr)`           |
| `arrayConcat(a, b)`                   | `a`                | `(a \|\| b)`                          |
| `arrayIndexOf(arr, value)`            | `0`                | `array_position(arr, value)` (1-based)|
| `arraySlice(arr, lo, hi)`             | `arr`              | `arr[lo:hi]` (1-based inclusive)      |
| `arrayRemove(arr, value)`             | `arr`              | `array_remove(arr, value)`            |
| `arrayDistinct(arr)`                  | `arr`              | `ARRAY(SELECT DISTINCT unnest(arr))`  |
| `arrayToString(arr, sep)`             | `''`               | `array_to_string(arr, sep)`           |
| `stringToArray(str, sep)`             | `str`              | `string_to_array(str, sep)`           |

**Aggregate** (`e.agg` / `e.sum` / …): `count` `sum` `avg` `min` `max`
— all emit `name(args)` (or `count(*)` for empty args). Group 2d adds:

| function                              | base SQL                         | postgres SQL                          |
| ------------------------------------- | -------------------------------- | ------------------------------------- |
| `stddev(value)` `variance(value)`     | `stddev(…)` / `variance(…)` (sample) | *(same)*                          |
| `stringAgg(value, sep)`               | `string_agg(value, sep)`        | *(same)*                              |
| `countIf(cond)`                       | `sum(CASE WHEN cond THEN 1 ELSE 0 END)` | *(same, both dialects)*       |
| `arrayAgg(value)`                     | `NULL` (degrade)                | `array_agg(value)`                    |
| `boolAnd(value)`                      | `(MIN(CASE WHEN value THEN 1 ELSE 0 END) = 1)` | `bool_and(value)`      |
| `boolOr(value)`                       | `(MAX(CASE WHEN value THEN 1 ELSE 0 END) = 1)` | `bool_or(value)`       |

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

// 4. A ready-wired `@aeye/core` `Tool` — drop it into any core / `@aeye/ai`
//    agent's tool set. Its wire `schema` is the query schema; its custom `parse`
//    REPLACES Zod (validate the envelope → build a runnable `Query` → run full
//    engine validation), throwing a rich `QueryToolError` whose `.message` is a
//    compiler-style report on failure. Its `call` RUNS the built query.
//    `instructions` reflect the active depth + the selected functions.
const tool = buildQueryTool(engine, { depth: 'paired' });
const query = await tool.parse(ctx, JSON.stringify({ query: someQueryDef })); // built Query (throws QueryToolError on failure)
const result = await tool.run(query, ctx);                                    // runs it → QueryResult
```

Because the custom `parse` bypasses Zod, the model sees the engine's concise
`Problems` diagnostics (via `formatProblems`) instead of Zod's harder-to-follow
messages; when the query is clean the decoded value is the built `Query` and the
tool's `call` executes it.

**Self-describing the engine.** `describeEngine(engine, { types?, functions? })` composes one terse, promptable block a model can read to know everything it may use: every (supplied) Type, then `describeExprs` (the capability-gated `kind — INSTRUCTIONS` list of usable expr kinds — `semantic` / `array-op` / … appear only when an eligible Type/function exists; the core is never gated), then `describeFunctions` (`name(a, b?): output — instructions`, grouped by shape), then `describeDialects`. `describeType` / `describeField` always render a short `label` + long `description` — the dev's `TypeDef` / `FieldDef` values when set, else defaults GENERATED on demand from the meta-model (a Field from its FieldType + flags + nullability + relation cardinality; a Type from its name + field/relation/index summary). Read the pair with `fieldMeta(field)` / `typeMeta(type)`; the stored def is never mutated.

See `examples/` for an end-to-end, runnable tour of all of the above.

## Schema depth

`buildSchemas` / `querySchema` / `buildQueryTool` constrain the LLM-facing
schema along **four independent axes**, each dialed by `depth`:

| axis        | levels (loose → tight)                       | constrains                               |
| ----------- | -------------------------------------------- | ---------------------------------------- |
| `refs`      | `open` · `types` · `fields` · `both` · `paired` | `field-ref` source + field / relation join `on` |
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
| joins | some Type has a relation field |
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
constrains the model's output, and the tool's custom `parse`
validates + parses it into a runnable `Query` — surfacing LLM-friendly
`Problems` (as a `QueryToolError`) that drive a single automatic repair round
before running.

