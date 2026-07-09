# @aeye/query — LLM relational query language

**Purpose:** A JSON, LLM-authorable relational query language with an in-memory runtime and a SQL converter. You register *Types* (table-like entities) made of *Fields*; from those an LLM (or a developer) builds a **typed, validated, runnable** query — a `select` / `insert` / `update` / `delete` / set-operation / CTE / single-expression statement. A built query resolves to an output type, has typed bind params, can be cost-bounded, run in-memory, emitted to SQL (base + Postgres), auto-paginated, and drilled down.

It is standalone (only depends on `zod`) and exhaustively type-safe: every polymorphic node is a discriminated union, so handling is compiler-checkable with no `any`/casts.

## When to use it

- You want an LLM to author a **structured, validated** query over a schema you control — and get compiler-style diagnostics instead of free-form SQL you have to trust.
- You need the SAME query to run in-memory AND emit dialect SQL (base ANSI + Postgres) identically.
- You want the conceptual schema the model sees to stay minimal while the physical reality (real tables, RLS/FLS, computed fields, hidden vector/tsvector columns, extra joins) lives in dev-side backing code.
- You need cost bounding, aggregate drill-down, pagination, semantic/full-text ranking, or execution-time filters over model-authored queries.

## The query/expr JSON contract (state once)

