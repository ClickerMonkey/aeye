# `@aeye/query` integration / eval harness

A natural-language → structured-query **integration and evaluation harness** for
`@aeye/query`. It is deliberately **separate** from the unit tests:

- it lives in `integration/` (NOT under `src/`, and no `*.test.ts` files), so
  **vitest never collects it** (`include: ['src/**/*.test.ts']`) and it has **zero
  effect on the 100% coverage gate** (`coverage.include: ['src/**/*.ts']`);
- `npm run typecheck` (the src build, `tsconfig.json → include: ["src"]`) does not
  see it either — the harness has its **own** `integration/tsconfig.json` that
  extends the package base and type-checks independently;
- it only calls a **real LLM** when `OPENROUTER_API_KEY` is set. Without a key you
  can still fully validate the fixtures with `--check`.

## What's here

| Path | What it is |
| --- | --- |
| `model.ts` | A made-up but coherent **20-Type ERP** (the conceptual schema the LLM sees) + `buildEngine()` wiring an in-memory `QueryEngine` over the JSON data. |
| `data/*.json` | Deterministic, referentially-consistent fixture rows, one file per Type. Physical foreign-key columns are **snake_case** (`customer_id`, `order_id`, `parent_id`, …) — hidden from the schema and mapped by relation-join backing. |

### Relation-join backing (clean names, hidden physical FKs)

Every belongs-to relation FIELD carries a **clean, LLM-facing name** (`customer`,
`order`, `product`, `category`, `parent`, `salesRep`, `warehouse`, `vendor`,
`department`, `invoice`, …) — the physical foreign-key COLUMN it actually joins
on stays hidden in `FieldBacking.relation` (see `buildBackings` in `model.ts`).
The generator emits those columns as snake_case (`customer_id`, `order_id`, …);
the name convention alone would NOT resolve the joins (there is no `customer`
column), so the backing is what makes them work. A materialized inverse has-many
(`customer.salesOrders`, `category.children`, …) reuses the same physical FK.

Two richer forms are exercised for realistic coverage:

- a **composite FK** on `salesReturn.invoice` — its `ON` ANDs *two* physical key
  pairs (`sales_order_id` **and** `customer_id`), matching the invoice for the
  same order and customer (`join-return-matching-invoice`);
- a custom **`on`** (a dual `expr` predicate) on `salesOrderLine.order`, matching
  the hidden `order_id` → salesOrder `id` in both SQL and the in-memory runtime
  (`agg-line-total-order17`, `join-lines-eu-3hop`).
| `data/generate.ts` | The deterministic generator that writes those JSON files (no randomness). |
| `cases/*.ts` | The seed evaluation cases, one file per category, concatenated by `cases/index.ts`. |
| `run.ts` | The runner: `--check` self-validation, the LLM eval, the comparator, and logging. |
| `logs/` | **Gitignored** per-run diagnostics (see below). |

## Running it

### `--check` — validate the fixtures (no key needed, CI-safe)

```bash
npm run integration:check
```

This is the **free fixture gate** — it never calls an LLM. For **every** case it
asserts:

- the case declares **≥1 assertion**;
- the case declares **≥1 `'error'`-severity (correctness) assertion** — with
  structure now advisory `'warn'` (see below), a structural-only case would
  otherwise pass vacuously. A `resultOf` / `rowCount` / `rows` / `refused`
  (all default `'error'`) satisfies this, or promote a structural one with
  `a.require(...)`;
- every `a.resultOf` **oracle** parses + validates against the engine, runs
  **twice** (deterministic), and is **non-degenerate** (well-formed, non-empty,
  all values defined);
- every `a.refused(sample)` **sample FAILS validation** (the illegal write really
  is rejected).

It **exits non-zero** if any oracle is invalid / degenerate / non-deterministic
or any refusal sample wrongly validates — so if you change the data, an oracle,
or a refusal sample, this is the gate that tells you the fixtures are still
coherent. (The purely STRUCTURAL assertions are only evaluated in the LLM eval,
where there is a model query to inspect.)

