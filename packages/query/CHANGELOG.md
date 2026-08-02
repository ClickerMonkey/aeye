# `@aeye/query` changelog

Releases before `0.6.0` are recorded in the git log (`chore(release): @aeye/query <version>`
commits); this file starts here and is the place to look from now on.

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