A query is a `QueryDef` and an expression is an `ExprDef` — plain JSON discriminated unions (keyed by `kind`) that round-trip through `JSON.stringify`. **The LLM does not hand-write these shapes from memory:** `buildSchemas` / `querySchema` generate a Zod schema the model emits against, and that schema is both **depth-graduated** (how tightly Type names / field refs / function args / filters are locked — see *Schema depth*) and **capability-gated** (expr kinds an available Type/function can't use are omitted). The doc below therefore describes *what is supported*; the schema tells the model *how to shape it*. `schema.ts` is the single source of truth for every `*Def`.

Developers compose the same trees ergonomically with the **`e.*` builder** (one builder per expr kind); each `e.*` returns a real `Expr` instance and `.toJSON()` is its wire `ExprDef`. `registry.parseExpr` is a pass-through for an already-built `Expr`, so built and parsed exprs compose freely.

```ts
import { e } from '@aeye/query';
const cond = e.and(e.eq(e.ref('task', 'done'), e.value(true)), e.gt(e.ref('task', 'hours'), e.value(0)));
```

Builders, by group: leaves (`value`/`lit`, `param`, `ref`, `path`, `output`, `excluded`, `filters`), arithmetic (`add`/`sub`/`mul`/`div`/`mod`, `neg`/`pos`), comparison (`eq`/`neq`/`lt`/`lte`/`gt`/`gte`/`like`/`notLike`/`ilike`), logical (`and`/`or`/`not`), predicates (`isNull`/`notNull`, `between`/`notBetween`, `inList`/`notInList`, `inSubquery`/`notInSubquery`, `exists`/`notExists`), array (`contains`/`containsAny`/`containsAll`/`isEmpty`/`notEmpty`), `case`/`when`, calls (`fn`, `agg`/`count`/`countStar`/`sum`/`avg`/`min`/`max`, `window`, `tableFn`), `subquery`, search (`textSearch`, `textScore`, `semantic`). Every builder is also a named export.

## The type / field model

A `Type` is a named collection of `Field`s plus index + cardinality estimates (`count` rows, `bytes`/row for cost). Each field has a `FieldType` — one of `number`, `text`, `money`, `bool`, `relation`, `date`, `timestamp`, `json`, `array` (nine kinds). Nullability lives on the field, not the type.

- **Text** is case-insensitive by default; set `sensitive: true` for case-sensitive matching. Fields may be flagged `semantic` (embedding-eligible) and/or `search` (full-text-eligible); a whole Type may carry the same `semantic` / `search` flags.
- **Relations** carry a target `to` Type and cardinality `count`: the relation field's **name IS the join key** (there are no explicit FK fields). `count === 1` is belongs-to; `count > 1` is has-many. A belongs-to may set `inverseRelation` so its target auto-gains the matching has-many. Join keys resolve through each Type's identity field (first unique single-field index, else `id`).
- **Indexes** are composite (ordered parts, each with a non-increasing prefix distinct-row `count`); unique iff the last part's `count === 1`. They drive cost estimation.
- **Arrays** are ordered collections with optional `minItems`/`maxItems` and an optional `item` element field type (omit `item` for heterogeneous); they nest (`array<array<number>>`).

`createRegistry()` bootstraps the Type/expr/function catalog; `registry.parseType(def)` + `registerType` add Types. `inferType(name, rows)` derives a `TypeDef` (field types + nullability, array detection) straight from sampled JSON rows.

## Expression kinds

Every kind is one branch of the `ExprDef` union. Availability in the LLM schema is depth-graduated and capability-gated; the always-usable core is never gated. Each Expr class also exposes a concise `static INSTRUCTIONS` one-liner (enumerable via `registry.exprClassList()`) — the canonical terse doc mirrored by the table below — plus, on the high-confusion kinds, a `static EXAMPLES` set of RAW JSON strings that `describeEngine` renders (capped by `maxExamples`).

| kind | one-line meaning |
| ---- | ---------------- |
| `literal` | A constant scalar value. |
| `param` | A named bind parameter; type inferred from use, bound at run/emit time. |
| `field-ref` | `<source>.<field>` — a field's value from a bound source. |
| `relation-path` | Walks relation fields from a source (optionally ending at a scalar); planner synthesizes the joins. |
| `binary` | Arithmetic `left <op> right` (`+ - * / %`). |
| `unary` | `<op> operand` (`-` / `+`). |
| `comparison` | `left <op> right` → boolean (`= <> < <= > >=`, `like`, `notLike`, `ilike`). |
| `logical` | Boolean connective `and` / `or` / `not` over operands. |
| `is-null` | `value IS [NOT] NULL`. |
| `between` | `value BETWEEN lower AND upper` (negatable). |
| `in` | `value IN (list \| subquery)` (negatable). |
| `case` | `CASE WHEN … THEN … [ELSE …] END`. |
| `function-call` | A scalar function call by name with named args. |
| `aggregate` | An aggregate function over a group (`count(*)` = empty args); optional `distinct`. |
| `window` | A window (or windowed-aggregate) function over `partitionBy` / `orderBy`. |
| `subquery` | A scalar / single-field subquery in value position. |
| `exists` | `[NOT] EXISTS (subquery)` → boolean. |
| `array-op` | Predicate over an array field: `contains` / `containsAny` / `containsAll` / `isEmpty` / `notEmpty`. |
| `text-search` | Full-text predicate over a source (optionally one field) → boolean. |
| `text-score` | Numeric full-text relevance score of a source (optionally one field) → number (`ts_rank`). |
| `semantic` | Embedding-similarity score of a source's row vs a query (string / param / pairing ref) → number. |
| `filters` | An execution-time filter placeholder bound to a source (optional `fields` allowlist); predicate supplied at run time. |
| `excluded` | `EXCLUDED."field"` — the proposed row inside `INSERT … ON CONFLICT DO UPDATE`. |
| `output` | References a projected SELECT output field by name (valid ONLY in `groupBy`/`orderBy`/`having`); expands to that item's expr. |
| `tabular-function-call` | A row-producing (table-valued) function call, usable as a source. |

## Sources & aliasing

Everything is referenced by its **Type name** — there is no alias to invent or keep in sync.

- **FROM** — `{ kind: 'type', type: 'user' }` binds under `source: 'user'` (not aliasable). Also available: `aliased` (escape hatch), `subquery`, and `function` (a tabular-function source).
- **Joins** — a `JoinDef` crosses a **single relation hop**: `on` is a `{ source, field }` ref (the bound source + its relation field). Joined rows bind under the target Type name; the join key is synthesized from the relation (you never write ON). Multi-hop = chained single-hop joins (or a `relation-path` expr for value access). `joinType` (`inner`/`left`/`right`/`full`, default `left`) is renamed from `type` to free that key. `and` adds an optional extra predicate.
- **DML** targets (`insert.into` / `update.type` / `delete.from`) bind under the Type name; DML targets take no alias.
- **`type` vs `source` rule.** `type` = a registered Type name (FROM `type`, DML targets, relation `to`, a `{ type, field }` semantic ref). `source` = a bound name in scope (Type name / join alias / CTE / aliased source) — used by `field-ref`, `semantic`/`text-search`/`text-score`/`filters`, and a join's `on.source`.
- **Disambiguation.** For a self-join or two instances of one Type, use `{ kind: 'aliased', type, as }` on FROM, or `as` on a join to override its hop's bound name. Two sources bound under one name → a `source.duplicate` validation error.

## What queries can do

- **SELECT** — `fields` (each `{ expr, as? }`), `from`, `joins`, `where` (ANDed), `groupBy`, `having` (ANDed), `order` (`{ expr, dir, nulls? }`), `limit`/`offset` (a literal or a `param`), and `distinct`.
- **Condition clauses must be boolean** — every top-level condition predicate (a `where`/`having` entry, a join's `and`, and a DML `update`/`delete` `where`) must resolve to a boolean, exactly as `logical` operands and `case` `when` clauses already require; a non-boolean predicate (a bare `field-ref` to a number/money/text field, a `literal`, an arithmetic `binary`, a non-bool function) is rejected with `condition.non-bool` at the predicate's own path. A bare `param` predicate is EXEMPT (its type is inferred from use).
- **Output references** — `groupBy` / `order` / `having` may use `{ kind: 'output', name }` to reference a projected field by name (its `as`, or a natural derived name) instead of repeating the expression. It EXPANDS to the target item's expr in both SQL and runtime (a group key re-computes over the source row; an ORDER BY / HAVING ref re-computes over the group, incl. an aggregate target). Valid **only** in those three positions (`output.not-available` elsewhere; `output.unknown` / `output.aggregate` on misuse). `drillDown` expands `output` refs before un-ravelling.
- **Aggregates & grouping** — any registered aggregate over a `groupBy`; `count(*)` is `count` with empty args; `distinct` on the aggregate. `having` filters groups.
- **Set operations** — `union` / `intersect` / `except` over two queries, `all?` to keep duplicates, plus **set-level** `order` / `limit` / `offset` applied to the combined rows (ORDER BY terms reference output columns by name).
- **CTEs** — `{ kind: 'cte', ctes, final }`. Each entry is either non-recursive (`{ name, query }`) or **recursive** (`{ name, base, recursive }` — a seed UNION-ed with an arm reading the CTE's own accumulating rows to a fixpoint, iteration-capped). Recursion is its own structural shape (no `recursive?` flag).
- **DML** — `insert` (row tuples or a `select`, optional `returning`, optional `onConflict`), `update` (`set` assignments, optional `joins`/`where`/`returning`), `delete` (optional `joins`/`where`/`returning`). `onConflict` = conflict-target `fields` plus `doNothing` or an `update` assignment list (which may reference the `excluded` proposed row).
- **Single-expression query** — `{ kind: 'expr', expr }` for a scalar computation.
- **Params** — `{ kind: 'param', name }` infers its type from use; bound at run/emit via `options.params`. Introspect with `query.params(engine)` → `ParamDef[]`.
- **Filters** — a `filters` placeholder (`{ source, fields? }`) is authored by the LLM but the **predicate is supplied at execution time** by the developer: `options.filters` is a `Record<source, boolean Expr | ExprDef | null>`. The placeholder evaluates/emits it (vacuously `TRUE` when none). Introspect exposed sources + fields with `query.filters(engine)` → `Record<source, { fields: QueryField[] }>` (name + resolved type + nullability + kind, restricted to any `fields` allowlist); `query.filterSources()` lists targetable sources.
- **Cost** — every query has a bottom-up `{ rows, bytes }` estimate (`engine.cost(query)`); `validateQuery(query, _, { maxRows })` rejects over-budget queries (`cost.rows-exceeded`).

## Write model & permissions

Types and fields declare **what write operations are possible**, and the model flows into BOTH validation AND the LLM-facing schema — so the generated schema is accurate to what can actually be done.

- **Type flags** — `insertable` / `updatable` / `deletable` on a `TypeDef` (each default **true**). A restricted Type drops the matching DML: validation rejects it (`insert.type-readonly` / `update.type-readonly` / `delete.type-readonly`) AND the schema omits the query kind entirely when NO Type permits it, and filters each DML's target-name enum (`into` → insertable Types, `update.type` → updatable, `delete.from` → deletable).
- **Field flags** — `insertable` / `updatable` on a `FieldDef` (default **true**). A field whose `FieldBacking.compute` is set defaults to `insertable:false, updatable:false` (override with an explicit flag). Validation rejects a listed non-insertable field (`insert.field-readonly`) / an assigned non-updatable field (`update.field-readonly`); the paired schema offers only insertable `fields` / updatable `set` fields.
- **Insert-requiredness (THE rule)** — a field is REQUIRED on insert iff it is **insertable AND non-nullable AND has no default AND is not computed**; otherwise optional (nullable / has-default) or excluded (non-insertable). One shared helper (`requiredOnInsert`) drives both the schema (required-vs-optional in paired mode) and validation (`insert.missing-required`, which lists the missing names).
- **Defaults** — `FieldBacking.default` is a `Value` or a factory `() => Value | Promise<Value>`. Its **presence alone** makes the field optional-on-insert (there is no `hasDefault` flag). At **runtime** an omitted defaulted field is materialized (the value is evaluated / the factory awaited, per row) into the inserted record. In **SQL** the column is simply left out of the INSERT and the database's own column `DEFAULT` fills it — so a JS-factory default is a runtime-only concern.
- **Expr restrictions** — `FieldDef.exprs` is `{ not: ExprKind[] }` (exclude these kinds) or `{ only: ExprKind[] }` (allow exactly these). It can only NARROW what the field TYPE already permits. `field.allowsExpr(kind)` respects both the type floor and the restriction. Validation rejects a denied kind at the field's use site (`field.expr-denied`) — checked on a standalone `field-ref` (gated as `field-ref`), on each gating operator's DIRECT field-ref operand (gated as `comparison` / `between` / `in` / `is-null` / `array-op`), and on the field-naming exprs (`text-search` / `text-score` / `semantic` / `filters`). The paired schema omits an excluded field from the relevant enum and gates a kind away entirely when every candidate field excludes it.

## Semantic & text search + scoring / ranking

All three search exprs bind to a **source** with an OPTIONAL `field` (omit ⇒ whole source); eligibility requires a `semantic`/`search`-flagged Type or field.

- **`text-search`** — full-text **predicate** (boolean). `query` is a literal string or a `param`.
- **`text-score`** — the **numeric** relevance counterpart (same eligibility): usable in SELECT + ORDER BY, so "top N by text relevance" works. Postgres emits `ts_rank(to_tsvector(col), plainto_tsquery(query))`; base (ANSI) degrades to `CASE WHEN <LIKE> THEN 1 ELSE 0 END`; in-memory is a deterministic token-overlap fraction. Build with `e.textScore(source, query, field?)`.
- **`semantic`** — embedding-similarity **score** (≈1 = most similar; requires an embedder). `query` is a literal string, a `param`, a `{ source, field }` ref to ANOTHER bound source + semantic field (the **cross-source pairing** form), or a `{ type, field }` ref resolving to the single bound source of that Type (`semantic.query-unbound` / `semantic.query-ambiguous` steer you to the `{ source }` form).

**Cross-Type pairing + ranking.** Join (or cross-join) two Types so both are bound, score one against the other's embedding, then `ORDER BY score DESC LIMIT N`. Postgres emits the dialect's `similarity` over both bound aliases' vectors (each side's hidden `vectorField` if backed, else `<alias>."embedding"`); the base dialect degrades similarity to `0` and never throws.

## Array fields & operations

Query an `array` field with the `array-op` predicate: `contains` (a single element present), `containsAny` / `containsAll` (overlap / superset vs an element list), `isEmpty` / `notEmpty`. Element count is a `comparison` over the builtin `arrayLength(arr)`. Non-`sensitive` text elements match case-insensitively.

**Dialects.** Array ops are Postgres-native: `contains` → `value = ANY(col)`, `containsAll` → `col @> ARRAY[…]`, `containsAny` → `col && ARRAY[…]`, length → `cardinality(col)`. The base (ANSI) dialect has no array operators, so containment throws a clear `array-op.unsupported-dialect` `QueryTypeError` rather than emit wrong SQL; emptiness / length still work via `COALESCE(json_array_length(col), 0)`.

## Type backing (physical reality behind the conceptual schema)

The flat `TypeDef` the LLM sees can be arbitrarily richer behind the scenes. A `TypeBacking` is dev-side TypeScript registered alongside the Type (`registerType(type, backing)` or `new QueryEngine(registry, { backings })`); the JSON `TypeDef`/`FieldDef` are never touched. All of it resolves IDENTICALLY in `engine.run` and `engine.toSQL`. Every factory receives the **bound `alias`** for the occurrence and must reference it (never hardcode the Type name), so aliased/self-joined sources resolve correctly.

- **Real table remap** — `TypeBacking.name` maps to the physical table (`FROM "projects" AS "project"`); `FieldBacking.name` remaps a stored column.
- **Computed fields** — `FieldBacking.compute` supplies a field's value: a dual `{ expr }` (one `Expr` emitted to SQL AND evaluated in memory), with `sql` / `run` per-mode overrides. Compute/access exprs reaching into other sources flow through the join planner (fields sharing a join collapse to one join). A computed field is non-insertable / non-updatable by default (see **Write model & permissions**).
- **Insert defaults** — `FieldBacking.default` (a `Value` or a `() => Value | Promise<Value>` factory) makes a field optional-on-insert and is materialized into the row at runtime when omitted; emitted SQL omits the column and relies on the DB's own `DEFAULT` (see **Write model & permissions**).
- **RLS** (`TypeBacking.access`) — a row predicate ANDed into WHERE and filtering executor rows; `false` ⇒ no rows, `true`/`undefined` ⇒ no filter; combines with any `RlsProvider` passed to run/toSQL.
- **Default conditions (soft scope)** (`TypeBacking.defaultConditions`) — a SOFT, suppressible default scope (think archived / soft-delete filtering): unlike RLS, the query can REVEAL past it. Each `DefaultCondition` is `{ where, without?, ops?, description? }`. While ACTIVE its `where` (an `Access` — dual `{ expr }` / `sql` / `run`, resolved exactly like RLS: `false` ⇒ no rows, `true`/`undefined` ⇒ no filter, else ANDed) is ANDed into the WHERE of every occurrence of the Type. It **lifts** for a bound source the moment a **condition-position** clause (the query's `where` / `having`, or a JOIN's `and`) references one of the condition's `without` fields **on that source** — a reference in a SELECT item / ORDER BY / GROUP BY does NOT lift it, and each bound alias (incl. a self-join) is decided independently. `without` defaults to the fields the `where.expr` reads (a `sql`/`run`-only `where` with no `without` is therefore ALWAYS-ON — set `without` explicitly to make it liftable). `ops` picks the row-filtering ops it scopes (default `['select','update','delete']`; INSERT is never scoped). RLS is separate and never lifts; a default condition ANDs in alongside it. Example — archived files: `defaultConditions: [{ where: { expr: (a) => isNull(ref(a, 'archivedAt')) } }]` scopes every query to `archivedAt IS NULL`, until a query filters on `archivedAt` (e.g. `WHERE archivedAt IS NOT NULL`), which reveals the archived rows for that source.
- **Default ordering** (`TypeBacking.defaultOrder`) — a Type's NATURAL sort, applied to a SELECT's `ORDER BY` when the query specifies none (and ordering is meaningful). `DefaultOrder` is `{ by: DefaultOrderTerm[]; applyTo? }`; each `DefaultOrderTerm` is `{ by: Computed; dir?; nulls? }` whose `by` is the sort KEY — the same dual `{ expr }` / `sql` / `run` `Computed` as computed fields, so one key emits to SQL AND sorts in memory identically (`dir` default `'asc'`; `nulls` else the direction-based default — asc ⇒ nulls first, desc ⇒ last — matching an explicit ORDER BY). It applies ONLY when the FROM binds the backed Type (joins never contribute their default order), the query has NO explicit `order`, and it is NOT aggregated (no `groupBy`, no bare aggregate) and NOT `DISTINCT` (both skipped — a base-field order is meaningless post-aggregation, and a non-selected DISTINCT key is illegal SQL). `applyTo` scopes WHICH selects receive it: `'result'` (default) ⇒ the ROOT query being run/emitted OR any `LIMIT`/`OFFSET` select; `'paginated'` ⇒ only a `LIMIT`/`OFFSET` select; `'all'` ⇒ every eligible select (incl. subqueries / CTEs). The ROOT is tracked by an `isRoot` marker threaded from `engine.run` / `engine.toSQL` onto the runtime / SQL context; nested queries (a subquery / EXISTS / IN subquery, a FROM subquery, a CTE body, a set-op branch) run/emit non-root. Example — newest-first: `defaultOrder: { by: [{ by: { expr: (a) => ref(a, 'createdAt') }, dir: 'desc' }] }` ⇒ an unsorted select over the Type gets `ORDER BY "t"."createdAt" DESC`. SELECT-only; DML is never reordered.
- **FLS** (`FieldBacking.access`) — a per-field gate emitting `CASE WHEN <pred> THEN <value> ELSE NULL END`; `false` ⇒ constant `NULL`.
- **Named joins & LATERAL** (`TypeBacking.joins`, opted into by `FieldBacking.joins: [name]`) — hidden joins added once per query only when a referencing field is emitted, deduped by name. A `JoinSpec` is a `relation` (reuses relation-join machinery) or a `lateral` (a correlated sub-select; Postgres `LEFT JOIN LATERAL (…) ON true`, base degrades to `ON 1 = 1` and evaluates per outer row; a `lateral.pick` names the default column).
- **Relation-join backing** (`FieldBacking.relation`, on a relation-typed field only) — drives a relation join's `ON` from explicit, LLM-HIDDEN physical foreign-key columns instead of the name convention (the JSON `FieldDef`/`TypeDef` are unchanged). `keys: [{ local, foreign? }]` are physical key-column pairs, ALL ANDed (composite FKs supported); `local` is the column on the side that DECLARES the relation, `foreign` the column on the TARGET (defaults to the target's identity). The backing lives on the OWNING **belongs-to** relation; a materialized inverse has-many REUSES the same FK (its forward relation's backing, orientation swapped). `on` is a fully custom, alias-correct predicate — `{ expr }` dual (SQL + runtime), with `sql` / `run` per-mode overrides; precedence like compute/access (`run`/`sql` override → `expr` → the `keys` mapping, else the convention). Every ON site (authored joins, `relation-path` value + runtime, fan-out aggregate grouping, the `TypeBacking.joins` relation spec, joined UPDATE/DELETE) honors it and references the BOUND ALIASES, so aliased / self-joins work; `JoinDef.and` still ANDs onto whatever ON is produced. Example (the belongs-to owner): `fields: { user: { relation: { keys: [{ local: 'user_id', foreign: 'id' }] } } }` ⇒ `ON src.user_id = tgt.id` (and its inverse has-many `ON one.id = many.user_id`).
- **Search / semantic backing** — a `search`/`semantic`-flagged Type/field usually has a physical field hidden from the type system holding a precomputed `tsvector` / `pgvector`. `TypeBacking` and `FieldBacking` each take optional `search?: SearchBacking` / `semantic?: SemanticBacking` (field-level overrides type-level). Knobs (each factory takes the bound `alias` first): `vectorField` (the hidden physical field — a `SearchBacking.vectorField` emits `<alias>."f" @@ plainto_tsquery('<language>', $n)` without re-wrapping in `to_tsvector`; a `SemanticBacking.vectorField` is the left operand of the dialect's `similarity`, query vector bound as `$n::vector`), `language` (default `'english'`), `sql` (full override → boolean/numeric), `run` (runtime override), plus `SemanticBacking.vector` (row embedding source) and `embedder` (per-Type/field query embedder). Precedence (both modes): full `sql`/`run` override wins; else the hidden `vectorField`/`vector`; else the engine default. `toSQL` stays synchronous — the async embedder is never called there (the query vector is a bound param). The base dialect degrades (tsvector → `LIKE`, similarity → `0`) and never throws.

## Function library

`createRegistry()` ships a default library (60+ functions across all four shapes), registered as `FunctionDef` (name + shape + **named** params + output) paired with a shape-tagged runtime. Calls use named args (`args: { paramName: <expr> }`). Register your own with `registerFunction` + `registerFunctionRun`. Introspect with `registry.functionList()`; get a promptable by-shape listing with `describeFunctions(engine)`. Every builtin `FunctionDef` carries a terse `instructions` one-liner (what it does / arg meaning / gotcha), surfaced on `QueryFunction.instructions`; the high-confusion ones also carry `examples` (RAW JSON strings, round-tripped by `QueryFunction.from` / `toJSON`) that `describeEngine` renders under the signature.

Shapes: `scalar` `(args, ctx)→value`, `tabular` `(args, ctx)→rows`, `aggregate` `(rows, ctx)→value`, `window` `(partition, index, ctx)→value/row`. All builtin names are **camelCase**; where the emitted SQL name differs it is noted. The base (ANSI) dialect degrades where noted and never throws.

**Scalar — string:** `concat`, `lower`, `upper`, `trim`, `length`, `substring`, `replace`, `trimLeft`(→`ltrim`), `trimRight`(→`rtrim`), `left`, `right`, `padLeft`(→`lpad`), `padRight`(→`rpad`), `repeat`, `reverse`, `indexOf`(→`strpos`, 1-based, 0=absent), `startsWith`(→`starts_with`), `splitPart`(→`split_part`, 1-based), `concatWs`(→`concat_ws`).

**Scalar — math:** `abs`, `ceil`, `floor`, `round`, `sqrt`, `power`, `mod`, `sign`, `exp`, `ln`, `log`(base, value), `log10`(→`log`), `trunc`, `pi()`, `degrees`, `radians`, `random()`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`(y, x).

**Scalar — conditional / other:** `coalesce`, `nullif`, `greatest`, `least`, `arrayLength`, `iif`(cond, then, else → `CASE WHEN`), `now()`, `currentDate()`(→`CURRENT_DATE`, bare).

**Scalar — date / time:** `currentTime()`, `currentTimestamp()`, `datePart(field, d)`, `year`/`month`/`day`/`hour`/`minute`/`second(d)`, `dayOfWeek(d)`(0=Sun…6=Sat), `dayOfYear(d)`, `week(d)`(ISO week), `dateAdd(field, n, d)`, `dateDiff(field, a, b)`(component difference), `dateTrunc(field, d)`, `makeDate(year, month, day)`, `dateFormat(d, format)`(→`to_char`; tokens `YYYY/MM/DD/HH24/HH/MI/SS`), `epoch(ts)`, `fromEpoch(value)`(→`to_timestamp`), `age(a, b)`(runtime = whole-day span). The selectors' `field` arg is an inline literal token (`year`/`month`/`day`/`dow`/`doy`/`week`/`hour`/`minute`/`second`/`quarter`/`isodow`/`epoch`), spliced not bound.

**Scalar — array** (Postgres-native; base degrades): `arrayContains`, `arrayAppend`, `arrayPrepend`, `arrayConcat`, `arrayIndexOf`(1-based), `arraySlice`(1-based inclusive), `arrayRemove`, `arrayDistinct`, `arrayToString`, `stringToArray`.

**Aggregate:** `count`, `sum`, `avg`, `min`, `max`, `stddev`, `variance` (both sample/n-1), `stringAgg`(→`string_agg`), `arrayAgg`(→`array_agg`; base degrades to `NULL`), `boolAnd`(→`bool_and`), `boolOr`(→`bool_or`), `countIf`(→ portable `sum(CASE WHEN … THEN 1 ELSE 0 END)`).

**Window:** `rowNumber`(→`row_number`), `rank`, `denseRank`(→`dense_rank`), `lag(value, offset?, default?)`, `lead(value, offset?, default?)`, `percentRank`(→`percent_rank`), `cumeDist`(→`cume_dist`), `ntile(n)`, `firstValue`(→`first_value`), `lastValue`(→`last_value`; full-partition frame), `nthValue`(→`nth_value`; 1-based).

## Schema depth & capability gating

`buildSchemas` / `querySchema` / `buildQueryTool` constrain the LLM-facing schema along **four independent axes**, each dialed by `depth`:

| axis | levels (loose → tight) | constrains |
| ---- | ---------------------- | ---------- |
| `refs` | `open` · `types` · `fields` · `both` · `paired` | `field-ref` / `relation-path` source + field |
| `typeNames` | `open` · `enum` | bare Type-name positions (`from`, `into`, …) |
| `functions` | `open` · `names` · `typed` | function name + named-arg objects |
| `filters` | `open` · `paired` | the `filters` clause `(field, op)` pairs |

Pass a full/partial `SchemaDepth` object, or a preset string: `'open'` (every axis loose) / `'paired'` (every axis tight); the deprecated `strict: true`/`false` are sugar for those. A `FunctionSelector` (`{ scalar: [...], … }`) picks which functions appear; `maxEnumSize` auto-degrades any axis whose enumeration overflows the budget one level looser so a large catalog never yields an unusable schema.

**Capability gating** (independent of depth) omits any expr kind the available Types/functions can't use: `semantic` (some Type `isSemantic()`), `text-search`/`text-score` (`isSearchable()`), `array-op` (a Type has an array field), `relation-path` + `joins` (a Type has a relation), `tabular-function-call` (≥1 tabular fn), `aggregate`/`window`/`function-call` (≥1 fn of that shape), `filters` (a Type has filterable fields). The always-usable core (`literal`/`param`/`binary`/`unary`/`comparison`/`logical`/`in`/`between`/`is-null`/`exists`/`case`/`field-ref`/`subquery`) is never gated.

## Execution model

One contract: **run a query, optionally with params + filters, and get back `{ rows, fields, total }`.**

```ts
const result = await engine.run(query, { params, filters, includeTotal });
//   result.rows   — output rows (objects; pass { rows: 'array' } for arrays)
//   result.fields — resolved output fields (name + type + summary metadata)
//   result.total  — pre-limit count, when run with includeTotal: true
```

- **`includeTotal`** is an execution-time option (not a `SelectDef` field): `run` captures the pre-limit count; `toSQL(query, dialect, { includeTotal: true })` emits `COUNT(*) OVER () AS "$total"`.
- **`autoPaginate(query)`** adds `limit`/`offset` as bind params idempotently, so paging is just supplying values: `run(paged, { params: { limit, offset } })`.
- **Drill-down.** `drillDown(query, engine)` rebuilds the underlying-rows query behind an aggregate, parameterized (each GROUP BY key pinned to a bind param) — returns `{ query, params, warnings }`. `drillDownInto(query, groupRow, engine)` extracts one aggregated row's key values; then it is the same `run` call. Failures return LLM-friendly `Problems` (`drill.no-aggregation` / `non-invertible` / `having-aggregate` / `window-unsupported`).
- **Standalone exprs.** `engine.evaluateExpr(expr, row?)` evaluates an `Expr`/`ExprDef` against a row; `engine.exprToSQL(expr, dialect)` emits `{ sql, params }` (params never interpolated).

### SQL conversion

`engine.toSQL(query, dialect, options?)` emits `{ sql, params }` for any registered dialect. Base uses `?` placeholders; Postgres uses `$1, $2, …`. Relation joins synthesize their ON clause from the relation key. `toSQL` accepts the same `params` / `filters` / `includeTotal` options as `run`, so emitted SQL matches what would run.

## The LLM tool

The parse+validate pipeline is exposed **standalone**, so you can validate a query without building a `Tool` just to call `.parse` on it. All three entries share ONE implementation:

- **`parseQueryTool(engine, raw, options?) → Query | QueryToolError`** — the DIRECT parse entry. Given the conceptual `{ query }` envelope, it validates the envelope, parses the structured `query` into a runnable `Query`, and runs full engine validation (structure + params + per-Type validators). Clean ⇒ the built `Query`; any problem ⇒ a rich `QueryToolError` whose `.report` (also its `.message`) is a concise compiler-style report (`formatProblems`), so the model sees real diagnostics instead of Zod's.
- **`parseQueryRequest(engine, raw, options?) → { query, problems, report }`** — the same pipeline exposing the detailed result: the built `Query` (or `null`), the accumulated `Problems`, and the rendered `report`. (A SEMANTIC failure keeps the built `query` alongside its problems; a STRUCTURAL failure yields `query: null`.)
- **`buildQueryTool(engine, options?) → Tool`** — the tool WRAPPER, built only when you need a runnable `@aeye/core` `Tool` to drop into an agent's tool set. Its wire `schema` is the engine's query schema (depth-graduated + capability-gated), its custom `parse` DELEGATES to `parseQueryTool` (Zod is demoted to the model-facing wire schema only), and its `call` handler RUNS the validated query and returns a `QueryResult`. Its `instructions` reflect the active depth + selected functions, and (past `max` Types via `shouldUseStringSchema`) it falls back to a prose-description schema.

Because core wire-decodes the model's response **before** any custom `parse` hook runs (and a directly-parsed CLI/file def is already conceptual), the standalone functions operate on the **conceptual** value — they never need the wire schema for parsing.

```ts
import { selectTypes, querySchema, parseQueryTool, parseQueryRequest, QueryToolError } from '@aeye/query';

const types = await selectTypes(engine, 'revenue by customer last month'); // narrow the schema

// DIRECT parse — no Tool built. Feed a def straight through (CLI / file / your own loop):
const parsed = parseQueryTool(engine, { query: someQueryDef }, { depth: 'paired', types });
if (parsed instanceof QueryToolError) console.log(parsed.report);          // underlined diagnostics
else console.log(await engine.run(parsed));                                // runnable Query → QueryResult

// Detailed result when you want the problems + report explicitly:
const { query, problems, report } = parseQueryRequest(engine, { query: someQueryDef }, { types });

// The model-facing schema for your own LLM loop (the model emits against it; core decodes with it):
const schema = querySchema(engine, { depth: 'paired', types });
```

Build a `Tool` only when an agent must CALL and RUN it:

```ts
import { buildQueryTool } from '@aeye/query';

const tool = buildQueryTool(engine, { depth: 'paired', types });
const query = await tool.parse(ctx, JSON.stringify({ query: someQueryDef })); // delegates to parseQueryTool (throws QueryToolError on failure)
const result = await tool.run(query, ctx);                                    // runs it → QueryResult
```

`buildSchemas` / `querySchema` expose the schema directly when you drive your own LLM loop.

### Underlined, compiler-style problem reports

`QueryToolError.report` renders every problem — STRUCTURAL (the owned, zod-free parser `registry.parseCheckedQuery`, now the ACTIVE gate) *and* SEMANTIC (`validateWalk`: unknown fields, param conflicts, per-Type validators) — as underlined diagnostics over the model's **own** query JSON, so it sees exactly which value to fix:

```
── line 21 ──────────────────────────────────────────────
21 │         "left": "oops",
   │                 ^^^^^^
   │ error: expected an expression
```

**Messages are aid-directed (domain-specific), not Zod-generic.** The owned parser's `Shape` combinators reuse the same `aids.ts` vocabulary (`aidInfo` for the label, `didYouMean` for suggestions) as the wire schema, so the structural diagnostics read in the query's own terms: `"left": "oops"` → "expected **an expression**, got a string"; `"args": "total"` → "expected **named arguments**, an object of { argName: <expr> }, got a string"; `"kind": "comparise"` → "unknown **expression kind** `comparise` — did you mean `comparison`?"; `"op": "equals"` → "expected a comparison operator: =, <>, <, <=, >, >=, like, notLike, ilike"; `"limit": "three"` → "expected a number or a param, got a string". **Structure vs semantics:** the owned parser accepts any REGISTERED kind with any string field (capability/depth is a wire-schema concern), so an unknown Type / field / function name is a SEMANTIC rejection instead — e.g. an unknown field surfaces from `validateWalk` as "Type 'user' (source 'user') has no field 'ghost'." (with its own `didYouMean`), still underlined at the offending field-ref.

How it works: `jsonSource(value)` (in `src/json-source.ts`) re-emits the canonical `JSON.stringify(value, null, 2)` text while recording, for every node (root, each property value, each array element), the `[start, end)` char offsets keyed by the node's structural path (the same `(string | number)[]` shape as `Problem.path`). `Code.fromJson(value)` builds a `Code` over that text with those spans pre-registered, and `formatProblems` resolves each `Problem.path → span → (line, col)` to draw the `^^^` underline with surrounding context. The owned parser records each structural problem DIRECTLY at the offending value's path (`problems.at(key, …)`, accumulating, never throwing), so — unlike zod's `.or`-folded union failures — there is no nesting/noise to collapse: one problem per offending value, already at the right path.

Both the owned parser AND the wire schema draw their DIRECTED text from the SAME `aid → { label, noun? }` `AID_REGISTRY` in `src/aids.ts` (so the two never diverge): the owned parser's `Shape`s call `aidInfo` / `didYouMean` directly, while the wire schema uses **`withAid`** — every generated schema node is tagged with a stable `aid` (`.meta({ aid })`, unchanged — it also names the JSON-schema `$defs` entry) plus a per-schema, captured **error map** that renders domain text off `AID_REGISTRY`. On an `invalid_type` it reads `expected <label>[, got <received>]`; on an enum failure `expected <label>: <allowed values>`; on a union `.or` no-match either the union's `<label>` or, when the value carries a typo'd string `kind`, "unknown `<noun>` kind `x` — did you mean `y`? (available: …)". The wire schema the model consumes is unchanged except the added `aid` metadata and the friendlier error text (never serialized into JSON-schema). A problem whose path matches no node degrades gracefully (nearest ancestor, or a plain `<severity>: <message> @ <path>` line) rather than crashing. Valid queries produce no problems ⇒ an empty report.

**"Did you mean?" on EVERY unknown-name diagnostic.** A single reusable suggester — `didYouMean(input, candidates, { max? })` in `src/aids.ts` — appends "` — did you mean \`X\`?`" (or "`\`X\` or \`Y\`?`" up to `max`, default 1) whenever a bad NAME is a genuine typo of a valid one, and appends nothing otherwise. It is **typo-only**: a case-insensitive edit distance under a length-scaled budget (`suggestionBudget(len) = min(3, max(1, floor(len/3)))`, exposed alongside the lower-level `nearest(input, candidates, budget?)` primitive), so a short word tolerates one edit and a long one up to three — never a false match on an unrelated word. It powers, uniformly:
- **schema-enum** failures — a near-miss `op` / `dir` / `nulls` / function-name / Type-name / field-name value gets the canonical spelling appended to `expected <label>: <allowed>` (e.g. `"op": "notlike"` → "… like, notLike, ilike — did you mean `notLike`?"), and the union-no-match `kind` suggestion (`nearestKind` now just calls `nearest`);
- **validation** (`validateWalk`) unknown-name diagnostics — **field** (`ref` / `filters` / `relation-path` / `semantic` / `text-search` / `text-score` / `excluded` / `insert` / `update`, suggested from the resolved Type's field names), **source** (suggested from the bound source names in scope, via the new `QueryScope.sources()` accessor — every source bound anywhere up the chain), **Type** (`insert` / `update` / `delete` / `source` / relation-target, from the registry's Type names), **relation segment** (a non-final `relation-path` hop, from the current Type's RELATION field names specifically), **function** (`function-call` / `aggregate` / `window` / `tabular`, from the registry's function names of that shape), **named-arg** (from the function's declared param names), and **output** (`output` ref, from the SELECT's output field names). Candidates are gathered only when the error is emitted, so there is no hot-path cost.

**Tuning the report.** `buildQueryTool(engine, { report })` forwards a `FormatProblemsOptions` (`{ contextLines?, sectionHeaders?, lineNumbers?, maxProblems? }`) straight into `formatProblems`, so a caller can shape the diagnostics the model sees. Absent ⇒ the defaults (`contextLines: 2`, section headers + the `N │` line-number gutter on). E.g. `{ contextLines: 0 }` drops the surrounding context (just the underlined line), `{ contextLines: 4 }` widens it, `{ lineNumbers: false }` drops the gutter, and `{ maxProblems: 3 }` caps how many problems render.

### Owned structural parser (zod-free, accumulating) — the ACTIVE gate

A model-authored query is now gated by ONE structural authority, the owned parser: `parseQueryInput` (in `src/llm/tool.ts`) validates the `{ query }` envelope without zod, then calls `registry.parseCheckedQuery(queryDef, problems)` — the zod-free STRUCTURAL parse — and, only if it is structurally sound, runs the owned `validateWalk` SEMANTIC check. Both halves have the properties we want: they NEVER throw and ACCUMULATE every problem in one pass. **Zod is demoted to the model-facing WIRE schema only** — `buildQueryTool` still exposes `querySchema` / `buildSchemas` as the tool's `schema` (what the model emits against, and what `compile` / strict mode consume), but it is NO LONGER a validator: the `schema.safeParse` gate and its zod-issue flattening (`problemsFromZod` / `flattenZodIssues`) are gone. The **`src/shape/` combinator module** is the machinery that let each expr/query OWN its shape validation the same way it owns its semantics.

A `Shape<T>` is a tiny structural schema: `check(json: unknown, ctx): T | INVALID`. It validates the untrusted `json` at the caller's current `Problems` path, RECORDS any problems (reusing `aids.ts` — `aidInfo` for the domain label, `didYouMean` for suggestions — never Zod, never `flattenZodIssues`), and returns the built value or the `INVALID` sentinel. It MUST NOT throw. Combinators: `lit` (a `kind` discriminant), `str` / `num` / `int` / `bool` / `scalar` (typeof / `Number.isInteger` guards → aid-directed `expected <label>, got <received>`), `enumOf` (membership → `expected <label>: a, b, c` + a `didYouMean` tail), `obj` / `optional` / `list` / `record` (composites — `record` is the named-argument map `{ [name]: value }`, returning an insertion-ordered `Map` to mirror `parseNamedArgs`), and the reference combinators `exprRef` / `queryRef` / `queryDefRef` / `sourceRef` (child-expr / child-query / raw-query-def / child-source slots, each defensively dispatched via the registry). **Accumulation, no throwing:** `obj` / `list` / `record` check ALL of their fields/elements before deciding — they never early-return on the first bad one — so a single `check` surfaces multiple problems in one pass (e.g. a `comparison` with a bad `op` AND a non-object `left` yields BOTH the `op` enum problem and the `left` not-object problem, each localized under its own path). Cross-field rules that a plain `obj` can't express (e.g. `logical`'s `not`-arity, or `in`'s list-vs-subquery dispatch) live in a thin hand-written `Shape` wrapper around the base `obj`.

**Perfect type-safety, no casts.** The only `unknown` is the untrusted `json`, always narrowed by a type guard. `obj` is fully typed with NO `as`: rather than the usual `fields: Record<string, Shape<unknown>>` (whose indexed access erases each field's value type, forcing a cast in the assembler), the generic is INVERTED — `F` is the BUILT-VALUE record and the field map is the mapped type `{ [K in keyof F]: Shape<F[K]> }`, so `fields[key].check(...)` returns exactly `F[K] | INVALID`; the partial accumulator is promoted to the complete `F` for `build` by a user-defined completeness type GUARD (`acc is F`), not a cast.

Three DEFENSIVE dispatches — the zod-free parallels to `parseExpr` / `parseQuery` / `QuerySource.from` — walk the whole tree: `Registry.parseCheckedExpr(json, problems)`, `Registry.parseCheckedQuery(json, problems)`, and `Registry.parseCheckedSource(json, problems)`. Each mirrors its throwing twin but records problems (`shape.not-object` / `shape.missing-kind` / `shape.unknown-kind` with a `didYouMean` over the real kinds) and returns the built `Expr` / `Query` / `QuerySource` or `undefined`, dispatching to each class's owned `static SHAPE` (query dispatch auto-includes every registered class that declares one; source dispatch reads `QuerySource.SHAPES`, keyed by the four source kinds). Each `SHAPE` builds a value `.toJSON()`-equal to the existing `from(def)` output on a valid def; the SEMANTIC checks (comparability, arg types, aggregate placement, source duplicates, write-model, unknown names) stay in `validateWalk`.

The recursion is completed by four child-slot combinators alongside `exprRef`: **`queryRef`** (a parsed `Query` child — the set-operation arms, CTE bindings, subquery sources, `INSERT … SELECT`), **`queryDefRef`** (a subquery kept as a raw `QueryDef` — the value-position `subquery` / `exists` / `in`-subquery exprs re-parse it lazily, so it validates through `parseCheckedQuery` but returns the normalized `toJSON()` def), and **`sourceRef`** (a `QuerySource` child — a SELECT's `from`). The small building blocks are shared shapes in `queries/_shape.ts`: `selectFieldShape` (`{ expr, as? }`), `fieldValueShape` (`{ field, value }`), and `boundShape` (a limit/offset — a literal integer or a `{ kind:'param' }` def); `QueryOrder.SHAPE` and `QueryJoin.SHAPE` cover an ORDER BY term and a JOIN clause.

**The whole query tree now parses through the owned parser.** Expr kinds with a `static SHAPE`: the C1 exemplars (`comparison`, `field-ref`, `literal`, `param`, `logical`) + the C2 operators/predicates/functions/refs (`binary`, `unary`, `is-null`, `between`, `case`, `aggregate`, `window`, `function-call`, `relation-path`, `array-op`, `output`, `excluded`, `text-search`, `text-score`) + the C3 finishers: `subquery`, `exists`, `in` (BOTH forms — its `SHAPE` dispatches on `in`: an array → the list form, an object → the subquery form via `queryDefRef`), `semantic` (whose `query` shape dispatches over the string / `param` / `{source,field}` / `{type,field}` forms), `tabular-function-call`, and `filters`. Query kinds with a `static SHAPE`: `select`, `insert` (incl. `onConflict`), `update`, `delete`, `union` / `intersect` / `except` (three `lit(kind)`-anchored shapes over the shared `SetOperationQuery`), `cte` (its entry shape structurally discriminates the plain vs recursive binding), and `expr`. Source kinds: `type`, `aliased`, `subquery`, `function`. Cross-field rules a plain `obj` can't express (e.g. `logical`'s `not`-arity, `in`'s list-vs-subquery dispatch, `cte`'s entry discrimination) live in a thin hand-written `Shape` wrapper around the base `obj`. An end-to-end test parses a complex SELECT (joins + where + groupBy + having + subquery + aggregate) to a `Query` `.toJSON()`-equal to the throwing `parseQuery`, and a SELECT malformed across several clauses surfaces every problem in ONE pass.

**This is the ACTIVE structural gate (C4 flipped).** `parseQueryInput` gates on `parseCheckedQuery` and feeds the sound result to `validateWalk`; the zod `safeParse` structural authority (and `problemsFromZod` / `flattenZodIssues`) has been retired. Zod remains ONLY the model-facing wire schema (`querySchema` / `buildSchemas`), unchanged. This is the intended structure-vs-semantics split: the owned parser accepts any registered kind + any string field, and unknown types / fields / functions are caught downstream by `validateWalk` with the existing aid-directed + `didYouMean` semantic messages.

### Compact tool-call schema (shared `$defs`)

The model-facing JSON-Schema (what `z.toJSONSchema` — and core's `compile()` — emit from `querySchema`) is **structurally factored**: the largest repeated fragments are built ONCE per schema-generation (a `SchemaCache` threaded on `SchemaOptions.cache`) and REUSED by identity everywhere they occur, so the converter emits each as a single `$def` + `$ref`s instead of inlining every copy. Factored fragments: each Type's **field-name enum** (`$def` `Fields_<Type>`, shared by field-ref / relation-path / order / group-by / having / filters / text-search / semantic), the shared **`param`** expr, the reused **`Limit`** (number-or-param), and — the biggest win — the per-function **typed-args** blocks, keyed by argument SIGNATURE so the 100+ builtin functions (which collapse to a few dozen distinct signatures — dozens share a lone `value` arg) reuse one `$def` each. Names come from each shared fragment's `aid`, stamped as `meta.id` (`Fields_user`, `param`, `Limit`, `Args…`) so `z.toJSONSchema` factors AND names them; the ids are salted per schema-generation to stay unique in zod's process-global registry. This is a pure size/structure win — the schema accepts and rejects exactly the same queries with the same aid-directed diagnostics (a golden invariance test guards that), only smaller: on the bundled example fixture the minified `z.toJSONSchema` drops from **21.3 KB → 20.2 KB** (`open`) and **105.6 KB → 95.5 KB** (`paired`), the paired reduction concentrated in the field enums + typed-args (the ~100 genuinely-distinct per-function branches of `typed` mode are irreducible). A size-threshold test catches any regression that re-inlines the shared fragments.

## Self-describing the engine to a model

The `describe*` helpers render a compact, promptable capability summary (plain text, deliberately terse to protect the context budget):

- **`describeEngine(engine, { types?, functions?, maxExamples? })`** composes ONE block a model can read to know everything it may use: every (supplied) Type, then `describeExprs`, then `describeFunctions`, then `describeQueryExamples`, then `describeDialects`. `functions` narrows both the expr gating and the function listing to the schema's selection; `types` narrows the Type list + gating; `maxExamples` caps how many WORKED examples render PER function / node (default `DEFAULT_MAX_EXAMPLES` = 2; `0` omits examples). It no longer needs a separate example-text call — worked examples now live ON the nodes/functions (see below) and are folded in here.
- **`describeExprs(engine, types?, functions?, maxExamples?)`** lists the CAPABILITY-GATED expression kinds — one `kind — INSTRUCTIONS` line per kind actually usable for the current Types/functions, filtered by the SAME gate the schema uses (`exprKindApplicable`), each followed by up to `maxExamples` `e.g. <json>` lines from the kind's `static EXAMPLES`. The always-usable core is never gated; `semantic` / `text-search` / `text-score` / `array-op` / `relation-path` / `tabular-function-call` appear only when an eligible Type/function exists (`excluded` / `output` are position-only and never listed).
- **`describeFunctions(engine, functions?, maxExamples?)`** renders each function as `name(a, b?): output — instructions` (named params, a trailing `?` marks optional), grouped by shape, each followed by up to `maxExamples` `e.g. <json>` lines from the function's `examples`.
- **`describeQueryExamples(engine, maxExamples?)`** renders a query-examples section: each registered query KIND that ships `static EXAMPLES` (SELECT, UNION/INTERSECT/EXCEPT, WITH/CTE) as `kind — INSTRUCTIONS` plus up to `maxExamples` worked example queries. Query-level constructs have no expr-catalog entry, so they get their own section.
- **Worked examples are a shipped, first-class surface.** Every `FunctionDef` may carry `examples?: readonly string[]` (RAW JSON strings — expr fragments or full queries that CALL it), and every Expr/Query node class may carry a `static readonly EXAMPLES?: readonly string[]` (plus, for query kinds, an optional `static INSTRUCTIONS`). Examples are TYPE-AGNOSTIC (illustrative generic source/field names like `event.score` / `user.name`) — they teach SHAPE while the catalog supplies the caller's real Type names. The shipped high-confusion set: the window family (`rank` / `denseRank` / `lag` / `lead` / `firstValue` / `lastValue` / `nthValue` / `cumeDist`), `dateTrunc` / `age` / `replace`, `count`; and the `window` / `exists` / `in` / `subquery` / `function-call` exprs and `select` / `union` / `cte` queries. This is the ONE source of truth — `describeEngine` only renders them. A structural test parses EVERY shipped example through a bare `createRegistry()`'s `parseCheckedQuery` / `parseCheckedExpr` and asserts zero problems.
- **Generated Type / Field docs.** `describeType` / `describeField` always emit a short `label` + long `description`: the developer's `TypeDef.label` / `FieldDef.description` when set, otherwise a sensible default GENERATED on demand from the meta-model — a Field from its FieldType (kind, bounds, `sensitive` / `semantic` / `search` flags, array item/bounds, a relation's `to` + `count` → belongs-to / has-many, nullability), a Type from its name + field/relation/index summary. Read the (possibly-generated) pair directly with `fieldMeta(field)` / `typeMeta(type)` (`{ label, description }`); nothing mutates the stored def — the strings are computed fresh per call.
