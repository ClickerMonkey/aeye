# `@aeye/query` changelog

Releases before `0.6.0` are recorded in the git log (`chore(release): @aeye/query <version>`
commits); this file starts here and is the place to look from now on.

## 0.6.5

Two asks raised by the consuming product's widget layer on `0.6.4`, both re-derived against
this source before anything was written. Additive: no exported name changed meaning, no
signature lost a parameter. What DOES change is the NUMBERS `cost` reports for a statement
that reads a derived source — see the consumer note under A18, because a budget that used to
pass one will now correctly refuse it.

### A18 — a derived source's cost was STRUCTURALLY zero, so no budget could fire on it (**P1**)

Every DERIVED source — a CTE name, a FROM subquery, a manually-joined subquery source — binds a
SYNTHETIC Type, and `syntheticType` built it `count: 0, bytes: 0`. The cost model reads
`Type.count` for a base scan and for a join's fan-out, so anything reading a derived source
estimated at zero. That is not a loose estimate: everywhere else the honest caveat is *"the
input is a `TypeDef.count` the author declared"*; here there was no input at all, and the number
was a hard zero nobody supplied.

The shape the product reported, over a `tiny` declaring `count: 10` and a `task` declaring
`count: 1_000_000`:

```
WITH touched AS (DELETE FROM tiny RETURNING id)
SELECT touched.id FROM touched INNER JOIN task ON true

  cost()                   {rows: 0, bytes: 0}          <- structural zero
  checkCost(maxRows: any)  PASS                          <- no cost budget could fire
  affected()               {rows: 10, types:[tiny=10]}   <- honest; the write IS ten rows
  delivers                 10_000_000 rows
```

Every gate passed it, correctly — and this is the one shape `autoPaginate` deliberately declines
to cap, because a `LIMIT` would truncate the receipt while the database ran the write to
completion. So a statement authorable today streamed ten million rows with no bound of any kind.

**Wider than filed, and worse without a `WITH`.** `syntheticType` is the common cause, so the
same hole is reachable through a plain derived table: measured on `0.6.4`,
`SELECT … FROM (SELECT … FROM task) x` — one million rows, no CTE — also costs `{rows: 0}`, and
a join over such a source fans out by `Math.max(1, 0)` = **1** instead of by its real
cardinality.

**Fixed** by giving `syntheticType` an optional third argument: the derived source's own
`outputCost`, i.e. the rows a reader of that name will scan and their width. `QuerySource`
supplies it for a subquery source and `CTEStatementQuery.bind` for each CTE name (entries bind
in order, so entry *i* is estimated with `0..i-1` already bound). Two related corrections fall
out of having the number at all:

- **A `cte` root's cost now adds every ENTRY's own work**, not just the `final`'s. An entry runs
  whether or not `final` reads it — `WITH t AS (SELECT … FROM million) SELECT count(*) FROM t`
  reads a million rows to produce one — and this package's runtime literally MATERIALIZES each
  entry's whole result in memory (`ctx.ctes.set(name, rows)`), so those rows are the most real
  cost the statement has. `outputCost` is unchanged: entries are work, not rows delivered.
- **A RECURSIVE entry is the seed plus `RECURSIVE_CTE_LEVELS` (4) expansions** of its arm, the
  arm costed with the CTE name bound to the seed's size. The fixpoint depth is data-dependent
  and not statically knowable, so the model assumes a shallow hierarchy — an org chart, a
  category tree — rather than the runtime's 1000-iteration safety cap, which would refuse every
  ordinary closure under any budget. The point is that a recursive body is not FREE.

**`affected` now descends into EVERY nesting position.** Also recorded in the ask, and closed
rather than documented. It was implemented per kind, and the kinds that had it were the ones
someone remembered: measured on `0.6.4`, a data-modifying `WITH` reported `{rows: 0, types: []}`
from a FROM subquery, a joined subquery source, a `subquery` / `exists` / `in` subquery in any
clause, a set-operation arm, and an `insert … select` source. Postgres refuses a data-modifying
`WITH` below the top level, so most of those are not live against a database — but they ARE live
against this package's own in-memory runtime, which executes each nested statement for real (the
test deletes rows through a FROM subquery to show it). The fix is structural: every kind declares
its nested statements once (`Query.forEachNestedQuery`, with expr-carried ones free via the new
`Expr.nestedQueryDef` hook, beside `fieldRef` / `orOperands` / `functionRef`), and `affected` is
the sum over that enumeration plus the statement's own target. A position added later is counted
by declaring itself. Two things came along with it: `walkExprs` is now implemented for
`insert` / `update` / `delete` (its doc always claimed DML walked its `set` / `where` /
`returning`; it walked nothing), and a `cte`'s per-Type breakdown is now in document order
(entries, then `final`) instead of `final`-first. `rows` is unchanged.

**And a performance fix the change forced, which also repays a pre-existing debt.** Sizing a
derived source makes BINDING non-trivial, and each level binds its inner statement twice (once
for its FIELDS, once for its SIZE), so nesting became exponential — 20 nested `WITH`s took
**40s**. Binding is a pure function of `(query, engine, scope)` that mutates nothing, so it is
now memoized per scope (`ScopeMemo`) on `SelectQuery` and `CTEStatementQuery`. That is linear
again — 200 levels in ~2ms — and it also fixes an exponential that was there BEFORE this
release: 20 nested FROM subqueries took 722ms on `0.6.4` (they resolved the same subtree 4× per
level) and now take ~1ms.

**Consumer-visible, and deliberately so:** `engine.cost` / `checkCost` report real numbers for a
`cte` or a derived table where they reported `{rows: 0, bytes: 0}`, so a `maxRows` / `maxBytes`
budget that silently passed such a statement will now refuse it — which is the entire ask. One
fidelity note stated rather than hidden: those estimates are taken with `engine.neutralCost` (a
new per-engine `CostContext` with no execution-time `filters` / `sort` / `params`), because
those selections belong to the ENCLOSING query and do not reach inside a derived table — and one
shared identity is what makes the memoization hit. The consequence is that a `LIMIT` bound to a
PARAM *inside* a CTE body / derived table is estimated UNCAPPED (the conservative direction); a
bound on the statement's own `final` still resolves, since that is costed with the caller's real
context.

### A19 — an aggregate did not declare HOW ITS VALUES MERGE, and `DISTINCT` was not on the resolved output at all (**P2**)