### Filter flags (cheap iteration)

Both `--check` and the LLM eval accept filters so you can run a subset instead of
the whole suite (handy when iterating on one failing oracle, and essential for
keeping paid LLM runs small). They compose in the order `--only` → `--category`
→ `--limit`:

| Flag | Effect |
| --- | --- |
| `--only <id[,id...]>` | Run only these case ids (comma-separated). Errors if an id matches nothing. |
| `--category <cat[,cat...]>` | Run only cases in these categories. Errors if a category matches nothing. |
| `--limit <N>` | Run only the first `N` cases (after the other filters). Must be a positive integer. |

```bash
# validate just one oracle
tsx integration/run.ts --check --only agg-avg-paid-order
# all the array + window cases
tsx integration/run.ts --check --category array,window
# smoke-test the first 5
tsx integration/run.ts --check --limit 5
# same flags apply to the paid LLM eval
OPENROUTER_API_KEY=… tsx integration/run.ts --only fn-window-lag
```

### The LLM eval (needs a key)

```bash
OPENROUTER_API_KEY=… npm run integration
# optional: pin the model (default openai/gpt-4o via OpenRouter)
OPENROUTER_API_KEY=… QUERY_EVAL_MODEL=anthropic/claude-3.5-sonnet npm run integration
```

For each case it builds the query tool (`buildQueryTool`), asks the model for a
structured query (prompt informed by `describeEngine`), parses it with
`tool.parse`, and then evaluates **every assertion** the case declares (see
below). The eval is **correctness-primary**: the case **passes iff every
`'error'`-severity assertion passes**. `'warn'` (structural) assertions are still
evaluated + **logged** (a failing one shows as `⚠ … (warn)`) but never fail the
case — a query that returns the RIGHT rows via a different construct passes. It
prints a per-case `PASS`/`FAIL` line (the failing error assertions + any warn
shapes that differed) + a summary (pass rate, by category) and writes
`report.json` + `report.md`.

Without a key **and** without `--check`, it prints how to run and exits 0.

## How a case works (severity-weighted assertions)

Every case is an `EvalCase` (see `cases/types.ts`) that declares a LIST of
`Assertion`s (see `cases/assert.ts`). Each assertion has a **severity**, and the
case **passes iff every `'error'`-severity assertion passes**:

```ts
interface EvalCase {
  id: string;
  category: string;
  request: string;   // the NL prompt the model sees
  note: string;      // which trap / discriminator it exercises
  assert: Assertion[];  // ≥1 assertion, ≥1 of them 'error'-severity
}
```

### Severity: correctness is primary

Every assertion is `'error'` (a **correctness gate** — fails the case) or
`'warn'` (**advisory** shape — evaluated + logged, never fails):

- **RESULT** checks (`resultOf` / `rowCount` / `rows`) and `refused` default to
  **`'error'`** — the rows (or the refusal) are what actually matter.
- **STRUCTURAL** checks (`groupBy` / `joins` / `cte` / `setOp` / `orderBy` /
  `aggregate` / …) default to **`'warn'`** — a query that returns the CORRECT
  rows via a **different construct** still PASSES; the differing shape is logged
  (`⚠ joins → customer (warn)`) so it stays visible.

Flip the default when you need to:

| Builder | Effect |
| --- | --- |
| `a.require(assertion)` | promote to `'error'` — when the SHAPE genuinely matters (a structural-only case, or an OR-group that must hold). |
| `a.warn(assertion)` | demote to `'warn'` — advisory only. |
| `a.anyOf(...assertions)` | an OR-group: passes if **ANY** child passes (for "N valid approaches", e.g. `a.anyOf(a.cte(), a.subquery())`). `'warn'` by default (`a.require(a.anyOf(...))` to gate); `needsResult` = any child needs a result; the matched child is recorded in the log. |

