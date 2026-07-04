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

For **every** case it: parses + validates the oracle against the engine, runs it
**twice** (asserting deterministic results), and asserts the result is
**non-degenerate** (well-formed, non-empty, all values defined). Refusal cases
assert that the illegal write **does** fail validation. It **exits non-zero** if
any oracle is invalid, degenerate, or non-deterministic — so if you change the
data or an oracle, this is the gate that tells you the fixture is still coherent.

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
`tool.parse`, runs it, and compares the rows against `engine.run(oracle)`. It
prints a per-case `PASS`/`FAIL` line + a summary (pass rate, by category) and
writes `report.json` + `report.md`.

Without a key **and** without `--check`, it prints how to run and exits 0.

## How a case works (and why it's trustworthy)

Every case is an `EvalCase` (see `cases/types.ts`):

```ts
interface EvalCase {
  id: string;
  category: string;
  request: string;                                   // the NL prompt the model sees
  oracle: (engine) => QueryDef | Query;              // a hand-written CORRECT query
  expect?: 'rows' | 'refusal';                       // default 'rows'
  match?: 'set' | 'ordered';                         // default 'set'
  floatTolerance?: number;                           // default 1e-6
  note: string;                                       // which trap it exercises
}
```

The golden rule: **the expected answer is never hand-guessed.** It is
`engine.run(oracle)` — so the expected values are always **derived from the
data**. A case author only writes the `request`, the minimal correct `oracle`,
and a `note` explaining the trap.

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
Type (`currency` is reference data; `payment` is an append-only ledger). For
these, `expect: 'refusal'` and the `oracle` is the **illegal** statement that must
**fail validation**. `--check` asserts it does; the LLM eval passes when the
model's attempt is rejected (or is not a write to the protected Type).

## Adding cases

1. Add an `EvalCase` to the relevant `cases/<category>.ts` (or create a new
   category file and register it in `cases/index.ts`). Ids must be globally
   unique.
2. Write the **minimal, obviously-correct** `oracle`. Prefer explicit filters and
   `e.*` builders. A few idioms this schema requires:
   - filter a relation by the target's id via a relation path (the field is the
     CLEAN relation name, not the hidden FK column):
     `e.eq(e.path('salesOrder','customer','id'), e.value(1))`;
   - compare a `date` field against a date-typed literal built with `makeDate`:
     `e.gte(e.ref('salesOrder','orderedAt'), e.makeDate(e.value(2026), e.value(1), e.value(1)))`.
3. Write a `note` naming the **trap** the case exercises.
4. Run `npm run integration:check` until green (it will reject a wrong oracle or a
   degenerate result).

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
  LLM-emitted query def, the parse/validation diagnostics (formatted report +
  structured problem codes), `ran` / `passed`, expected/actual summaries, the
  mismatch diff, any thrown error, `durationMs`, and an ISO `timestamp`.
- `logs/failures.md` — a concise human-readable list of only the failures (id,
  request, emitted query, problem/diff) for fast iteration.

Both are overwritten each run (a latest-snapshot for iteration).