The consumer is a visual that cannot draw every group and folds the tail into a residual — a
pie's *Other* slice, a cross-tab's *Other* row and column. A residual is only honest if it is the
true value **over the groups it replaces**, so the widget layer has to answer *"given one value
per group, what is the value over all of them?"*. That is a property of the FUNCTION, and nothing
on the wire carried it; the only alternative was a hard-coded per-function table in every
consumer, which is wrong the moment a caller registers an aggregate of its own.

Worked, because the wrong answers are plausible: four owners, `avg(hours)` per owner, the visual
draws two and folds Cy (1 row, 10 hours ⇒ avg 10) and Dee (9 rows, 18 hours ⇒ avg 2). The
residual is `(10 + 18) / 10` = **2.8**. Adding the cells gives **12**; averaging them gives
**6**. Both are numbers a reader accepts without hesitating, and the input that would fix it —
each group's row COUNT — is not in the result at all.

**Added `FunctionDef.merge`** (`AggregateMerge` = `'sum' | 'min' | 'max' | 'and' | 'or' |
'none'`): the operation `⊕` for which `f(A ∪ B) = f(A) ⊕ f(B)` holds for EVERY partition.
Builtins declare `count`/`sum`/`countIf` ⇒ `'sum'`, `min`/`max` ⇒ `'min'`/`'max'`,
`boolAnd`/`boolOr` ⇒ `'and'`/`'or'`. `avg`, `stddev`, `variance`, `stringAgg` and `arrayAgg`
declare NOTHING, deliberately — the first three need each group's weight and the collectors need
a separator/ordering a pair of values cannot supply. Absent ⇒ `'none'`, so an aggregate whose
author said nothing is treated as un-mergeable and a consumer fails SAFE. Declarable only on an
`aggregate` shape; resolving one that is not throws, exactly as an unknown output Type does,
rather than ignoring the key.

**And `DISTINCT` now survives resolution.** `AggregateExpr.resolve` returned
`{...base, nullable, aggregate: true, aggregateFn}` — so `count(hours)` and
`count(DISTINCT hours)` produced BYTE-IDENTICAL output fields (same fieldType, same nullable,
same `aggregateFn`, same single source) while emitting different SQL and answering different
questions. `ComputedResolved` gains two fields, present on exactly the nodes `aggregateFn` is:

- **`aggregateDistinct`** — was the call `DISTINCT`? (`false` is an answer, so it is not omitted.)
- **`aggregateMerge`** — the merge of THIS CALL: the declared operation with the DISTINCT rule
  already applied. `count(x)` ⇒ `'sum'`; `count(DISTINCT x)` ⇒ `'none'`, because de-duplication
  is GLOBAL and two such values cannot be added; `min(DISTINCT x)` ⇒ `'min'`, because min / max /
  and / or are idempotent and DISTINCT cannot change them. Resolved here rather than left to the
  consumer, because the browser holds no engine: neither the registry lookup nor the call is
  available on the far side of the wire. `mergeOfAggregateCall(declared, distinct)` is exported
  for anyone who wants to apply the rule themselves; it is total over the vocabulary and over
  `undefined`.

Found while implementing it and fixed here: **`count(*)` with `distinct` emitted
`count(DISTINCT *)`**, which is a syntax error on every dialect, while the runtime deliberately
ignored the flag for the arg-less form. Emit and run now agree — `validateWalk` reports
`aggregate.distinct-no-args` (DISTINCT de-duplicates argument VALUES and there are none), and
emission drops it so a caller that emits without validating still produces valid SQL.

## 0.6.4

One ask from the consuming product's adoption of `0.6.3`.

### A17 — `params()` reported a paged `cte` as taking NO params (**P1, unbindable statement**)

`Query.params()` is what a caller (and, downstream, a stored query fn) uses to DECLARE the
arguments a statement takes. Measured on `0.6.3` against the same two-param window:

```
autoPaginate(select).params(engine)   →  ['limit', 'offset']
autoPaginate(cte).params(engine)      →  []                    ← the same two params, on `final`
toSQL(autoPaginate(cte), { params: {} })
   →  WITH "recent" AS (…) SELECT … LIMIT ? OFFSET ?      params: [null, null]
```

A REPORTING gap, not an emit gap, which is what made it quiet: the SQL is right and the
description of the SQL is wrong. A caller who faithfully bound exactly what `params()` declared
got `LIMIT NULL OFFSET NULL` — which Postgres reads as *no limit, no offset*, i.e. the whole
table, with no error anywhere. Downstream a paged `cte` became a query fn with no `limit`
argument: unbindable, and unpageable by its caller.

**Root cause, and why it was never `cte`-specific.** `params()` ran the validation walk (which
populates the shared `ParamSet`) and then called `this.observeBoundParams(s.params)` **on the
root only**. A `limit` / `offset` bound lives OUTSIDE the walked expr tree, so that hook was the
only thing that ever saw one — and it was invoked at exactly one node. `cte` is where it was
reported, but **nothing below the root was observed**: measured on `0.6.3`, a bound on a
set-operation arm, a FROM subquery, an `in` / `exists` subquery, a CTE body, and a nested `cte`
all reported `[]` while emitting `LIMIT ?`.

**Fixed** by deleting the root-only hook and moving the observation into each owning kind's own
`validateWalk` — the walk that already recurses into every one of those positions, with one
`ParamSet` shared across the whole scope chain. The invariant is now local and self-evident:
**the kind that EMITS a row bound is the kind that observes it**, so there is no second traversal
to drift. `SelectQuery` and `SetOperationQuery` are the only kinds with a bound, and both now go
through the shared `Query.observeRowBounds` helper (which also removes the duplicated logic).

Found while tracing it, and fixed here because it is the same symptom one level worse:
**`InsertQuery.validateWalk` never walked its `select` at all.** An `insert … select` therefore
reported not just the row bound but **every** param inside the source query as absent (measured:
`params()` → `[]` for a source whose WHERE binds `$1`), and a bad reference inside it — an
unknown source, an unknown field — produced ZERO problems. The source is now validated in the
outer scope, with problems nested under `select`.