**Every case must carry ≥1 `'error'` assertion** (enforced by `--check`) — else,
with structure advisory, it would pass vacuously. Most cases satisfy this with
their `resultOf`; refusal cases with their `refused`.

The assertions mix **two dimensions**:

- **STRUCTURE** — did the model build the right SHAPE? These walk the model's
  emitted query def (`query.toJSON()`) and never run it, so they isolate
  "understood the request" from "the numbers happened to line up".
- **RESULT** — do the rows match a hand-written, obviously-correct ORACLE? The
  golden rule still holds for every `a.resultOf` oracle: **the expected answer is
  never hand-guessed** — it is `engine.run(oracle)`, always **derived from the
  data**.

### The `a.*` assertion vocabulary

Structural (read the def; **default `'warn'`**; fail cleanly if the model produced no valid query):

| Builder | Passes when… |
| --- | --- |
| `a.kind(k)` | the top-level query `kind === k`. |
| `a.from(type)` | the SELECT's `from` binds Type `type` (or a join lands on it). |
| `a.joins(to?)` | ≥1 relation traversal (explicit join **or** `relation-path` hop); with `to`, some hop's resolved TARGET Type is `to`. |
| `a.filtersOn(field)` | a `field-ref` to `field` (or a `relation-path` ending in it) appears in a WHERE / HAVING / join-`and` condition. |
| `a.groupBy()` / `a.having()` | some select has a non-empty `groupBy` / `having`. |
| `a.aggregate(fn?)` | an `aggregate` expr appears (optionally `function === fn`, e.g. `'sum'`; `count(*)` is `'count'`). |
| `a.orderBy({ by?, dir? })` | a non-empty query-level ORDER BY; optionally a term referencing output/field `by`, and/or with direction `dir`. |
| `a.limit(n?)` / `a.offset(n?)` | a LIMIT / OFFSET is present; with `n`, a **literal** count `=== n` (a `param` satisfies the bare form but **not** `limit(n)`). |
| `a.distinct()` | some select has `distinct === true`. |
| `a.window(fn?)` | a `window` expr appears (optionally `function === fn`). |
| `a.setOp(op?)` | the tree contains a set operation (optionally exactly `op`). |
| `a.cte()` | the tree contains a `cte` (WITH) statement. |
| `a.subquery()` | the tree nests a sub-select (a derived-table `from`, an `in`/`exists`/scalar-`subquery` expr, or a CTE) — handy as an `a.anyOf` arm for "a CTE _or_ an equivalent subquery". |
| `a.selects(field)` | a select item projects `field` (a `field-ref` to it OR `as: field`). |
| `a.custom(describe, fn)` | `fn(queryDef, engine)` returns `null` (arbitrary structural predicate). |
| `a.refused(sample?)` | LLM mode: the model FAILED to parse/validate (a correct refusal). `--check`: the `sample`, if given, FAILS validation. |