The guarantee is tested as a **property over query shapes** rather than as the one reported
example: for every shape (paged select / paged `cte` / nested `cte` / paged set operation / `cte`
over a paged set operation / a bound on a `cte` body, a set-op arm, a FROM / `in` / `exists`
subquery, a DELETE's `in` subquery, an `insert … select` source), binding EXACTLY the params
`params()` declares leaves no emitted bind slot null.

**Consumer-visible:** `params()` now returns MORE params for the shapes above — the ones the
emitter was already binding. A paged plain `select` is byte-for-byte unchanged, including report
ORDER (clause params still come first). An `insert … select` that was silently accepted with a
bad reference inside its source query now reports that error; it was never a valid statement.

---

## 0.6.3

Two asks from the consuming product's adoption of `0.6.2`.

### A15 — `includeTotal` projected `COUNT(*) OVER ()` inside every set-operation arm (**P0, wrong ROWS**)

`SqlContext.nonRoot()` — the boundary used for a CTE body and a set-operation branch —
propagated `includeTotal`, where the sibling `withPlanner()` (subquery / FROM subquery) cleared
it. A union emitted with `includeTotal: true` therefore looked like this:

```sql
(SELECT "task"."id", COUNT(*) OVER () AS "$total" FROM …)
UNION ALL
(SELECT "task"."id", COUNT(*) OVER () AS "$total" FROM …)
```

`$total` is a **projected column**, so it takes part in the set comparison. Measured downstream
against a real engine on two arms whose counts differ, `INTERSECT` returned **0 rows** (vs 2),
`EXCEPT` returned **the whole left arm** (vs 1), and `UNION` **stopped de-duplicating**. It
corrupts the rows, not merely the count, and it can over- or under-report. A CTE body paid the
same window aggregate with nothing selecting it. `run` and `toSQL` also disagreed: the in-memory
`run(union, { includeTotal: true }).total` was already `undefined`.

**Fixed** by clearing `includeTotal` at that boundary too, so `$total` is emitted **only on the
ENTRY query**. Whether a set operation's total should be a wrapped count or absent was decided in
favour of **absent** — it is what the in-memory engine already reported, and a missing number is
recoverable where a wrong one is not. Both engines now agree: a query whose entry is a set
operation reports no `total` and emits no `$total`. To page a set operation *and* count it, wrap
it in a SELECT over a `subquery` source and ask for the total there (documented in the README).

The invariant is now tested as a **property over query shapes** rather than an example — for
every shape (select / distinct / grouped / union / intersect / except / set-op nested in a set
op / CTE statement / CTE whose final is a set op / FROM subquery / IN subquery), the rows under
`includeTotal: true` equal the rows without it, and the emitted SQL projects `$total` at most
once. It fails at every nesting depth, not just the one that was reported.

**Consumer-visible:** a `toSQL(setOperation, { includeTotal: true })` that previously returned a
per-arm `$total` column now returns none. Any consumer workaround that refuses to request the
count for a top-level set operation can be deleted.

### A16 — `autoPaginate` had no failure channel (**P2**)

It was typed `SelectDef`-only, but its JSON branch simply spread whatever it was handed and set
`limit` / `offset` on the copy. Given a `CTEStatementDef` — reachable from the `QueryDef` union
or a cast — it returned a statement carrying two keys `CTEStatementDef` does not declare.
Measured: the parser **silently drops them**, `validate` reports zero problems, and the emitted
SQL has no `LIMIT` / `OFFSET` at all. The caller gets an object that looks paged, passes
`{ params: { limit, offset } }`, and reads the whole table. It was the one transform in
`src/transforms/` with no way to say "I cannot page this".

**Fixed** by defining it on the kinds that genuinely have a row bound, and refusing the rest:

- `select` — its own LIMIT / OFFSET (unchanged);
- `union` / `intersect` / `except` — the SET-LEVEL bound over the combined rows, never an arm's
  (paging an arm would change which rows the set operation compares). This already worked; it is
  now in the type and under test;
- `cte` — **newly supported**, paged through its `final` query (recursively). A `WITH` returns
  what its `final` returns; a CTE body is an intermediate result and is never paged;
- everything else (`insert` / `update` / `delete` / `expr`) throws `QueryTypeError` with code
  `paginate.unsupported-kind`, naming the offending kind.

Also new: `canAutoPaginate(query)` for callers holding an arbitrary `Query` / `QueryDef`, plus
the exported `PaginatableDef` / `PaginatableQuery` unions.

**Consumer-visible:** a call that previously returned a silently unpaged `cte` now returns a
correctly paged one; a call on a DML / expr query that previously returned a meaningless object
now throws.

---

## 0.6.2

Three asks from the consuming product's adoption of `0.6.1`. Two are defects that reach the
DATABASE with nothing upstream to catch them, and both shipped because the case was never
tested; the third closes a gap in what a resolved type tells a consumer:

- **A13** — `drillDown` projected the GROUP KEY twice for `SELECT key, count(*) … GROUP BY key`,
  the single most common shape a drill-down is generated from. Cosmetic, but universally visible.
- **A12** — a `json` PARAM bound to a JSON *scalar* emitted uncast, un-encoded SQL, which
  Postgres rejects at run time.
- **A14** — the APPLIED aggregate function never crossed the wire, so a consumer labelling a
  computed column had to infer it from the column's output NAME.

**None of the three is a breaking change.** A13 REMOVES a duplicate column from a drilled
projection (one consumer-visible note in its section); A12 turns a statement that failed at the
server into one that runs; A14 is purely additive. Nothing that worked before behaves
differently.

Also here: `date` / `timestamp` writes are now TESTED — they never were, which is A11's root
cause — pinned exactly as `0.6.1` shipped them. **A11 itself is NOT fixed**; see below.

---

## A13 — `drillDown` projected the group key TWICE (**P2, cosmetic but universal**)

Observed live, not derived: clicking a slice of a grouped pie chart opened a table with two
identical "Status" columns, and on mobile each card listed "Status todo" twice.

It falls straight out of step (3) of the algorithm. For `SELECT status, count(*) FROM task
GROUP BY status`:

- `status` is a plain non-aggregate — *"a group key / ref — survives unchanged"* — and is
  pushed as-is;
- `count(*)` is an arg-less aggregate, so `expandStar()` pushes **one `field-ref` per field of
  the FROM type** — which includes `status` again.

So the un-ravelled projection was `[status, …every column…]`, with the key duplicated for every
`count(*)`-over-a-grouped-key query. Nothing was *wrong* in the result — the rows are right and
the extra column is consistent — which is why it survived.

### What changed

`expandStar` now takes the set of canonical forms the SELECT **already projects itself** and
skips those fields. `drillDown` builds that set from the items that survive un-ravelling
UNCHANGED, out of the `colInfo` it already computes one block earlier for group-key matching.

The key is the **canonical form** (`canonicalize` / `exprDigest`), never the output NAME. Two
different expressions may legitimately project under one name, and the same expression may
carry an alias: `SELECT total AS "note", count(*)` deduplicated by NAME would have dropped the
star's real `note` column and kept `total` — the wrong column, silently.

Only the UNCHANGED survivors seed the set. An aggregate that un-ravels to a bare field is
re-aliased to the aggregate's own output name (`sum(total)` → `total AS "revenue"`), so
`SELECT key, count(*), sum(total)` still projects `total` twice — once as itself, once as
`"revenue"`. That is left alone deliberately: dropping either deletes a column NAME a caller
can read, and which one to keep is a presentation decision, not the transform's.

### What changes for an existing consumer

A drilled projection built from `count(*)` **no longer repeats** a column the SELECT projects
itself. A consumer that indexes the drilled `fields` array POSITIONALLY past the group key sees
the columns shift left by one per skipped field; one that reads by NAME is unaffected (and was
reading a duplicate name before).

---

## A12 — a `json` param bound to a SCALAR emitted uncast SQL (**P3, run-time failure**)

`writeCellSql` routed a write value through `Dialect.jsonValue` only when the VALUE was a
DOCUMENT. A JSON *scalar* — a bare string, a number, a boolean, each a legal value of a `json`
column — was bound raw:

```
json param <- {"a":1}           INSERT … VALUES ($1, CAST($2 AS jsonb))   params: ["x","{\"a\":1}"]
json param <- "a bare string"   INSERT … VALUES ($1, $2)                  params: ["x","a bare string"]
```

Postgres rejects the second (`column is of type jsonb but expression is of type text`). Not a
regression — `0.6.0`'s literal road bound it uncast too — but a run-time failure with nothing
before the server to catch it.

### The COLUMN decides, not the value's shape

Asking the value is the defect: only the write position knows the column, and only the column
can say what the cast has to be. `writeCellSql` now encodes-and-casts whenever the target column
is `json`, whatever shape the value has.

**A cast alone would not have fixed it.** `CAST('a bare string' AS jsonb)` is invalid JSON input
— one run-time error swapped for another — so the value must be JSON-ENCODED as well, which is
exactly the pair `Dialect.jsonValue` already applies (`"a bare string"`, `42`, `true`).

Three boundaries the fix holds:

- **SQL NULL stays SQL NULL.** A null literal is the documented — and only — way to write SQL
  NULL, and an unbound param binds NULL. Routing either through `jsonValue` would emit
  `CAST('null' AS jsonb)`, i.e. the JSON *value* `null`, a different thing in a `jsonb` column.
  A null is always left to `Expr.toSQL`.
- **An `array` column is NOT included.** A scalar is not a value of an array column at all, and
  there is no correct cast to emit (`CAST('x' AS text[])` is a syntax error), so it stays a
  VALUE problem — `write.type` on the literal road — not something emission can paper over.
- **A text column is untouched**: only a `json` target encodes.

Reachable only through a `param`, incidentally: a scalar LITERAL into a `json` column is already
refused at validation (`write.type`, via `JsonFieldType.comparableWith`), while a param is exempt
from that check because it takes the COLUMN's type and its value exists only at emit time. Both
roads are routed identically anyway — `toSQL` carries no guarantee that validation ran — without
loosening the refusal.

### What changes for an existing consumer

A `json` cell whose value is a JSON scalar now emits `CAST($n AS jsonb)` binding the JSON-ENCODED
text (`"a bare string"`, not `a bare string`). Statements that previously failed at the server now
run. A consumer asserting on the emitted SQL / params for that case must update; there is no value
for which working SQL became different working SQL.

---

## A14 — a resolved type now names the APPLIED aggregate (**additive**)

`ComputedResolved` — and so every `QueryField.type` a consumer reads — said only
`aggregate: true | false`. WHICH aggregate was applied lived on the live `AggregateExpr` and
never crossed the wire, so labelling a computed column meant recovering the function from the
column's OUTPUT NAME. That works for the common case, and soundly: `fieldNameOf` is
`as ?? (field-ref ? field : aggregate ? fn : col<i>)`, so an unaliased aggregate's output name
IS its function name, and the consumer then confirms that name against the function catalog.

But it is evidence rather than fact, with two dead spots:

- an **ALIASED** aggregate (`sum(hours) as total_hours`) cannot be recovered at all;
- a non-aggregate **aliased onto a function name** (`hours * 2 as count`) recovers a false
  positive that only the `aggregate` flag then rejects.

### `aggregateFn?: string`, a SIBLING — not `aggregate: false | string`

Both shapes were on the table and the sibling is the right one, for a reason beyond it being
the non-breaking option: **the two fields answer different questions.** `aggregate` is a
property of the whole SUBTREE — "does a group collapse happen in here?", which is what drives
placement validation and grouping — while the applied function is a property of exactly ONE
node. Folding them into `false | string` forces a meaningless value for every composite:
`max(a) - min(b)` genuinely IS an aggregate and genuinely has no single applied function, so
the union would have to re-admit `true`, ending up as `boolean | string` — strictly worse than
a sibling. Presence is then meaningful on its own: `aggregateFn` is set exactly when the value
IS one aggregate call.

`AggregateExpr.resolve` is the only writer, on both roads — including the unknown-function
fallback, where the resolution is a placeholder but the name is still the fact of what was
written. Nothing propagates it upward: `Function.resolveOutput` builds its `ComputedResolved`
fresh, and `WindowExpr` spreads that base while forcing `aggregate: false`, so `sum(x) OVER (…)`
reports neither — it is per-row and collapses nothing. A scalar `function-call` does not set it
either; this names the aggregate that was APPLIED, not any function that was called.

The key is OMITTED rather than set to `undefined` when there is no applied aggregate, so a
consumer serializing the resolved type across a boundary emits nothing rather than a null
column.

This is the same lesson as A13, one layer up: A13's drill-down dedupe keys on the canonical
form precisely because output names are unreliable, and this stops a consumer having to read
one.

### What changes for an existing consumer

Purely additive — a new optional property on `ComputedResolved`, and one optional trailing
parameter on the `computed()` builder. Every existing read of `.aggregate` keeps its meaning.

---

## A11 — temporal writes are now TESTED, and deliberately UNCHANGED

A9's `write.type` check compares a write value's category against its column's, and a
`LiteralExpr`'s category comes from the value's JS type — so it can only ever be `text` /
`number` / `bool` / `json` / `array`. **No literal is assignable to a `date` or `timestamp`
column**, and there is no third road: `LiteralExpr.resolve()` has no arm yielding a temporal type
and no `toDate` / `toTimestamp` builtin exists to wrap one. A `param` is the only cell shape that
writes a temporal column.

That shipped because **the suite never wrote a temporal column at all**. `0.6.2` adds
`src/__tests__/write-temporal-value.test.ts`, which states BOTH halves as they are today: the
param road works end to end, and every literal is `write.type`. It also records the fact that
makes this worth revisiting — the model-facing `writes: 'typed'` schema renders each cell as
`field.fieldType.toValueSchema() OR Expr`, and `DateFieldType.toValueSchema()` **is** an ISO-date
string, so the schema invites the model to emit exactly what the validator refuses. That is the
same schema ⇄ parser disagreement A9 closed for `json` / `array`.

**No behaviour changed.** Widening it is a real design decision — which values a temporal column
accepts as a literal, and whether "the column's own value schema is the authority" is applied to
every kind (for `json` it would flip `write.type` on `"not a document"` from refusal to
acceptance, weakening a shipped guarantee). So it stays open, and is now pinned rather than
untested.

---

## Tests

`src/__tests__/drill-down.test.ts` gains the A13 block. Its assertions with teeth are the exact
PROJECTION (a `toEqual` over the emitted expr defs, which a duplicate breaks) and the RUN's
reported `fields` — the list a consumer actually renders, and where the duplicate was seen. A
duplicated column is invisible in `rows`, because a row object collapses the repeated key. One
case projects `total` under the name `note` to prove the skip is keyed on the EXPRESSION: keyed
on the name it would drop the wrong column.

`src/__tests__/write-json-value.test.ts` gains the A12 block: the encoded param VALUE as well as
the cast (a cast over un-encoded text is still broken SQL), the SQL-NULL exemptions, the `array`
and `text` columns staying untouched, and the literal road emitting correctly while still being
refused by validation. It also closes three emission paths the suite never reached — an array of
DOCUMENTS (`ARRAY[CAST($1 AS jsonb), …]::jsonb[]`), a document with NO target column falling back
to the dialect's own json type, and a PARAM bound to a document outside a write cell.

`src/__tests__/aggregate-fn-resolved.test.ts` is new (A14). Its two load-bearing cases are the
dead spots the output name could not cover — an ALIASED aggregate, and `total * 2 as count`
whose name says "aggregate" and whose expression is not one — asserted through `outputFields`,
the surface a consumer reads, rather than against `resolve()` in isolation. The NEGATIVES carry
as much weight: a composite over two aggregates has no single applied function, and a window
over an aggregate-shaped function is not an aggregate at all, so a regression that propagated a
child's name upward or set one for a window is caught here and nowhere else.

`src/__tests__/write-temporal-value.test.ts` is new (A11, above).

---

## 0.6.1

Two things: a **P1 write defect (A9)** — a `json` or `array` column could not be written at
all, and the one road that *parsed* silently bound `NULL` — and a **docstring audit**, since
this library's docstrings are the prompt a model authors against, so a stale one is a
behavioural bug.

**This release changes behaviour.** A9 widens what a write cell accepts, adds validation an
INSERT never performed, and stops a param binding `NULL` over a supplied value. Read *"What
changes for an existing consumer"* at the end of the A9 section before upgrading.

---

## A9 — a write could not carry a `json` or `array` value (**P1, silent data loss**)

`<type>_insert` / `<type>_update` could not write a `json` or `array` column by ANY road, and
the roads failed in increasing order of badness:

| road | 0.6.0 |
| ---- | ----- |
| a RAW document (`{ theme: 'dark' }`, `['a','b']`) | refused — `shape.type` / `write.unsupported-value` |
| OMIT the cell instead | `insert.missing-required` on a non-nullable column |
| an EXPRESSION carrying it | none exists — `LiteralExpr` took a `ScalarValue`, and there is no `toJson` builtin |
| a `param` bound to it | **parsed, then bound SQL `NULL`** — the write SUCCEEDED and the value was dropped |

The last row is why this is a P1 and not a missing feature: a write that appears to work and
loses data is worse than a refusal. In the consuming product `json` is how every settings /
metadata / spec column is declared — 23 of 31 storable types have one.

### The type and the parser disagreed — and the SCHEMA sided with the type

`WriteValueDef` is, and always was, `JsonValue | ExprDef`. The parser (`writeValueToExpr` and
its `Shape` twin) accepted only `string | number | boolean`. And one layer up, the
model-facing schema at `writes: 'typed'` renders each cell as
`field.fieldType.toValueSchema() OR Expr` — which for a `json` field IS the full JSON-value
schema. **So the schema invited the model to emit a document and the parser then refused it.**
The parser now follows the type, and all three agree.

### What changed

- **`LiteralExpr` carries a `JsonValue`** (was `ScalarValue`), so an expression can carry a
  document. It resolves to `json` for an object and `array` for an array — the categories the
  new write-value check needs — and `LiteralExprDef.value` widens with it.
- **`Dialect.jsonValue(value, fieldType?)`** is the ONE binding path for a non-scalar. The
  document travels as its JSON TEXT in a normal parameter slot (so `SqlValue` stays scalar,
  `RenderedSql.params` is unchanged, and nothing is ever string-interpolated), cast to the
  column type it is destined for. Base: `CAST(? AS <sqlTypeFor>)`. Postgres overrides, because
  a NATIVE array column does not accept JSON text — `CAST('["a"]' AS text[])` is a syntax
  error, a Postgres array literal being `{a,b}` — so a document bound for one is CONSTRUCTED
  as `ARRAY[$1, $2]::text[]` with per-element binds. That reuses the element-binding pattern
  the array containment operators already use, needs no array-literal encoder (whose quoting /
  escaping / NULL rules would be their own defect surface), and makes the empty case the
  `ARRAY[]::text[]` Postgres accepts precisely because the cast names the type. A
  `jsonSqlType()` seam names the default target (`json`; Postgres `jsonb`).
- **Write cells emit through `writeCellSql`**, which supplies the target COLUMN's field type —
  `Expr.toSQL` sees only the value's own shape, which cannot tell a `jsonb` column from a
  native `text[]` one. BOTH roads a document can arrive by (a literal, and a param bound to
  one) route through it, in INSERT VALUES, UPDATE SET and ON CONFLICT DO UPDATE.
- **A param bound to a non-scalar is BOUND, not nulled.** `ParamExpr.toSQL` binds it through
  `Dialect.jsonValue` instead of collapsing it to `NULL`. `SqlParamValue` widens to `JsonValue`
  (it already had to hold a relation `{ pk }` object; a document is the same shape of thing).
  Relation comparisons still decompose their `{ pk }` object into per-column binds BEFORE this
  point, so that path is untouched.
- **A write value is VALIDATED against its column** (`validateWriteValue`), which settles three
  things only the column can:
  1. **an INSERT's VALUES exprs are walked at all** — they never were, so a bad ref inside one
     was accepted silently and surfaced only at emit / run time;
  2. **a `param` cell is OBSERVED against the column's field type** — the only place a write
     param's type can come from, which is why `SET x = :p` reported `param.untyped`;
  3. **a value of an incompatible category is refused** — new code `write.type` (a document
     into a `text` column, a string into a `json` one). A param and a null literal are exempt;
     a RELATION column is exempt too, because what you write to it is the TARGET's identity,
     and `RelationFieldType.comparableWith` deliberately admits only another relation — so
     asking it here would refuse the ordinary "set the foreign key" write. Relation cells stay
     exactly as unchecked as they were; typing them against the target's primary key is
     separate work.
- **`{ kind }` means an expression only when the kind is REGISTERED.** The `JsonValue | ExprDef`
  union is only decidable that way: a settings blob carrying a `kind` key
  (`{ kind: 'section', … }`) is DATA, and reading it as a malformed expression reported an
  unknown-kind error about a construct the caller never wrote. **The flip side:** a model that
  TYPOS an expr kind in a write cell now writes a JSON blob instead of getting "unknown
  expression kind". That ambiguity is inherent to the union; `write.type` catches it for every
  column that is not itself `json`.
- **A non-JSON write value is properly rejected.** The input is untrusted, so the new
  `json(aid)` / `isJsonValue` shape checks a document RECURSIVELY: a `Date`, a function, an
  `undefined` member or a non-finite number is refused rather than becoming a literal that
  stringifies to something the caller never wrote (`NaN` stringifies to `null` — the exact bug
  class this item is about). Depth is bounded, so a cyclic hand-built object is rejected rather
  than overflowing the stack.

### What changes for an existing consumer

- **A raw document in a write cell now parses** where it used to throw / report `shape.type`.
- **An INSERT that was silently accepted may now report problems** — its VALUES exprs are
  validated for the first time. Everything it reports was already wrong at emit / run time.
- **`write.type` is a new refusal.** A write whose value never suited its column now says so.
- **`LiteralExpr.value` / `LiteralExprDef.value` widen to `JsonValue`.** Additive for anyone
  CONSTRUCTING one; a consumer that READS `.value` into a `ScalarValue` slot must narrow.
- **`SqlParamValue` widens to `JsonValue`** — additive.
- `Dialect.jsonValue` / `jsonSqlType` are CONCRETE methods with base implementations, so an
  existing custom dialect keeps compiling.

---

## The docstring audit

The rest of the release. `describeEngine` / `describeExprs` render every node's
`static INSTRUCTIONS` into the prompt a model reads before authoring a query, so these strings
are not comments — they are the specification the model works from.

### The defect it started from

`FieldRefExpr.INSTRUCTIONS` shipped 0.6.0 with the PRE-0.6.0 rule:

> *"A ref to a RELATION field resolves to the whole related row, NOT a scalar … cross the
> relation with a `relation` join."*

A8 made a belongs-to field-ref project the relation's IDENTITY — the local key column(s),
no join, no scope — so the library was **actively teaching models to avoid the thing its
own generated CRUD now does**, and a model following the instruction would author the
RLS-scoped join that A8 exists to eliminate. It now states the current rule: a belongs-to
ref projects the target's identity off THIS row (legal in `fields` / `RETURNING`, `order`,
`groupBy`, `is null`, and an identity `=` / `<>` / `in`); a `relation` join is how you read
the target's OTHER fields; a has-many ref is refused as `ref.relation-has-many`.

### The audit the fix implied

Every `INSTRUCTIONS` / `EXAMPLES` string in the package was checked against what 0.6.0
actually does. Four more were stale or silent about a 0.6.0 rule (a fifth, `literal`, is
rewritten by A9 above):

- **`is-null`** — said only ``` `value IS [NOT] NULL` ```. A8 made it the way to ask whether
  a relation is UNSET (it tests the KEY COLUMNS, so it stays index-usable), which is the
  audit-column story's other half; a has-many there is `ref.relation-has-many`.
- **`aggregate`** — silent on `ref.relation-aggregate`, a refusal 0.6.0 introduced. Now says
  an identity is not aggregable and points at grouping / a joined scalar.
- **`in`** — silent on `in.relation-composite`, also new in 0.6.0, and its "do NOT project a
  relation field-ref as a scalar id" now distinguishes the SUBQUERY position (still refused,
  `compare.relation-vs-value`) from projection in general (legal since A8, yielding an
  identity OBJECT).
- **`text-search` / `text-score`** — offered the whole-source form unconditionally, which A6
  made refusable (`text-search.unbacked` / `text-score.unbacked`) when the Type declares no
  search DOCUMENT. Both now say: narrow to a field unless the Type is backed.

**`comparison` was already correct** about the param-only rule and is unchanged; a regression
test now pins it (a relation vs a LITERAL is `compare.relation-vs-value`, vs a PARAM is clean,
and an ordering op is `comparison.relation-order`). Every other expr / query node's
`INSTRUCTIONS`, and every shipped `EXAMPLES` string, was checked and found accurate — the
worked examples all cross relations with a `relation` join and project the joined alias's
scalar, which 0.6.0 did not change.