Result (**default `'error'`**; `needsResult`; lazily run the model's query once, cached via `ctx.run()`):

| Builder | Passes when… |
| --- | --- |
| `a.resultOf(oracle, { match?, tolerance? })` | the model's rows equal `engine.run(oracle)` (`match` `'set'` default / `'ordered'`; numeric `tolerance` default 1e-6). |
| `a.rowCount(n)` | the model's query returns exactly `n` rows. |
| `a.rows(pred)` | `pred(rows)` returns `null` (custom row predicate). |

Structural assertions read the def by a single **walk** (`shapeOf` in
`assert.ts`) that collects every select / set-op / expr, the WHERE/HAVING/join
condition roots (and the field names they reference), the query-level ORDER BY
terms, LIMIT/OFFSET values, and the `from` sources + joins. `a.joins(to)` and
`a.from(type)` resolve a relation hop's TARGET Type through the engine registry
(a `relation-path`'s `source` → its Type, then each segment's relation `.to`).

The **data is designed so a wrong query returns a wrong answer** (see the header
of `data/generate.ts`): two same-named customers/products that differ by id,
rows just inside/outside quarter boundaries, cancelled/refunded/draft orders a
missing status filter would wrongly include, multi-line orders a wrong join grain
would double-count, an inactive customer/product, and a customer with no orders.

### Comparator

Results are normalized to `{ fields, rows }` as **positional tuples** (aligned to
each result's own field order, so the model's column aliases needn't match the
oracle's). Rows are compared as a **set** by default (sorted by a canonical key)
or **in order** when `match: 'ordered'` (top-N / ORDER BY). Numbers (money / avg)
compare within `floatTolerance`.

### Refusal cases (write-model)

Some requests should be **refused** because they mutate a read-only / append-only
Type (`currency` is reference data; `payment` is an append-only ledger) or a
locked FIELD (`customer.createdAt`, `product.id`). For these the case's only
assertion is `a.refused(illegalSample)`: the `illegalSample` is the illegal
statement that must **fail validation**. `--check` asserts it does; the LLM eval
passes when the model's attempt is rejected (produces no valid query).

## Adding cases

1. Add an `EvalCase` to the relevant `cases/<category>.ts` (or create a new
   category file and register it in `cases/index.ts`). Ids must be globally
   unique.
2. Pick the **structural** assertions (all default `'warn'` — advisory) that
   reflect what the request should produce — e.g. "top N by X" →
   `a.orderBy({ dir: 'desc' }), a.limit(N)`; "revenue by customer" →
   `a.groupBy(), a.aggregate('sum')`; "orders over $100 in Q2" →
   `a.filtersOn('total'), a.filtersOn('orderedAt')`; a join request →
   `a.joins(target)`; distinct/window/set-op/cte → the matching builder. When
   several constructs are equally valid, express it with
   `a.anyOf(a.cte(), a.subquery())`. If the SHAPE is genuinely the point (and the
   result can't pin it), promote it with `a.require(...)`.
3. Add `a.resultOf(oracle, { match, tolerance })` — the case's **`'error'`
   correctness gate** — with the **minimal, obviously-correct** `oracle` (or
   `a.refused(sample)` for a refusal, also `'error'`). Every case needs **≥1
   `'error'` assertion**; this is it. Prefer
   explicit filters and `e.*` builders. A few idioms this schema requires:
   - filter a relation by the target's id via a relation path (the field is the
     CLEAN relation name, not the hidden FK column):
     `e.eq(e.path('salesOrder','customer','id'), e.value(1))`;
   - compare a `date` field against a date-typed literal built with `makeDate`:
     `e.gte(e.ref('salesOrder','orderedAt'), e.makeDate(e.value(2026), e.value(1), e.value(1)))`.
4. Write a `note` naming the **trap** the case exercises.
5. Run `npm run integration:check` until green (it will reject a wrong oracle, a
   degenerate result, or a refusal sample that wrongly validates). The STRUCTURAL
   assertions are exercised by the LLM eval.

## Regenerating the data

```bash
tsx integration/data/generate.ts
```

The generator is fully deterministic, so the committed JSON is byte-stable. After
regenerating, re-run `npm run integration:check`.

## Logs (gitignored)

The LLM eval writes a per-run diagnostic trail under `logs/` (gitignored), keyed
by test id, so failures can be iterated on across runs:

- `logs/latest.json` — an object keyed by test id; each entry captures the raw
  LLM-emitted query def, any parse/validation error + problem codes, `passed`,
  the **per-assertion outcomes** (`describe` + `severity` + `passed` + `reason` +
  `matched` for `a.anyOf`), the model's own result summary, `durationMs`, and an
  ISO `timestamp`.
- `logs/failures.md` — a concise human-readable list of only the failures (id,
  request, trap, emitted query, the failing **error** assertions, and any
  advisory **shape warnings** that differed) for fast iteration.

Both are overwritten each run (a latest-snapshot for iteration).