### One layer down: the GENERATED field docs had the A1 defect

`describeField`'s generated sentence decided belongs-to from `count === 1`. The registry
estimates a materialized inverse's count as a row RATIO, so a 1:1 pair — or two Types
sharing one declared row estimate — described a HAS-MANY to the model as *"Belongs to one
X"*, i.e. as a projectable identity that a field-ref to it is refused for. It now asks
`RelationFieldType.isBelongsTo()`, the same discriminator A1 installed everywhere else.
(`inverseVia` is internal and never in the JSON def, so this one branch reads the FieldType
rather than the def.)

### Type exports A3 missed

`SqlParamValue` (the value bound to a `toSQL` param — a scalar, or the keyed object a
relation identity binds as) and `DrillValue` (the same widening on `drillDownInto`'s params)
were declared but not exported; consumers were spelling them structurally as
`NonNullable<ToSqlOptions['params']>[string]`. Purely additive.

### Also

`aeye-query.md` (shipped with the package) still advertised the `relation-path` expr kind,
which no longer exists — in the expr table, the depth/gating tables and the `describeExprs`
notes. Removed there; historical release-note passages that mention it in the past tense are
left alone. Its expr table (which mirrors the `INSTRUCTIONS` one-liners) picked up the same
five corrections.

### Tests

`src/__tests__/write-json-value.test.ts` covers A9, and its assertions with teeth are the
ROUND TRIPS — write a document, read the same document back through `RETURNING` / a `SELECT` —
plus the emitted SQL and its BOUND PARAMS, since "it parsed" is exactly what the broken param
road already did. It also pins the schema/parser agreement at both write depths.

`src/__tests__/instructions-accuracy.test.ts` asserts the RENDERED description — that
`describeExprs` states the identity rule and no longer contains any retired phrase, swept
across every expr / query / function `INSTRUCTIONS` and `EXAMPLES` rather than just the node
that was wrong — and then pins each ERROR CODE an instruction names to the code validation
actually emits for that case, so a behaviour change that renames or removes a refusal fails
next to the prose that promised it.

## 0.6.0

Seven asks from the consuming product, ranked by *silently-wrong × reachable-today ×
cost-to-fix*. Three change behaviour — read **A4**, **A6** and **A8** before upgrading.

### A1 — a materialized inverse no longer takes the belongs-to arm (silently-wrong data)

`RelationFieldType` decided which side the foreign key was on from `count === 1` alone.
`Registry.finalize()` estimates a materialized inverse's `count` as a **row ratio**
(`round(source.count / target.count)`), so a 1:1 pair — or two types that simply share one
declared row estimate, which is every freshly-authored type under a single default — came out
as `1` and resolved its join as `order.invoice = invoice.id`, where `order.invoice` is the
*synthetic relation field the registry had just added* rather than a column. **Every traversal
of such an inverse returned zero rows, with no error anywhere.**

`RelationFieldType.isBelongsTo()` is now the discriminator (`count === 1` **and** no internal
`inverseVia`), and `resolveKey` / `resolveKeys` / `resolveOn` route through it, as do the
relation comparison paths (`RelationCompare.belongsTo`, `RelationResolved.belongsTo` — the
latter replaces reading `.count` for this question).

*Blast radius:* behaviour changes only for relations carrying `inverseVia`, which only
`Registry.finalize()` creates. A hand-declared `count === 1` is untouched. The only behaviour a
consumer could have depended on is the broken one.

### A2 — a declared index now applies to an ALIASED query (additive)

An index part is a TYPE-level fact, so it is necessarily written against the Type NAME. A query
binding that Type under an alias — `{kind:'aliased'}`, or either side of a self-join — produced
digests that could never match, so **a declared unique index bought nothing**: a
`WHERE u.email = …` over a 10M-row type estimated 3.3M rows, identical to having no index.

New in `index-spec.ts`:

```ts
export function renameSource(expr: ExprDef, from: string, to: string): ExprDef;
export function aliasedDigest(expr: ExprDef, alias: string, typeName: string): string;
// Index.prefixReduction gains an optional second argument (existing calls unchanged):
prefixReduction(used, alias?: { source: string; typeName: string }): number | undefined;
```

The cost model threads a `SourceBinding { source, type }` (exported from `queries/_cost.ts`,
with `selfBinding(type)` for the DML case) through `applyWhere` / `matchedRows` /
`distinctEstimate` / `coveredScanBytes`. It is deliberately per-SOURCE rather than a single
"FROM alias" parameter, so a future multi-source cost model builds on the same primitive.
`IndexPart.digest` is unchanged.

This also closes a latent bug in the other direction: matching is now SOURCE-SCOPED, so a join
alias that happens to equal another Type's name can no longer match the scanned Type's parts.

**Cost numbers move.** A consumer with a tuned `maxRows` / `maxBytes` should re-check it —
aliased queries that were wildly over-estimated now report the real figure.

### A3 — missing type exports (purely additive)

Now exported by name: `RelationBacking`, `RelationOn`, `RelationOnPair`, `SearchBacking`,
`SemanticBacking`, `DefaultOrder`, `DefaultOrderTerm`, `DefaultOrderDir`, `DefaultOrderScope`,
`RelationKeyPair`, `RelationResolved`, `IndexPart`, plus the functions `renameSource`,
`aliasedDigest`, `relationKeyColumns`, `relationOf`, `valueFieldType`. `RelationBacking` in
particular is the type needed to write the composite-FK / custom-`ON` escape hatch the package
documents.

### A4 — identity is DECLARABLE (**behaviour-affecting**)

```ts
TypeDef.identity?: string | string[];
```

The field (or ordered fields) that IDENTIFY a row. When present it is THE answer for
`Type.identityField()` / `Type.primaryKey()`, and index ORDER becomes irrelevant — a unique
index on any other column is just a unique index.

Without it, identity is still inferred as "the first single-part unique index, else the field
named `id`". That rule is why a Type declaring both `id` and a unique `email`, with the email
index listed *first*, silently identifies by `email` — and every belongs-to into it then
resolves as `<other>.<rel> = <type>.email`, joining a stored id against an email address. Zero
rows, forever, no error.

**What changes for an existing consumer:** nothing, until you declare it. Declaring it is the
migration, and it is worth doing at every boundary where index order is not under your control
(an installed package's indexes are parsed verbatim). A declared name the Type does not have
raises `type.identity-unknown-field` rather than falling back to the inferred rule — falling
back would reintroduce the exact fragility the declaration removes, invisibly. A declared
COMPOSITE identity answers `primaryKey()` in key order and has no single `identityField()`.

### A5 — closed value sets on the existing scalars (additive)

```ts
export interface FieldValueDef { value: string | number; label?: string }
// TextFieldTypeDef and NumberOptions each gain:
values?: FieldValueDef[];
```

An enum expressed as a CONSTRAINT ON a text/number column rather than a new field-type `kind`
(which would fork every comparison / SQL-type / value-schema path for one extra fact). Three
things depend on it, none reachable from outside the library:

- **Cost** — `FieldType.eqSelectivity()` returns `1 / values.length`, consumed by
  `ComparisonExpr.selectivity` for `=`. A five-value `status` is `0.2` and a two-value flag is
  `0.5`, where both were previously the fixed `EQ_SELECTIVITY` guess of `0.33`.
- **Model-facing description** — `describeField` renders `status: text one of
  applied|screening (In screening)|hired`. The VALUE leads (it is what a `where` clause must
  contain); a `label` is appended only when it says something the value does not. A long set is
  elided after 12 members rather than spending the prompt budget enumerating it.
- **Value schema** — `toValueSchema()` narrows to the members instead of answering "any string".

An empty `values: []` is treated as an ABSENT declaration, not a set of nothing. `values` and
`pattern` are different facts (membership vs. shape) and may both be declared; membership is
what the value schema enforces. `NumberOptions` carries it, so `money.number` accepts it too.

### A6 — `searchColumn` stops guessing (**behaviourally breaking**)

An unnarrowed `text-search` / `text-score` wants the Type's searchable DOCUMENT, which only a
`SearchBacking` supplies (a precomputed `vectorField`, or a `sql` override). Finding none, the
library used to try three fallbacks in order — the first `search`-flagged text field, then the
first text field of any kind, then a column literally named `search`. **So a query asking for a
multi-field document silently searched ONE column, and which column depended on field order.**

All three fallbacks are deleted. An unbacked whole-source form is now refused:

- validation reports `text-search.unbacked` / `text-score.unbacked`, naming both remedies
  (narrow to a field, or declare a `SearchBacking`);
- emission throws a `QueryTypeError` with the same code, so a caller that skipped validation
  cannot get silently-wrong SQL out the other side.

No "declared but not backed" third state was added: the `SearchBacking` IS the backed
declaration, and a third state would just be a second thing to keep in sync.

Also: `Type.isFieldSearchable(field)` / `Type.isFieldSemantic(field)` are new, splitting the
per-field question from the whole-type one; `Type.isSearchable()` / `isSemantic()` keep
answering ELIGIBILITY (whole type OR any field), which is what schema gating and the capability
description ask. `Type.semanticFields()` **no longer includes relation fields** — it used to
treat every foreign key as semantic-eligible, which made almost any Type with a reference report
itself semantic. A relation is a join, not an embedding.

**Who this breaks:** anyone whose unnarrowed search happened to land on the right column. That
cannot be depended on deliberately, only stumbled into — but it will surface as a new error on
upgrade. The fix is one of the two remedies the message names.

### A8 — a relation's VALUE is its IDENTITY (**behaviour-affecting**)

A `field-ref` to a **belongs-to** relation is now a legal VALUE, reading the key off the
caller's OWN row. It yields a JSON object keyed by the TARGET's identity field names —
`{ id: 'userB' }`, `{ tenantId: 3, userId: 1 }` — or SQL `NULL` when any key column is null (a
partial composite key cannot join, so the relation is unset). A keyed object, not a positional
tuple: a tuple's meaning would depend on element order, and that order derives from index order,
which is A4's fragility.

**Why it is a defect and not a modelling choice.** Reading who a row points at previously
required joining the target and projecting its id — and that join is RLS-scoped, so a target the
reader cannot see nulls the id along with the rest of the row. An audit column (`createdBy`)
then reports *"nobody created this"*, making UNSET indistinguishable from HIDDEN in exactly the
case audit columns exist for. Reading the local column discloses nothing: it is data the
reader's own row already holds.

Two halves:

1. **Projectable without a join** — legal in `fields` / `RETURNING`, emitting
   `CASE WHEN <keys IS NULL> THEN NULL ELSE <json object> END` over the local columns, planning
   no join and applying no scope. Field-level security still applies. The projected field
   reports `fieldType: 'json'` and `nullable: true`.
2. **Comparable, orderable, groupable** — `=` / `<>` / `in` compare per key column (unchanged
   from 0.5.0, which already accepted a `{ pk }` object or a bare scalar for a single-column
   key); `is null` / `is not null` now test the KEY COLUMNS (`json_build_object(…) IS NULL`
   would be a constant false), so they stay index-usable; `order by` expands to one clause per
   key column (lexicographic over the declared key order) and `group by` to the key columns
   (structural).

**The refusals became stateable**, which is worth as much as the feature. A **has-many** has no
key on this row and its value is a SET: `ref.relation-has-many`, with a message that says so and
points at the join / membership test. An **aggregate** over an identity is undefined under any
representation: `ref.relation-aggregate`, pointing at grouping instead. Everywhere a relation is
genuinely not a value — an arithmetic operand, a `case` arm, a function argument — it stays
`ref.relation-not-value` / `compare.relation-vs-value` with the join-it hint. Previously all of
these arrived as one code for one non-reason.

`Dialect.jsonObject(entries)` is new (base: `json_build_object`; Postgres overrides to
`jsonb_build_object`, which has the equality and ordering operators `json` lacks). Object KEYS
are emitted as quoted SQL literals, never bind params — they are structure, not data.

**What changes for an existing consumer:**

- **A projected relation column is now an OBJECT where it used to be a bare scalar.** At runtime
  a relation field-ref previously evaluated to the raw FK value by accident (the relation field
  and its key column share a name under the name convention), while validation refused the query
  and SQL emission never produced it. Any code reading such a column must expect
  `{ <identityField>: value }`. A consumer's column/widget layer must learn that this shape means
  IDENTITY, not "a list of things".
- **`drillDownInto`'s param values widen** from `ScalarValue` to the new `DrillValue`
  (`ScalarValue | { [key: string]: ScalarValue }`), so a relation group key drills down on its
  identity object — which is exactly the shape a relation comparison binds.
- **A subquery that PROJECTS a relation** (`user.id IN (SELECT order.userId FROM order)`) was
  already a validation error in 0.5.0 (`compare.relation-vs-value`) and now also changes what
  the runtime produces. Cross the relation with a `relation` join and project the joined alias's
  scalar instead. `<relation> IN (subquery)` on the *left* is unchanged: it compares the key
  COLUMN, and a COMPOSITE-key relation there is refused as `in.relation-composite` (a one-field
  subquery has nothing to match against a multi-column key).

### Internal

`ValidateContext.relationValueOk?: boolean` is replaced by
`ValidateContext.relationUse?: 'compare' | 'value'`, which says HOW a relation field-ref may be
used at a position instead of merely whether it is tolerated. `FieldRefExpr` gains
`columnValue()` / `columnSQL()`, reading a ref as a plain COLUMN without the identity
projection — needed because a belongs-to's key column and the relation field share a name.

### A7 — out of scope

The cost model still never consults a JOINED source's indexes. A2's per-source alias threading
is the primitive that work would build on; nothing here depends on it.
