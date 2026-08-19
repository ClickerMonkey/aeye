# `@aeye/query` changelog

Releases before `0.6.0` are recorded in the git log (`chore(release): @aeye/query <version>`
commits); this file starts here and is the place to look from now on.

## 0.6.6

Two asks about the same thing from two directions: **a declared type should decide which values
are allowed**, and until now it only did so on the way OUT (schemas, descriptions, cost) rather
than on the way IN — plus a third, from the owner, about the one thing a declared type decided
TOO much: text case. Plus the step-0 fixes for the registered-type work (A22 and the "Also"
list below) and its **steps 1–3** — a registered REFINEMENT naming a builtin (`{ kind: 'text',
as: 'uuid' }`), the OPTIONS / grammar / comparability that refinement declares, and a registered
OPERATOR (`&&`, `<->`) whose SQL a declaration supplies per dialect — whose common thread is the
same one: **what a DECLARATION says should be what the engine does with it.** A declared
parameter type should type the param handed to it, a declared emitted name should be held to the
guarantee its doc claims, a named type declared once should narrow every column that names it,
and an operator a deployment declares should emit its own SQL rather than being unspellable.
There are **five behaviour changes to read before adopting**, of different kinds, and **one
renamed option**:

- **A query that was REFUSED before can now pass, and a param can now report a type it did
  not.** A bare bind param as a function argument (`abs(:p)`, `sum(:p)`) is typed by the
  declared parameter instead of judged against a `text` placeholder — see A22. `params()` may
  therefore list a name it previously omitted.
- **A FUNCTION DEFINITION that registered before can now THROW**: a `sql` (the emitted name) that
  is not a safe SQL identifier is now refused at `registerFunction`, exactly as `name` always was.
  It lands in the same raw-interpolated slot, so such a def was already emitting broken SQL.
- **A query that was accepted before can now report a problem.** `write.value` for a literal
  outside a column's closed set (at any depth — an `array<text one of a|b>` is checked
  element-wise), and `param.conflict` for a param whose uses have no common type. Both are about
  a value that could not have been stored or bound correctly.
- **A TYPE DEFINITION that registered before can now THROW**, in three cases, all of them a
  declaration that contradicts itself. `parseFieldType` / `parseType` raise a `QueryTypeError`
  for:
  - a `text` field whose `pattern` is not a compilable regex (`field-type.bad-pattern`);
  - a closed `values` set with a member the field's OWN constraints reject
    (`field-type.bad-values`) — `text{values:['zz'], pattern:'^a'}`,
    `text{values:['ab'], minLength:5}`, `number{values:[1.5], whole:true}`, or a member outside a
    declared bound. EVERY member must satisfy, so a set that keeps only some of its members is
    refused too;
  - a member of the WRONG SCALAR for its kind (`number{values:[{value:'a'}]}` — same
    `field-type.bad-values`, and the generated def schema no longer offers the shape at all).

  All three used to register and sit inert. **If you register defs from storage or from user
  input, that call can now throw where it previously could not** — catch it, or validate
  upstream. The public CONSTRUCTORS are unchanged and still validate none of it. For the pattern
  the alternative was worse (the new param meet compiles it, so leaving it unchecked threw a raw
  `SyntaxError` out of `validateQuery`); for the sets, see "the GREATEST lower bound" below —
  tolerating them meant `param.conflict` blaming a QUERY for a defect in the TYPE.
- **A TEXT FIELD'S `sensitive` OPTION IS GONE, replaced by `casing`** — and a def still carrying
  `sensitive` is REFUSED (`field-type.retired-option`), never ignored. "Text casing" below says
  why the option had to grow past a boolean; the refusal is the half to read here. The parse
  DROPS keys it does not destructure, so a def carried over from `0.6.5` would have registered
  clean and silently reverted an exactly-compared column to case-FOLDED matching — putting a
  `LOWER()` back on an identifier column (which throws outright over a physical `uuid`) and
  LOOSENING every row-security predicate that compares one. `FieldType.textCaseSensitive()` is
  likewise `FieldType.textCasing()` now, and `Value.caseSensitive()` is `Value.textCasing()`;
  both return the DECLARED `TextCasing` or `undefined`, because "declares nothing" is a distinct
  answer from "declares case-insensitive". No other exported name changed meaning and no
  signature lost a parameter.
- **An UNTYPED array's element containment now follows the engine default** rather than always
  comparing exactly. `array-op` resolved a missing element type to case-SENSITIVE while a scalar
  comparison resolved a missing operand type to case-INSENSITIVE, so `tags contains 'BETA'` and
  `tag = 'BETA'` answered differently over one deployment for no reason a caller could see. Under
  the shipped default that means an untyped `contains` folds where it did not.

### A20 — a WRITE ignored the column's closed value set (**P1, silently wrong data**)

`validateWriteValue` checked the written value's CATEGORY and never its MEMBERSHIP. Measured on
`0.6.5`, over a `status` declaring `todo|in progress|done|blocked`:

```
UPDATE task SET status = LITERAL "bogus"   ->  ACCEPTED
INSERT task (status)   = LITERAL "bogus"   ->  ACCEPTED
UPDATE task SET status = LITERAL 42        ->  REFUSED  write.type
```

So the write model already read the column's declared type and refused a value that did not fit
it — and `values` is part of that same declaration. Membership had NO enforcement anywhere:
`toValueSchema()` knew the members, the model-facing description listed them, cost estimation
divided by them, and a write could still store anything. The check itself already existed
(`closedSetValueSchema`), one notch away from the call site.

**Fixed** with a sibling in `field-types/_values.ts` (`isClosedSetMember`) and a new problem code
**`write.value`**, whose message NAMES the members — they are the fix, and the library already
renders a closed set to models in that exact form:

```
Cannot write "bogus" to field 'status' — it declares a closed set of values,
one of todo|in progress (In progress)|done|blocked.
```

It is a separate code from `write.type` because the remedy differs: a category says *change the
type of this value*, membership says *use one of these*. One cell still reports one problem — a
wrong category short-circuits membership.

Scoped to exactly what can be decided statically: a `LiteralExpr` carrying a scalar, on a column
whose type declares `values`. The exemptions each keep their own reason — a `param` (no value at
validate time; it is checked by A21's `checkParams` instead), a null literal (matching Postgres,
where NULL passes a CHECK by three-valued logic), a RELATION column (you write the target's
identity), and every NON-literal expr (a function call, a field ref, a `case` — statically
uncheckable, the same class as a param). **READS are deliberately untouched**: `where status =
'bogus'` stays legal, because querying for a value that should not exist is how you find the rows
a bad migration wrote.

Reaching `values` generically needed a **total `FieldType.values()`**, which replaces the
per-class `eqSelectivity` overrides. That closed two live bugs of the same shape, both caused by
asking each CLASS separately instead of asking the TYPE:

- a **`money` column with a declared value set was costed at the fixed `EQ_SELECTIVITY` guess**
  (measured: 500 estimated rows where `1/n` gives 330), because its set lives in the inner
  `NumberOptions` bag and neither override looked there;
- the **model was never shown a `money` column's set at all** — `describe.ts`'s `fieldTypeTag`
  dispatched on `instanceof` and read `ft.options.values`, so `fee` rendered as a bare
  `money(USD)`. Paired with the new write check that is worse than either half alone: the model
  authors `SET fee = 7`, is refused with a members list it was structurally never told, and
  guess-and-retry is its only recovery. Enforcing membership and RENDERING it are one feature;
  the set is now appended uniformly from `values()` and the per-kind branches decide the base tag
  only.

**A declared value set is now DEDUPED**, in `compactFieldValues` — which already owns what a
legal closed set is, so every consumer inherits one answer. A duplicate was representable and
nothing rejected it, and it made the meet's INTERSECTION take its multiplicity from whichever
operand it iterates: `a ⊓ b` was not `b ⊓ a`. The same query then got a different `params()`, a
different `eqSelectivity` (`1/3` vs `1/2` — a different COST estimate), `one of done|todo|todo` in
the description, and a repeated option in any UI built from `ParamDef.type.values`.

**Know that this is a REWRITE, not only a read-side normalisation.**
`registry.parseType(defWithDuplicate).toJSON()` hands back the DEDUPED def, so a consumer that
persists `toJSON()` over the stored definition — a type-editing flow does exactly that — silently
rewrites the author's declaration. That is the right normalisation (a set with a repeated member
was never a set, and the duplicate had observable consequences), but it is a write, so it is
stated rather than left to be discovered.

**A text `pattern` must now be a compilable regex, checked at parse time**
(`field-type.bad-pattern`). An uncompilable one used to be accepted and completely inert —
`toValueSchema()` short-circuits on a closed set and never compiles it — until the new meet
compiled it while narrowing, which threw a raw `SyntaxError` out of `validateQuery` / `params()`
for a def `parseType` had accepted. That is exactly the contract this package does not break, and
the defect is in the DECLARATION, so it is refused where the declaration is read. It is checked in
`TextFieldType.from`, which is the road every in-package parse takes (including a nested array
item); the public CONSTRUCTOR does not validate, so a hand-built
`new TextFieldType({ pattern: '([' })` can still carry one — noted on `TextOptions.pattern`, and
the same caveat every other hand-supplied option already has.

**A CLOSED SET'S MEMBER TYPE NOW COMES FROM THE OWNING KIND.** `fieldValuesSchema` was shared by
`text` and `number` and declared its member as `z.union([z.string(), z.number()])` for both, so
the `number` field-type schema offered a member slot accepting text. Measured on `0.6.5`:

```
parseFieldType({kind:'number', values:[{value:'a'},{value:2}]})  ->  ACCEPTED
  .validValue('a')   -> true      // a NUMBER column accepting the string 'a'
  .eqSelectivity()   -> 0.5
```

For a package whose contract is that its generated schemas only ever offer VALID values, the
offer was the defect; the def that took it was doing as it was told. The slot is now
parameterised — `z.string()` for `text`, `z.number()` for `number` and (through its inner
`NumberOptions` bag) for `money` — and the parameter is REQUIRED, so a new kind that grows a
closed set has to say which scalar its members are rather than inherit "either" by omission.
The def SCHEMA is not on the `from` path, so the same fact is enforced there by
`field-type.bad-values` below.

**A CLOSED SET MUST BE SATISFIABLE BY ITS OWN CONSTRAINTS**, checked where the declaration is
read (`field-type.bad-values`). `text{values:['zz'], pattern:'^a'}` and
`number{values:[1.5], whole:true}` registered happily before, and were OBSERVABLY inconsistent
once registered: a closed set IS the value schema, so `validValue('zz')` answered `true` on the
way in while the meet — which narrows a merged set by the merged constraints — dropped `zz` on
the way out. Satisfiability is decidable here, patterns included: the set is FINITE and declared,
so every per-member predicate is settled by EVALUATION, and the check reuses the one evaluator
the package already had (`narrowFieldValues` against the kind's constraint schema) rather than
growing a second answer to "does this member satisfy these constraints". EVERY member must
satisfy, not merely one — a set that keeps some members is as broken as one that keeps none, and
requiring all of them is what makes the meet a greatest lower bound. The message names WHICH
member and WHAT excluded it, in the rejecting schema's own words, because the author's fix is to
change one or the other:

```
A 'text' field declares 1 closed-set member its own constraints reject:
"zz" (Invalid string: must match pattern /^a/). A closed set IS the value schema,
so such a member could never be stored — remove it, or relax the constraint that
excludes it.
```

A `money` set is reported at `number.values`, which is where a money def declares one — the same
indirection that once hid its `eqSelectivity` from the cost model, reached through the same door
rather than a second one.

### A21 — a param's type was the FIRST use, not the merged one, and supplied values were never checked (**P1**)

`ParamSet.resolved` seeded with the first observation and kept it, admitting any later one that
was `comparableWith` it. Two consequences:

- **order-dependent.** A param compared against an `enum` in one place and plain `text` in
  another resolved to whichever the walk reached first — a property of where the clauses sat in
  the JSON, not of what the query means. The answer is the ENUM.
- **never narrowed.** `text{minLength:5}` beside `text{maxLength:10}` reported one bound and
  dropped the other, so nothing downstream could know the real requirement.

And a bound VALUE was never checked against any of it: `run(q, { params })` bound whatever it was
given.

**`FieldType.meet(other)`** is the fix — the constructive form of `comparableWith`, total on the
value-category union in the same way, and strictly stronger (two `text` types with disjoint
closed sets are comparable and have no meet). `enum ⊓ text = enum`, `enum{a,b} ⊓ enum{b,c} =
enum{b}`, `text{minLength:5} ⊓ text{maxLength:10}` carries both, `number ⊓ money = money`,
`date ⊓ timestamp = timestamp`, array element types meet recursively. Its ALGEBRA is the point —
a fold over uses in walk order is only order-independent if the operation is commutative,
associative and idempotent — so every primitive it is built from (`field-types/_meet.ts`) is one
of three provable shapes, and all three laws are property-tested over every pair and triple of a
40-type set — 64,000 triples, covering set+bound and set+pattern, duplicated sets, decimal places,
money-with-a-set, nested arrays, arrays of enums, and relations carrying inverse metadata — along
with the soundness law that makes it usable as a validator: **the meet accepts nothing that both
operands do not.** (The set was 42 in this release's first pass, three of them self-inconsistent
declarations; those are no longer buildable from a def, so they moved to the hand-built test that
now guards the constructor road on its own.)

**An EMPTY meet is a CONFLICT**, not a satisfiable-by-nothing type. An empty `values` array is
not representable — `compactFieldValues` drops it, precisely so `1/n` cannot divide by zero — so
a "closed set of nothing" would round-trip into an UNCONSTRAINED type, the exact opposite of what
was computed. The same rule covers disjoint bounds and two different patterns.

**It is the GREATEST lower bound for every type built from a DEF — and only a lower bound for one
built by hand.** That distinction is the whole of the remaining caveat, and it is worth reading
precisely rather than rounding to "the meet is a GLB now".

Because a closed set IS the value schema, the meet narrows a merged set by the merged scalar
constraints; so for a SELF-INCONSISTENT type — `text{values:['ab'], minLength:5}`, whose own bound
rejects its own member — even `x ⊓ text` narrows or conflicts rather than returning `x`. The
narrowing is not optional: keeping `1` from `text{values:[1,'b']} ⊓ text` would ADMIT a value plain
`text` refuses, breaking soundness, which is the law a validator actually depends on. So the
DECLARATION is what had to go, and the two narrowings above (per-kind member typing, plus
`field-type.bad-values`) are exactly that: such a set is now refused where declarations are read.

Over everything a def can express, `x ⊓ ⊤ = x` therefore holds **unconditionally** — the property
loop's named expected-failure set is EMPTY and the law is asserted with no carve-out — and the
"`param.conflict` blames the query for a defect in the TYPE" hazard is deleted rather than
documented. The loop first proves its own premise, asserting that `parseFieldType` can build every
type in the set, so the law cannot become true by quietly curating the table.

**The public CONSTRUCTORS still do not validate**, the same caveat `TextOptions.pattern` carries
for an uncompilable regex. `new TextFieldType({ values: [{ value: 'ab' }], minLength: 5 })` remains
buildable, `validValue('ab')` remains `true` for it, and `x ⊓ ⊤` still narrows or conflicts — for
THAT type the meet is a lower bound only. Both roads are tested: the hand-built one on its own,
and the def road by the refusal. Soundness is unconditional on both.

**New public surface**, alongside the unchanged `ParamDef` / `query.params()`:

- **`engine.parameters(query)` → `ParamInfo[]`** — per param: its `references`, every `use`
  (`{ at, type, category, field? }` — the JSON path, the full FieldType that use requires, the
  `ScalarKind` summary, and the COLUMN the requirement came from), the merged `type` /
  `category`, and the `conflict` when there is none. The same grade of detail a query's RESULT
  fields carry, plus the origin, so a caller can explain WHY a param got its type. Untyped and
  conflicting params appear here in full; `params()` still omits them, because a `ParamDef`
  without a type would be a lie about a param nothing can bind.
- **`engine.checkParams(query, params)` → `Problems`** — supplied values checked against the
  merged type BEFORE execution. `param.value` (error) is a value the merged type refuses,
  including one that each use in ISOLATION would have admitted — the case nothing could catch
  before. `param.missing` (warning) is a typed param with no value, which binds SQL NULL and is
  what `autoPaginate` relies on. `param.unknown` (warning) is a value supplied under a name the
  query has no param for, i.e. a typo. `null` always passes (a param is potentially-null by
  construction), and so does a RELATION-typed param — what you bind to one is the target's
  IDENTITY, a `{ pk }` OBJECT for a composite key, which `RelationFieldType.toValueSchema()`
  (a bare string) does not describe; that is the same exemption `write.type` already makes for a
  relation column, and closing it properly needs the target's primary key. Reported as Problems,
  never thrown, and it also rides on
  `validateQuery(query, _, _, { params })`. `run` / `toSQL` are unchanged and do NOT validate —
  a hot path that could only throw is the wrong place to learn this.

`param.conflict` now says WHICH kind of conflict it is — two different value categories, versus
one category whose constraints cannot hold together — and renders each side WITH its value set,
which is the distinction a reader cannot make from the paths alone.

Every `observe` site that has a COLUMN in hand now passes it, so `ParamUse.field` answers "why is
this param a text?" uniformly — including `array-op`, whose requirement is its target column's
ITEM type. The sites that report no column (`unary`, a function argument, a `limit` / `offset`
bound) are the ones whose requirement is genuinely structural rather than a column's, which is
what `ParamUse.field`'s doc says.

### Text casing — `LOWER()` on every text predicate was a default nobody could turn off (**P1, index-defeating and sometimes fatal**)

> *"I don't like that auto-lower by default. I think on the engine you specify that behavior (or
> somewhere) because a table could be done with a collation where equality checks are always case
> insensitive and no lower is necessary."*

A plain `{kind:'text'}` column emitted `LOWER("t"."id") = LOWER($1)`. The per-field lever existed
(`sensitive: true`) but the DEFAULT was wrong for a whole class of deployments, and the cost is
not a slow query — it is two harder failures:

- **`LOWER(col)` is not sargable.** No ordinary B-tree on the column can be probed, so every
  predicate over it degrades to a scan. The consuming product declares `id: { kind: 'text' }` (*"a
  uuid — rendered in the query meta-model as text"*) at ~40 sites; every id lookup in that catalog
  was structurally unable to use its index.
- **`LOWER()` is a TEXT function, and this package knows a column's LOGICAL type, never its
  physical one.** On Postgres those same columns are physically `uuid`, and `LOWER(uuid)` is
  `function lower(uuid) does not exist`. Measured in that product: EVERY row-security-scoped
  (non-admin) query failed outright, because the owner / one-hop predicates compare a uuid column
  to the caller's id. A forgiving default produced SQL that could not run at all.

**Two facts were hiding inside one boolean**, which is why the fix is not a flag:

1. **What the comparison MEANS** — does `'Ada' = 'ada'` hold? A semantic, so it must hold
   identically in the in-memory runtime AND the emitted SQL.
2. **WHO folds, in SQL** — this package (wrapping both operands in `LOWER(...)`), or the COLUMN's
   own collation. A `citext`, a `deterministic = false` collation, or a SQL Server `*_CI_*` server
   default already compares case-insensitively, so `LOWER()` there is pure cost with no semantic
   gain — exactly the owner's case, and a boolean cannot say it.

So a text field's `sensitive?: boolean` becomes **`casing?: TextCasing`**, one of three states,
each with a distinct pair of behaviours (no two are the same behaviour):

| `casing`     | means                                              | SQL for `a = b`       | in-memory runtime |
|--------------|----------------------------------------------------|-----------------------|-------------------|
| `'fold'`     | case-INSENSITIVE, folded by the query               | `LOWER(a) = LOWER(b)` | folds             |
| `'collated'` | case-INSENSITIVE, folded by the COLUMN's collation  | `a = b`               | folds             |
| `'exact'`    | case-SENSITIVE                                      | `a = b`               | compares as-is    |

`'collated'` is the state that makes the ruling expressible truthfully: it keeps the MEANING
insensitive — so the runtime still folds and a query means one thing wherever it runs — while
emitting a bare, index-usable comparison. It is a CLAIM ABOUT THE STORE that this package cannot
verify, and declaring it over a case-sensitive column is the one way to make the two roads
disagree; that is the trade for expressing the fact at all, and it is why it is not a default.

**WHERE THE CONTROL LIVES, and why it is not the Dialect.** The engine gains
`QueryEngineOptions.textCasing` — the deployment-wide default for columns that declare none — and
a field's own `casing` beats it. The dialect was the other candidate (collation behaviour IS
dialect-specific, and one dialect instance can serve tables of mixed collation), and it does not
work: a `Dialect` is an ARGUMENT to `toSQL` and is absent from the runtime entirely, so a
dialect-level default could govern only half of a semantic that has to hold in both halves —
which is the invariant `runtime-sql-agreement.test.ts` exists to pin. The engine is the only layer
both roads can see (`SqlContext.engine`, `RuntimeContext.engine`). Collation is genuinely a
per-COLUMN fact, so the per-field declaration is the precise place to state it; the engine default
exists so a deployment whose columns are uniform says it once instead of forty times.

**A declaration is authoritative, and the resolution ORDER is the whole of it.** The casings the
two operands DECLARE are reconciled between themselves (strictest wins: `exact` ≻ `fold` ≻
`collated`, preserving the old rule that a case-sensitive field on either side forced an exact
match), and the engine default is consulted ONLY when NEITHER side declares one. That ordering is
load-bearing rather than tidy: a literal, a param and a computed column all declare nothing, so
folding the default in per-operand would let an engine default of `'exact'` arrive through the
LITERAL in `slug = 'x'` and out-rank a column that explicitly declared `'fold'` — silently making
a column case-sensitive that says in its own definition that it is not. Both directions are
tested.

**THE DEFAULT DOES NOT FLIP.** `DEFAULT_TEXT_CASING` is `'fold'` — this package's behaviour in
every release before the option existed. Every other behaviour change in this release is LOUD by
construction (it reports a problem, or it throws); flipping this one would be the opposite: an
existing deployment's `where email = 'Ada@example.com'` would quietly stop matching stored
`ada@example.com`, with no problem, no type error and no thrown call, and nothing in this package
able to detect it. The forgiving default also exists for a reason that has not gone away — this is
a language MODELS author against, and a model writing `status = 'Active'` against stored `active`
is the case it was chosen for. What was missing was never a better guess but the ability to SAY
so: **a schema of identifiers, codes, uuids and enums should set `textCasing: 'exact'` (or
`'collated'`) on the engine, in one line, and let the columns that genuinely want folding declare
`casing: 'fold'`.**

**Every road that folds now asks the same question**, and the roads that never folded are pinned
as still not folding — a control honoured by some sites and not others reads as fixed when it is
not. Folding, and now cased: scalar comparison (`= <> < <= > >=`) in SQL and at runtime,
`like` / `notLike` in both, `array-op` element containment, and `text-search` / `text-score` in
both (search collapses the three casings to a boolean, correctly: a folded search runs through
`to_tsvector` / `plainto_tsquery`, which folds as part of what it does and ranks through a GIN
index, so there is no `LOWER(col)` predicate for `'collated'` to spare — only `'exact'` changes
the emission, degrading to an exact-case `LIKE`). Deliberately NOT cased, each for its own reason:
`ilike` (case-insensitive by definition — the base dialect's `LOWER` there is the OP's semantics,
not a policy); `Dialect.tsvectorSearch` (a stored tsvector has already been folded and stemmed, so
`'exact'` is not expressible over one at any price, and honouring it would make the base dialect
disagree with Postgres about one predicate); and `in` / `between` / `order by` / `distinct` /
relation-identity comparison (including a JOIN's key `ON`) / the text scalar functions
(`startsWith`, `indexOf`, `replace`, `arrayContains` — which map onto the database's own
exact-matching builtins, `lower(...)` being the explicit way to fold inside one), **none of which
have ever case-folded on either road**. That last group is a real
inconsistency in the language — `in.ts`'s own comment defines `x IN (a, b)` as `x = a OR x = b`,
and for text it is not — but it is left alone here: making them fold would mean MORE
index-defeating SQL and a semantic change for every consumer, and making `=` stop folding is the
default flip this section just declined. It is named so the next reader does not mistake silence
for coverage.

**New public surface:** `TextCasing`, `TEXT_CASINGS`, `DEFAULT_TEXT_CASING`, `casingRank`,
`strictestCasing`, `effectiveCasing`, `foldsInSql`, `foldsAtRuntime`, and
`QueryEngine.textCasing`. `meetRanked` joins `field-types/_meet.ts` as its fourth lattice
primitive — max over a ranked enum, i.e. `meetFlag` with more than two members — so a param typed
from an `'exact'` column and a `'fold'` one infers `'exact'` by the SAME rank function the
comparison uses, and the two answers cannot drift.

### A22 — a bind param as a FUNCTION ARGUMENT was refused, order-dependently (**P1**)

All four call-shaped expr kinds validated the call BEFORE observing their param arguments — and
three of them (`aggregate`, `window`, tabular) never observed at all. An un-observed `ParamExpr`
resolves to a `text` placeholder, so the arg-type check compared the DECLARED parameter type
against `text` and refused a perfectly good call. Measured on `0.6.6`, against the shipped
builtins and a registered function alike:

```
abs(:p) > 1                  ->  function.arg-type: Argument 'value' of 'abs' expects number, got text.
abs(t.n) > 1     [control]   ->  []
t.n = :p AND abs(:p) > 1     ->  []        <- an earlier typed use rescued it
abs(:p) > 1 AND t.n = :p     ->  function.arg-type: …      <- THE SAME QUERY, CLAUSES SWAPPED
sum(:p) / ntile(n: :p)       ->  function.arg-type + param.untyped   (never observed at all)
```

The last two lines are one query in two clause orders disagreeing — exactly the order-dependence
the `0.6.6` param meet exists to remove — and the refusal contradicts the library's own
`param.untyped` message, which advertises a **function argument** as one of the roads a param may
be typed by.

**What changed.** Each of the four kinds now observes (and RE-RESOLVES) its param arguments
against the declared parameter type first, then validates — so the argument is a typing ROAD, not
merely a position that stops complaining: `abs(:p)` with `:p` used nowhere else reports `number`
from `params()`, `parameters()` and `checkParams()`, and an `'inferred'`-output call resolves from
the parameter type instead of the placeholder. A bare param argument is additionally EXEMPT from
the arg-type check, for the reason `ComparisonExpr` has always exempted a param operand: the call
site is where the param GETS a type, so there is nothing there to be wrong.
`QueryFunction.validateCall` takes the exempt names as an optional third argument (`paramArgs`),
defaulting to none, so an existing caller is unaffected.

**What changes for an existing consumer.** Queries that were refused now pass, and a param that
reported no type now reports one — `params()` can therefore include a name it previously omitted,
which is additive for binding. A param whose uses genuinely conflict still reports
`param.conflict`, now ONCE and in either clause order, instead of a `function.arg-type` beside it
in one order only. A parameter declared `'any'` states no type to observe, so a param used only
there is still `param.untyped`.

### A registered REFINEMENT names a builtin — `{ kind: <base>, as: <name> }` (**additive**)

The declared-type story from the other end. `registerFunction` lets a deployment add a VERB —
this adds a NOUN, with the same split: the DECLARATION is pure JSON, so it persists, rides the
wire and reaches a model; the CODE half is a separate call; and the library compiles the
declaration into a builtin instance. A declarer never writes a `FieldType` subclass, never writes
`meetWith`, and therefore cannot break the lattice laws.

```ts
registry.registerFieldType({
  name: 'uuid', base: 'text',
  instructions: 'A UUID (RFC 4122) — lower-case, hyphenated, 36 characters.',
  options: { minLength: 36, maxLength: 36, casing: 'exact' },
  sql: { postgres: 'uuid' }, avgBytes: 16,
});
registry.registerFieldTypeImpl('uuid', { value: z.uuid() });   // the CODE half
// then, on any Type:  { name: 'id', type: { kind: 'text', as: 'uuid' } }
```

**THE SPLIT IS NOT COSMETIC — it is why the value gate is NOT on the declaration.** A declaration
is what a consumer persists and replays at boot, and a zod schema does not FAIL a JSON round-trip:
it survives as a plausible HUSK that passes every registration check and then throws a raw
`TypeError` out of zod's own internals at the first `validValue()` — no `QueryTypeError`, no code,
no path, and the strictest gate on that column silently dead. (A `value` that was never a schema
at all was accepted just as quietly.) Behind `registerFieldTypeImpl`, the half that cannot survive
a round-trip is the half nobody tries to store, and that road refuses a non-schema `value`, an
unknown name, and a second impl for one name.

**The spelling is the whole reason it is affordable.** The wire `kind` stays one of the nine
builtins, so `ScalarKind` and `FieldTypeDef` never open, every `def.kind === 'text'` narrowing and
every `instanceof TextFieldType` check stays correct for a refined column, and the exhaustiveness
guards over those unions stay unreachable. Nothing about an existing def changes: a type declaring
no `as` serializes, meets, costs and describes byte-for-byte as before.

**The measured win, which is why this shipped now rather than with the rest of the design.** A
consumer catalog declares `id: { kind: 'text' }` at ~40 sites; every id predicate emitted
`LOWER("t"."id") = LOWER($1)` — not sargable, and a hard `function lower(uuid) does not exist`
over a physical uuid column. One `uuid` refinement declaring `casing: 'exact'` turns all forty into
a bare `=`, from one declaration site. The alternative was repeating `casing: 'exact'` forty times.
The emitted SQL is asserted by a test, control included, so it cannot rot.

**Narrowing, never widening — and NO new lattice law.** A refinement's `options` are the FLOOR
every use stands on: a use site's own options are MET with them, so a site may narrow further
(`{as:'uuid', pattern:'^f'}`), a site that tries to loosen is ABSORBED (the meet is a lower bound
of both), and a site that contradicts is REFUSED (`field-type.refinement-conflict`). `as` itself
merges through the SAME flat `meetExact` that `pattern` / `currency` / `timezone` already use — a
registered name meets only itself, an unrefined base is TOP, so `uuid ⊓ text = uuid` and two
refinements of one base conflict. `param-meet.test.ts` now carries a refined shape for every
refinable base — including BOTH sides of both cross-kind families, one over a base with a closed
`values` set, and a refined array element — in the set the four laws plus `x ⊓ ⊤ = x` are proved
over, and **the set passes with no carve-out**.

Three consequences worth naming, because they are the only places the mechanism touched the
existing algebra:

- `meet`'s identity short-circuit compares the two BUILTIN defs rather than the two full defs.
  `meetWith`'s documented default is "no meet", correct for an option-less kind only BECAUSE two
  such types were always JSON-identical and never reached it — a refinement breaks that premise,
  and comparing full defs would have made `bool{as:'Flag'} ⊓ bool` answer `undefined`.
- **A meet that leaves the refinement's BASE KIND drops to no meet.** `number`↔`money` and
  `date`↔`timestamp` answer with whichever side is more specific, so `money{as:'Usd'} ⊓ number` is
  still a money and keeps its name while `number{as:'Score'} ⊓ money` is a MONEY and cannot carry
  one. Checked on the RESULT, not the operands: refusing whenever the operands' kinds differ is
  NOT ASSOCIATIVE, because `money ⊓ number` is a money, so the two groupings of
  `Usd ⊓ money ⊓ number` disagree. Dropping the tag instead would be unsound — it drops the
  refinement's stricter value gate.
- **The meet operates on the compiled INSTANCES, not the names.** Names are per-registry, so two
  registries can both say `as: 'uuid'` and mean different things; taking the left operand's
  instance made `a ⊓ b` and `b ⊓ a` JSON-identical (invisible to a def-comparing property test)
  while admitting different VALUES and answering different `sqlType` / `avgBytes`. Same name,
  different compilation, is now a conflict.

**What the model sees.** `id: text(as uuid)` in the type tag (the refinement FIRST, then the
base's own flags — `text(as uuid,search)`), the declaration's `instructions` as the generated
description, and — the part that makes the vocabulary real rather than advisory — `as` rendered as
a **`z.enum` of the names registered over that base** in the generated def schema, so a model
cannot invent `as: 'uuid4'`. The `as ` prefix is there because a bare first qualifier is ambiguous
on any kind with a non-flag one of its own (`money(Usd,USD)` gives a model no way to tell which
token is which), and it doubles as the key the model has to write. `fieldTypeDefSchema` and
`Type.toSchema` are therefore REGISTRY-DRIVEN now: pass `opts.registry`
(`Type.toSchema({ registry })`), and a base with NO registrations **refuses** an `as` rather than
stripping it — stripping was silent in the one pipeline that matters, since `Tool.parse` →
`engine.parseType(result)` never hands `parseType` the raw def. The NAME renders VERBATIM — never
lower-cased, never decorated — because a model reads this surface and a sibling type system's in
one session, and a spelling difference between them reads as two types. For the same reason the
name pattern is `^[A-Za-z][A-Za-z0-9_]*$`: capitals are ALLOWED, matching the shipped
`FUNCTION_NAME_PATTERN` that lets `ST_Contains` register, and measured to be necessary — a sibling
library refuses a lower-case package type name, so a lower-case-only rule here would leave a
shared name unspellable in one library or the other.

**Registration is all-or-nothing**, because a refinement that registered half-broken would be
wrong on every column that ever named it. `base` is a `ScalarKind` other than **`relation`**,
which is refused outright: its `to` is an IDENTITY and its `count` a cardinality ESTIMATE, neither
of which is a constraint a name can narrow, so a use site had to restate both verbatim (the
duplication a refinement exists to remove) and a declaration naming only one of them registered
cleanly and then refused every column that used it, blaming the column. Beyond that: the name
matches the pattern, is not a builtin `kind`, and is not already registered (the second declarer
is refused, naming the incumbent's `declaredBy`); `options` parse as a def of the base kind, with
that road's own message; `avgBytes > 0`; and `instructions` is non-empty and **REQUIRED** —
deliberately stricter than `FunctionDef.instructions`, and the reason is measured: an undocumented
registered item renders as a bare tag beside documented siblings, and a model choosing among them
guesses, which costs a validate-fail retry carrying the whole schema. Every failure is a
`QueryTypeError` (`field-type.bad-refinement`), and an `as` naming nothing registered is refused
(`field-type.unknown-refinement`, with a `didYouMean`) rather than degraded to the bare base,
because degrading silently would take the narrowing with it.

**Ordering is ENFORCED, not advised.** `registerFieldType` / `registerFieldTypeImpl` throw
`field-type.late-refinement` once that registry has built a FIELD TYPE — armed at the parse
itself, so `parseType`, `registerType`, `parseFieldType`, `Type.from` and a declared function
parameter all count, rather than only the first two. A stored `as` resolves against the registry
as it stood AT PARSE TIME, so a runtime-installed system registering `uuid` after the catalog
crawl would leave every already-built column carrying the un-narrowed base — the `LOWER()` this
feature exists to remove — while the type tag still read `text` and nothing raised. A late IMPL is
worse: it attaches to the compiled refinement every column naming it SHARES, so it retroactively
changes what an already-handed-out column validates against, mid-process. That is the one failure
in this design that would otherwise be silent, which is why it is a refusal rather than a sentence
in the docs.

**An unknown declaration key is REFUSED, not ignored.** TypeScript's excess-property check only
fires on an INLINE literal, so `registerFieldType(JSON.parse(stored) as FieldTypeRefinementDef)` —
the road these docs advertise — would type-check and silently drop anything unrecognised. For the
one key that MOVED (`value`) that is the exact dead-gate end state the impl split exists to
prevent, reached from the other side, so it is refused by name with its new home. The key list is
compile-checked against the declaration interface, so the two cannot drift.

**SQL.** `Dialect.sqlTypeFor` answers the refinement's `sql` for that dialect; a dialect with no
entry falls back to the base kind's own mapping — a FALLBACK, not a degrade, because the base's
answer is a real answer for a value of the base type. `cast` (which must place `{value}`) replaces
the wrapper a bound DOCUMENT is cast with — and is **declarable only on a `json` or `array` base**,
because `Dialect.jsonValue` is the only road that reaches a cast template while a scalar predicate
binds its value directly. Measured on the documented `uuid` example: a `cast` there validated at
registration and the predicate stayed `WHERE "thing"."id" = $1`, i.e. accepted and inert on every
scalar predicate over the column. It is refused now, naming `sql` (the cast TARGET) as what a
scalar base declares instead. Both templates are validated at registration: a `{slot}` must name a
declared option whose value is a bare identifier/number token — the templates are
raw-interpolated, so the values spliced into them are the injection surface, not the template body
— and a resolved `sql` must look like a SQL type name.

**Not here, deliberately:** custom OPERATORS (`&&`, `<->`, a new `operator` expr kind) and an
in-memory `compareValues` hook. Custom OPTION declarations and declared comparability landed
alongside this in the same release — see the section below.

**One internal contract changed, for anyone who SUBCLASSES `FieldType`** — nobody has to, and a
declaration is now the recommended road. The four members a refinement can override are template
methods: implement `builtinJSON` / `builtinClone` / `builtinValueSchema` / `builtinAvgBytes`
(protected) instead of `toJSON` / `clone` / `toValueSchema` / `avgBytes`. The base owns the public
four and applies the refinement around them, so a class that implements only the hooks is correct
by construction. **Every public signature is unchanged** — the builtins re-declare `toJSON()` /
`clone()` with their own branch return type and route through the base's combinators.

**And one for anyone who SUBCLASSES `Dialect`**, which is the documented road for per-dialect
emission, so read this one even if the paragraph above does not apply:

- `sqlTypeFor` went abstract → CONCRETE (it consults the refinement's `sql`, then delegates), with
  `protected abstract builtinSqlTypeFor` as the new override point. This is a **loud** break: an
  external `extends Dialect` stops compiling until it renames, which is the good kind.
- `jsonValue` is now a FINAL wrapper (it consults the refinement's `cast`, then delegates) and
  `protected builtinJsonValue` is the override point. This one would be **silent** — an external
  dialect overriding `jsonValue`, which `PostgresDialect` itself modelled, keeps compiling and
  quietly disables every refinement `cast` on that dialect. The saving grace is the row above:
  the same class must be touched anyway for `builtinSqlTypeFor`, so the rename is caught at the
  same moment. Rename both.

### A refinement declares its OWN options, its own comparison grammar, and who it compares with (**additive**)

Step 2 of the same work, and the part that makes a registered type more than a name. Everything
above stays exactly as it was: `options`, `sql`, `cast`, `avgBytes`, `instructions`, the meet, the
late-registration refusal. What is new is the three facts the BASE's vocabulary cannot express.

```ts
registry.registerFieldType({
  name: 'Geometry', base: 'json',
  instructions: 'A PostGIS geometry, carried as GeoJSON. Compare with ST_Contains / ST_Within, or order by ST_Distance; `<` and LIKE are not defined on one.',
  ownOptions: {
    subtype: { type: { kind: 'text', values: [{ value: 'Point' }, { value: 'Polygon' }] }, default: 'Point' },
    srid:    { type: { kind: 'number', whole: true }, default: 4326 },
  },
  sql:  { postgres: 'geometry({subtype},{srid})' },
  cast: { postgres: 'ST_GeomFromGeoJSON({value})::geometry({subtype},{srid})' },
  compare: { equality: true, ordering: false, textMatch: false },
  comparableWith: ['Geography'],
});
// on a Type:  { name: 'shape', type: { kind: 'json', as: 'Geometry', with: { subtype: 'Polygon', srid: 4326 } } }
```

**`ownOptions` + a column's `with` bag.** An option's `type` is an ordinary `FieldTypeDef`, so
validation, the model-facing description and the JSON round-trip come from machinery that already
exists — the same relationship `FunctionDef.params` has to its parameter types. **TWO BAGS,
deliberately**: `options` narrows the base's vocabulary, `ownOptions` declares new ones, and a
column writes the second under `with`. Merging them would make a `{maxLength}` slot ambiguous
between the base's option and a refinement's, and would force the strictly-parsed branch schemas
open — after which a typo'd base option would be read as somebody's custom one. `FieldTypeDef`
gains exactly one optional key (`with`) on the shared `FieldTypeRefinementKey`, so `ScalarKind`,
the nine branches and every exhaustiveness guard are as closed as they were.

**The measured delta over step 1: the cast target is now PER COLUMN.** Two columns naming one type
emit `geometry(Polygon,4326)` and `geometry(Point,3857)` from ONE declaration. Under step 1 a
refinement's `sql` was a single string resolved at registration, so every column of a type shared
it — and a `Point` column would have been cast to the wrong type on every predicate over it. A
base-option slot still resolves at registration (those are constants); an `ownOptions` slot
resolves per column, which is why `Dialect.sqlTypeFor` / `jsonValue` now ask the FIELD TYPE
(`refinedSqlType` / `refinedCast`) rather than its refinement. **No dialect signature changed.**

**A default is resolved on READ, never materialized.** A column that named no options carries no
bag at all — so an existing def serializes byte-for-byte as it did, and, more importantly, a column
that said nothing MEETS a column that said `Polygon` rather than conflicting with the declared
default. **They meet through the flat `meetExact` lattice, per key**: unset is TOP, equal keeps,
two different values conflict, and the merged bag's keys are SORTED because `meet` compares two
types by their serialized form. Again **no new law** — the six the builtins are held to, plus the
two the `as` tag added, pass over a set carrying every arm of this (unset, one set, both set, a
sibling differing in exactly one, a refined element inside a container) with **no carve-out**.

**THE INJECTION SURFACE MOVED, so the check did — this is the safety half.** Through step 1 a
template slot's value was a DECLARED CONSTANT, checkable once against a bare-token pattern. An
`ownOptions` value is the COLUMN AUTHOR's, and emit is far too late to find out. Three checks
replace that one:

1. an option any template interpolates must have a **CLOSED declared type** — a `values` set whose
   members are all bare tokens, a `bool`, or a `number` with `whole: true` — and must declare a
   `default`, so the template resolves for every column. Answered by `FieldType.tokenSafeValues()`,
   declared ON the type rather than switched on by kind;
2. the template is validated against **PROBE tokens** (`a`, `_`, `0`) rather than against one
   resolved string, because a template must be a legal SQL type name for EVERY value its option can
   hold. `geometry(Point,{srid})` passes; `{srid}_geom` — which would emit `4326_geom` — is refused
   at the DECLARATION rather than on the one column that trips it;
3. each column's actual value is re-checked as a bare token at PARSE, which catches the residue a
   closed type still admits (`-1`, `1e21`).

Together they make emission total: no reachable value can produce a token the templates were not
checked for. A column's bag is otherwise checked exactly where every other declaration defect is —
an undeclared option is `field-type.unknown-option` (with a `didYouMean`), a bad value is
`field-type.bad-option` (naming the members), and a `with` with no `as` is refused rather than
dropped.

**`compare: { equality, ordering, textMatch }` — which arms of the builtin PREDICATE grammar
apply.** `ComparisonOp` is a CLOSED nine-member union and it stays closed: a type does not ADD an
operator, it says which of the nine mean anything for it. Every arm defaults to `true`, so an
existing declaration keeps the grammar it had. The refusal is `Problems`-grade and QUOTES THE
TYPE'S OWN `instructions`, because a bare refusal costs the retry it was meant to prevent — the
model then has to guess what to reach for. Neither operand is exempt, unlike the comparability
check which excuses a bare param: the fact belongs to the COLUMN's declared type and holds whatever
it is compared to.

**All THREE predicates share one gate, keyed by ARM rather than by operator.** `ordering: false`
refuses `BETWEEN` as well as `< <= > >=` (it IS `>=` and `<=`), and `equality: false` refuses `IN`
as well as `=` / `<>` (it is a disjunction of `=`). Keyed by `ComparisonOp` the gate was reachable
only from `ComparisonExpr`, so a model refused at `shape < :p` restated it as
`shape BETWEEN :p AND :q` and got `WHERE "parcel"."shape" BETWEEN $1 AND $2` — the exact SQL the
refusal exists to prevent, from a one-token rewrite.

**AND CONTAINMENT, because `contains` is `IN` with a different keyword** — it emits a literal
`$1 = ANY("t"."list")`. `array-op`'s three containment ops are gated on `equality`; `isEmpty` /
`notEmpty` are not, because `cardinality(…) = 0` compares a COUNT and never an element. Both
refinement positions are checked: `declaredArmRefusal` reads `ft.refinement`, which on an array is
the ARRAY's own tag, so a refined array and an array of a refined ITEM are two different places to
look and a single check at the top of the expr found only the first.

**WHERE IT IS NOT ENFORCED IS A LIST, NOT A SLOGAN.** An earlier draft of this section said "it
gates predicates, not sorts", which was both wrong (containment is a predicate and was ungated) and
not a partition (grouping is neither). Measured as accepted over a column refusing the relevant arm:
`ORDER BY <column>`, `min` / `max`, window `ORDER BY` — all ordering, all one answer, and closing
them must keep `ORDER BY ST_Distance(shape, :here)` working, so the gate belongs on a bare COLUMN
REFERENCE in a sort position; `SELECT DISTINCT`, `GROUP BY`, window `PARTITION BY`,
`UNION` / `INTERSECT` / `EXCEPT` — equality used to BUCKET rather than to filter, which is a real
question rather than an oversight; and `text-search`, which `textMatch: false` does not refuse.
`aeye-query.md` carries the same table where a reader will look.

**`compare` gates the GRAMMAR, never the LATTICE** — a type declaring every arm `false` still meets
like any other, and tying the two together would owe `x ⊓ ⊤ = x` a carve-out on the first such type.
It also now REACHES THE MODEL: the type tag renders the refused arms
(`json(as Geometry,subtype=Polygon,srid=4326,no <,no LIKE)`) and the `as` enum's glossary carries
`(refuses: <, LIKE)`. Until it did, the only channel was whatever the declarer typed into
`instructions`, so a model discovered the refusal by writing a predicate and failing validation —
which by this release's own accounting costs thousands of tokens to save twenty.

**`comparableWith` — compatibility as a declared relation, symmetrized by the REGISTRY.** The
declared form of the hardcoded `number`/`money` and `date`/`timestamp` families. Naming a type that
does not name you back records the edge in BOTH directions and files a `warn`-grade note
(`registry.fieldTypeComparabilityNotes()`, `field-type.one-sided-comparability`), so commutativity
is structural rather than the declarer's discipline — and a name may be declared BEFORE the type it
names is registered, which a mutual pair otherwise makes impossible. **It only ever GROWS the
relation, and that is load-bearing**: `meet` implies `comparableWith`, so a declaration that could
REMOVE an edge would have to remove `refinement ⊓ its own base` with it, i.e. break the top
identity. Correspondingly a declared edge does NOT create a meet — comparable-and-un-meetable is an
existing, real state (two disjoint closed sets), and keeping it is what lets the relation be
NON-TRANSITIVE, which `Meters`/`Feet`/`Number` needs it to be.

**`@aeye/query/conformance` — the builtins' own property tests, exported.** A declarer cannot break
the lattice by writing CODE, because the library compiles the meet from the declaration. What a
declarer CAN do is declare a shape whose consequences they did not follow through, and none of that
is detectable at registration — each declaration is individually legal, and the defect is only
visible as a PROPERTY over a set of types. So the runner ships:

```ts
import { checkFieldType } from '@aeye/query/conformance';
expect(checkFieldType(geometryDecl, { value: geoJsonSchema, samples: [aRealPoint] }).problems).toEqual([]);
```

`checkFieldType(decl, impl?)` builds a registry, a peer refinement over the same base, a column per
value of each declared option and the unrefined top of every refinable kind, and runs every law over
that set — returning `Problem[]` rather than throwing. `checkLatticeLaws(types, opts)` is the runner
itself over any set: **commutative, idempotent, associative, top-identity, meet-implies-comparable,
sound**, plus **refinement-base**, **refinement-instance**, **round-trip** and **total**.
`param-meet.test.ts` now CALLS that function instead of carrying its own copy of the loops, so the
export is exercised against a correct implementation on every run of this package's suite, and each
law additionally has a positive control proving it fails on a set that breaks it. With an
`impl.value` it adds the two cross-library checks: the gate must agree with the declared base bucket
and must not be vacuous.

**Two limits of the conformance export, stated rather than discovered.** It cannot tell whether the
emitted SQL means what you intended, or whether an in-memory answer agrees with the database's;
those need a live connection and belong in a consumer's integration suite. And **the subpath
resolves to the same bundle as `@aeye/query`**, which is a packaging decision with one measurement
behind it. A second build entry either splits or it does not, and the not-splitting half is
disqualifying: `--no-splitting` gives each entry its own copy of every class, so
`instanceof ArrayFieldType` is FALSE across them — a consumer's `array` type met against the
harness's own `array` TOP answered `undefined`, and `checkLatticeLaws` then reported a spurious
`top-identity` violation for a correct type. A harness that fails correct input is worse than no
harness. The splitting half BUILDS AND RUNS (tsup 8.5.1, both import orders), but puts this
package's circular re-exports — `shape/index.ts` ↔ `shape/shape.ts`, `exprs/index.ts` ↔
`exprs/field-ref.ts`, `field-types/index.ts` — across a chunk boundary, which rollup itself warns
"will likely lead to broken execution order" in warnings the DTS pass prints verbatim. That is a
hazard taken on for no gain, since there is one module either way. One bundle, two specifiers;
prefer the subpath, which is what the docs name. `npm run build` now ends by importing the built
artifact through BOTH specifiers and calling into it, because the suite runs from `src` and cannot
see a packaging failure at all.

**One internal contract changed, for anyone who SUBCLASSES `FieldType`** — the same shape as the
four template methods step 1 introduced. `comparableWith` is now FINAL (it adds the declared edges
around the builtin rule) and `protected builtinComparableWith` is the override point. A subclass
overriding the public method stops compiling, which is the loud kind: leaving it overridable would
let a builtin that narrows the rule silently shut a declared edge out. `ArrayFieldType`,
`JsonFieldType` and `RelationFieldType` are renamed accordingly. `FieldType` also gains
`tokenSafeValues()` (concrete, with a `values`-derived default), `refinedSqlType(dialect)` /
`refinedCast(dialect)`, `refinementOptions` and `refinementOption(key)`.

### A registered OPERATOR: `&&` / `<->` — SQL a DECLARATION supplies, per dialect (**additive**)

Step 3, and the one gap step 1 and step 2 both left open in writing: *"No infix operators. `&&` /
`<->` have no call form; only `name(a, b)` is emittable from a declaration."* `registerFunction`
covers everything shaped `name(a, b)` — a PostGIS-shaped domain already emitted valid SQL through
it, which is why this is step 3 and not step 1. What a function declaration cannot express is the
other half of a real SQL domain: an INFIX operator has no call form in ANY dialect, and
`FunctionDef.sql` is a NAME, never a template, so per-dialect emission was a `Dialect` subclass.

```ts
registry.registerOperator({
  name: '&&',                                      // SQL operator punctuation ONLY
  operands: [{ name: 'left',  type: { kind: 'json', as: 'Geometry' } },
             { name: 'right', type: { kind: 'json', as: 'Geometry' } }],
  output: { kind: 'bool' },                        // CONCRETE — never 'inferred'
  instructions: 'Bounding-box overlap between two geometries. A pre-filter for ST_Contains.',
  emit: { postgres: '({left} && {right})' },       // per `Dialect.name`; PARENTHESIZED
  selectivity: 0.1,
});
registry.registerOperatorRun('&&', (args, ctx) => Value.of(bboxOverlaps(args.left, args.right)));
// { kind:'operator', op:'&&', args:{ left: <expr>, right: <expr> } }
//   →  WHERE ("parcel"."shape" && ST_GeomFromGeoJSON($1))
```

**ONE new expr kind, not N registered Expr classes.** `ExprKind` gains exactly one member, once,
at this package's own hand; the operator VOCABULARY is what a third party opens — precisely the
relationship `function-call` has to `registerFunction`. The alternative, `defineExpr`, is parse
DISPATCH for a whole `ExprDef.kind` (registering one re-points every program's parse in that
registry) and asks a declarer to implement ten members for `a && b`, where a function author
writes one JSON object. `OperatorExpr` reuses the whole of `exprs/_function-args.ts`, and the
three call checks (`missing-arg` / `unknown-arg` / `arg-type`) are now ONE shared
`validateNamedCall` rather than a second copy — A22 is the standing evidence that a second copy
drifts: three of the four call-shaped exprs never observed their params and the fourth did.

**A bare bind param as an OPERAND is typed by the declaration**, exactly as A22 made a function
argument be — `shape && :box` types `:box` from `&&`'s declared operand rather than judging it
against the `text` placeholder, order-independently. The param's type is the OPERAND's, not the
column's, which is right: `&&` accepts any geometry, and narrowing it to whichever column it sat
beside would refuse a second use against a different SRID.

**A dialect with no `emit` entry is REFUSED at emit** (`operator.unsupported-dialect`, naming the
dialects that ARE declared), and that asymmetry with `BaseDialect.emitBuiltinCall` is the point.
The base dialect degrades silently for BUILTINS (`dateAdd` → the input date unchanged,
`arrayContains` → `(1 = 0)`) because that is portable-SQL policy for a function whose semantics
this package owns, documents and tests. A third party cannot document a degrade this package
never sees, and `&&` degrading to `(1 = 0)` returns ZERO ROWS for a query the caller believed ran
— a wrong answer that looks exactly like a right one.

**The emit template is checked at the DECLARATION, five ways, and the risk profile is NOT step
2's.** A template's slots are filled with already-emitted `SqlText` fragments, never with author
VALUES, so there is no value-injection surface to close — what is guarded is the template BODY,
and it is a name-and-shape gate rather than a sandbox: (1) every `{slot}` names a declared operand
(with a `didYouMean`); (2) every declared operand APPEARS — a dropped one is an argument the query
supplied, validation type-checked, and emission discarded, the same defect a `cast` that never
names `{value}` has; (3) the template is **wrapped in its own balanced parentheses**, which is
what makes a `precedence` declaration unnecessary rather than merely unread — a parenthesized
fragment composes correctly inside ANY surrounding expression, so no declaration can be wrong
about binding (a function-shaped emission is written `(ST_Intersects({left}, {right}))`, with the
redundant pair, because one rule with no exception beats the character it costs); (4) no comment
sequence and no `;`, both of which silently swallow the rest of the emitted query; (5) balanced
parens and an EVEN number of `'` quotes. Check (1) additionally sweeps for a **`{` residue**, since
the scanner only matches a CLOSED `{…}`: `({left} && {right} {oops)` and the nested `(x{q{a}})`
both registered clean and emitted a literal brace into the SQL, which is the very thing the
unknown-slot refusal exists to prevent, reached by the one road it could not see. And the
parenthesis walk indexes by UTF-16 CODE UNIT rather than code point, because it compares against
`String.length`: `'({left} && {right} 𝕏)'` is legally wrapped and was refused, with a message about
parentheses that pointed a declarer at the wrong thing.

**The name charset is SQL operator punctuation and nothing an identifier could be** —
`^[+\-*/<>=~!@#%^&|`?]{1,63}$`, which is what PostgreSQL's own `CREATE OPERATOR` allows (63 is
`NAMEDATALEN - 1`). It is deliberately DISJOINT from `FUNCTION_NAME_PATTERN`, so one spelling can
never name two callables and a model reading the catalog never has to wonder whether `overlaps`
is the operator or the function; a WORD operator is spelled as a function, or as the literal text
of an emit template under a punctuation name. **The comment openers are refused separately**,
because they are made of that same punctuation: `&&--` matches the charset exactly. In a TEMPLATE
that comments out the rest of the emitted query including whatever wrapped it. In a NAME it is
DEFENCE IN DEPTH rather than a live hole — the name never reaches emitted SQL, since
`OperatorExpr.toSQL` emits template parts and operand fragments only — but the declarer writing
the template pastes the name into it, and a rule that holds in one place and not the other is the
kind nobody remembers. PostgreSQL applies the same rule for the same reason.

**Operators and a type's declared `compare` are DISJOINT, deliberately.** `compare` says which
arms of the closed nine-member comparison grammar apply to a type; an operator is not one of the
nine — it declares its own operands and its own meaning. A type declaring `equality: false` is
therefore exactly the type an operator is FOR: `Geometry` refuses `=` because comparing two
geometries for equality is meaningless, and `&&` is what a caller reaches for instead. Gating
operators on `compare` would delete the mechanism that makes an honest declaration usable.

**A missing `run` REFUSES (`operator.no-run`), which is the one place this package's "a missing
run answers NULL" rule does not apply.** The parity with `registerFunctionRun` does not hold, and
the asymmetry in the declaration itself is why: `emit` is REQUIRED and `run` is OPTIONAL, so an
operator is far more likely to lack one than a function is — and an operator is usually a
PREDICATE, where NULL is UNKNOWN for every row, so the query returns ZERO ROWS and looks exactly
like one that ran. That is precisely the failure an unsupported dialect is refused for, and
producing it on the in-memory road while refusing it on the SQL road would be incoherent. A
SQL-road-only operator stays a legitimate shape; it simply cannot be EVALUATED, and says so.

**An operator can RECONSTRUCT a refused arm**, and that is intended rather than a hole: an operator
NAMED `=` over a type declaring `equality: false` validates clean while the builtin `=` over the
same column is refused, because your `=` means what you say it means. What the first cut did not do
was DISCLOSE it — `describeTypes` prints `no =` on the column while `describeOperators` offers a
`=` over it in the same catalog, with nothing saying which wins. `checkOperator` now warns
(`conformance.shadows-refused-arm`) when an operator's name spells a builtin comparison token over
an operand refusing that arm, pointing the declarer at the one channel that reaches a model: its
own `instructions`.

**Compiled EAGERLY at registration, unlike a `FunctionDef`** (which the engine parses lazily on
first call), because an emit template is only ever wrong at its declaration and a failure at a
call site has no declaration to attribute it to. That costs one ordering rule — a refinement an
operand names must be registered first, reported with the message that road already has — and it
does NOT freeze the refinement vocabulary: the operand types parse through the registry's
unflagged road for exactly that reason, so `registerFieldType` still works afterwards.

**What the model is told.** `describeOperators(engine)` renders an `operators:` block — each
signature, its result type, its `instructions` and its examples — and `describeEngine` folds it in
whenever any operator is registered, omitting it entirely otherwise. **An operand tag names the
registered TYPE and only the options the DECLARATION wrote** (`left: json(as Geometry)`), never the
refinement's defaults and never the refused-arm tail: an operand's type is a COMPARABILITY
constraint, so rendering `subtype=Point` there beside a column reading `subtype=Polygon` gave a
model every reason to conclude the column was not a legal operand. The refused arms belong to the
COLUMN's grammar and the `types:` block already carries them per column — repeating them per
operand is also the bulk of a large vocabulary's prompt cost.
In the generated schema `op` is a `z.enum` of the registered names with that glossary inline (at
`functions:'names'`), each operator gets a STRICT operand object at `functions:'typed'`, and the
`operator` KIND is capability-gated out unless some registered operator has an operand type an
in-scope field could supply — so a geometry-free deployment carries no dead branch.
`exprKindApplicable` gains an optional 4th argument (the registry) for that gate; the existing
3-argument call keeps compiling and gets no operator branch, which is the safe answer.

**Three members §6 of the design specified that this release deliberately does NOT ship**, each
refused at registration with the reason rather than as a bare "unknown key": `precedence` (nothing
reads it — emission is always parenthesized and `toCode()` renders the wire shape `&&(left: …,
right: …)`, because an infix rendering needs the declared operand ORDER and `toCode` has no
registry to look it up in, so it would silently swap a non-commutative operator's operands),
`indexed` (the cost model's `IndexProbe` means "bound to N POINT values", which is what an index
PREFIX reduction is computed from — crediting a bounding-box overlap would claim a reduction that
does not apply; declare `selectivity`, which the same model reads and says the true thing), and
`changes` (`QueryReferences` enumerates FUNCTIONS and there is no operator channel, so a declared
value would be silently ignored — adding one changes a public result shape and belongs with the
in-memory work). **The `changes` refusal will age**, and it is worth saying so rather than only
"nothing would read it": `changeInterval` systematically OVER-estimates freshness for any query
whose only volatile input sits behind an operator, and the fix is the missing channel.

**`checkOperator(decl, { registry })`** joins `checkFieldType` on `@aeye/query/conformance` and
asks the questions registration cannot: that every declared `emit` dialect is actually REGISTERED;
that every shipped `examples` string parses and is a use of THIS operator; that its operand names
match the declaration (the structural parser accepts any `args` record, and an example has no query
around it to validate); and the shadowed-arm warning above. **The dialect key is the one thing
eager compilation deliberately does not judge**, and the two rationales reconcile rather than
conflict: everything an operator can be judged on ALONE is refused at its declaration, while an
`emit` key can only be judged against a FINISHED registry — a dialect may be registered after an
operator (`defineDialect` is public and order-free), so refusing an unknown key at registration
would order-couple the two for no reason, exactly as freezing the refinement vocabulary would. The
cost is real and stated: `{ postgress: … }` registers cleanly, describes itself normally, and is
refused at emit on every dialect that exists. It also re-runs the lattice laws over the operand /
output types, which must be UNCHANGED — `param-meet.test.ts` now registers two operators over its
type set and asserts a byte-identical verdict against an operator-free twin, because an operator
is a leaf and must perturb nothing.

**AN OPERAND'S DECLARED TYPE REACHES EMISSION, which is what makes the flagship predicate legal
SQL.** A document operand — a `literal`, or a param bound to one — binds through that type's own
`cast` template rather than through the dialect's default json cast. Without it, `shape && :box`
emitted `("parcel"."shape" && CAST($1 AS jsonb))` and Postgres refused the statement outright:
`operator does not exist: geometry && jsonb`, because the column is DDL'd `geometry(Polygon,4326)`.
The column side was always right (its own declared type reaches `sqlTypeFor`); the VALUE side had
no type to reach with.

**No inference is involved**, which is why it belongs here rather than in the wider param-typing
change: an operand's type is DECLARED, so it is known at emit whether or not a validation walk ran.
`Dialect.jsonValue(value, fieldType?)` has always taken the type — until now exactly ONE road
supplied it (`writeCellSql`), and that routing decision now lives in `exprs/_bound-value.ts` with
two callers, a write cell and an operator operand, rather than being copied.

**A VALUE POSITION MAY ASSERT ONLY WHAT ITS DECLARATION WROTE**, and getting that wrong is how the
first cut still failed at the database. A refinement's `cast` resolves its option slots from the
column's own bag ELSE the option's declared DEFAULT — which is exactly right for a COLUMN (a
default is a fact about it) and exactly wrong for a VALUE. An operand declaring `{kind:'json',
as:'Geometry'}` with no `with` therefore cast a Polygon document to `::geometry(Point,4326)`, a
PostGIS TYPMOD, and the server refused it (`Geometry type (Polygon) does not match column type
(Point)`) — on the NORMAL case, since `&&` is a bounding-box pre-filter whose argument is usually a
box. It also contradicted this release's own operand RENDERING rule, which shows only what a
declaration wrote for precisely the same reason.

So a `'value'` position resolves a cast only from what it wrote, and a cast interpolating an option
it did not write is REFUSED at emit (`cast.unwritten-option`) rather than filled from a default or
degraded to the base cast — the first emits SQL the server rejects, the second re-emits the
`CAST($1 AS jsonb)` that broke this road to begin with. The refusal names both resolutions: declare
a `cast` that interpolates NO option (one that says only "this IS a Geometry", which is all a value
position can honestly assert — the shipped example now does this, with the typmod living in `sql`,
the cast TARGET, where it belongs), or write the options in the operand's own `with`, which makes
the typmod a constraint the declaration actually made. `FieldType.uncastableOptions(dialect)` and
`FieldTypeRefinement.castOptions(dialect)` are the accessors; a COLUMN's behaviour is unchanged.

**The same defect remains for a FUNCTION argument, and for a bare `literal` / `param` anywhere
else**, and that half genuinely is a release of its own: a `FunctionDef` param type would fix it
identically, but retro-fitting it moves the emitted SQL of every existing `json` argument in every
consumer, where `operator` is a brand-new kind with none. `aeye-query.md` states the boundary —
there is no workaround for a function argument, since a function cannot declare its own SQL, so
reach for an `operator` when the cast matters.

### Also

- **`didYouMean` no longer THROWS while composing a diagnostic.** It read the bad name's `length`
  for its edit budget, and the value it is handed is by definition an unchecked one — so a def
  missing the name entirely (`{kind:'text-search', query:'x'}` with no `source`) produced a raw
  `TypeError: Cannot read properties of undefined (reading 'length')` out of `aids.ts` instead of
  a Problem, turning a reportable defect into an uncaught crash on the one road whose whole
  contract is that a defect is REPORTED. Reachable only via the unchecked `validateQuery` /
  `validateExpr` (the defensive `parseCheckedQuery` refuses the shape first), and fixed in the
  suggester rather than at the one call site that tripped it, because every unknown-NAME
  diagnostic in the package reads the same kind of value.
- **One `{slot}` TEMPLATE SCANNER, shared** (`src/sql-template.ts`: `scanTemplate` / `isSlot` /
  `templateSlotNames`, all exported). A refinement's `sql` / `cast` slots name its OPTIONS and an
  operator's `emit` slots name its OPERANDS — two different vocabularies filled with two different
  things, but scanned identically, and a scanner that differed by one character between them would
  let a spelling pass one declaration road and be read as literal text on the other. The caller
  still owns every decision that is not scanning: what a slot may name, what the resolved text must
  look like, and what a missing one means.
- **A function's EMITTED name (`sql`) is now identifier-guarded like its `name`.** The four
  call-shaped exprs emit `${fn.sql ?? fn.name}(` by raw interpolation, and `registerFunction`
  checked only `name` — so the identifier guarantee its doc comment states ("the generated SQL can
  never contain an unescaped arbitrary string") was reachable around, through the one field whose
  purpose is to REPLACE the checked one. `sql` is now held to the same
  `^[A-Za-z_][A-Za-z0-9_.]*$`. **Registration can throw where it did not**: a `sql` that is not an
  identifier was already emitting broken (or injected) SQL, so this surfaces it at the
  declaration.
- **The `shape/` combinators reach the public barrel**, as the namespace `shape` (plus the types
  `Shape` / `CheckCtx` by name): `import { shape } from '@aeye/query'` →
  `shape.obj({ kind: shape.lit('…'), … })`. They were exported from `src/shape/index.ts` and
  nowhere else, so a class defined OUTSIDE the package could satisfy `defineExpr` — validating,
  costing, emitting SQL and self-describing correctly — and still be refused by
  `parseCheckedExpr` / `parseCheckedQuery` with `shape.unknown-kind`, which is the active
  structural gate a model-authored query goes through. A namespace rather than flat names because
  `lit` would otherwise SHADOW the expression builder's `lit` for every existing consumer. This
  makes a `SHAPE` authorable; it does not open `ExprKind`, which stays a closed union.
- **`FunctionDef.sql` is documented as what it is.** The comment called it a "SQL template"; the
  emit path substitutes the identifier and nothing else, so `name(arg, arg)` is the only form a
  declaration can produce. Per-dialect or differently-shaped emission is a `Dialect` subclass
  overriding `emitBuiltinCall` — which is what the builtins already do.
- **`aeye-query.md` now documents that a DOMAIN vocabulary needs no new field type.** Registering
  `ST_Contains` / `ST_Distance` as ordinary scalar functions over a `{kind:'json'}` column emits
  valid PostGIS today (`WHERE ST_Contains("parcel"."shape", CAST($1 AS jsonb)) ORDER BY
  ST_Distance(…) ASC`), with the four honest limits named: the cast target is the BASE's, there
  are no infix operators, the domain's meaning reaches the model only through `instructions`, and
  a meaningless `json < json` ordering is not refused. The emitted SQL is asserted by a test, so
  the doc cannot rot.
- **`syntheticType`'s per-row byte estimate** dropped a defensive `estimate?.bytes ?? 0`.
  `Cost.bytes` is required, so the fallback could only ever have hidden a `Cost` that was not
  one; `estimate` is re-tested instead, which narrows properly.
- **`semanticTexts` on an engine with no registered dialect** is now covered by a test rather
  than only by inspection.
- **A known limit that is NOT new, found while measuring one that is.**
  `z.toJSONSchema(Type.toSchema())` throws `RangeError: Maximum call stack size exceeded` — on this
  release and on released `0.6.5` alike. `ArrayFieldType.toSchema`'s `z.lazy(() =>
  fieldTypeDefSchema(opts))` returns a FRESH schema on every call, which defeats zod's
  identity-based cycle detection; the query road escapes it only because `schema-build.ts` gives
  its lazies stable ids (`aids.ts`). So a "author a Type" tool cannot generate a JSON Schema off
  `Type.toSchema` today. It is recorded here because this release's `as` key is justified partly on
  JSON-Schema representability (`z.never()` renders `{"not":{}}`; `z.undefined()` throws, and under
  `unrepresentable: 'any'` renders as *permit anything* — the opposite of the intent), and that
  argument is true of a SINGLE BRANCH's schema, which is what the test asserts. Fixing the union
  needs a stable-id lazy and is not this release's change.
- **Two known limits, stated rather than discovered.** `write.value` names the members through
  `describeValues`, which ELIDES past `MAX_DESCRIBED_VALUES` (12) — so a larger set yields a
  refusal whose remedy is partial. That is deliberate: it is the same rendering the model was
  shown the column with, so the error can never list a member the description did not. And
  `FieldType.meet`'s identity short-circuit assumes "same kind + same BUILTIN def ⇒
  interchangeable", which holds for every builtin EXCEPT `relation`, whose `inverseVia` is never
  serialized — harmless as used (a param's relation type is never traversed as a join) but noted
  at the site for anyone reaching for `meet` outside param inference.
- **`describe-generate`'s field-type exhaustiveness guard no longer THROWS.** It was
  `assertNever`, and the kind union is closed at COMPILE time while the registry's `kind → class`
  map is open at RUNTIME (`defineFieldType` is public) — so a registry carrying a class the
  package does not ship crashed `describeType()` / `fieldMeta()`, i.e. crashed generating the
  default description of any field that has none. It now falls back to the field type's own
  `toCode()`, while the compile-time exhaustiveness over the nine builtins is preserved by a
  `never` binding in the same branch: a TENTH builtin kind still fails to compile there.
- **`registry.fieldTypeKinds()`** enumerates the field-type kinds a registry actually holds.
  "Which kinds exist" was previously only answerable by reaching for the package's static
  `BUILTIN_FIELD_TYPES`, i.e. by asking the PACKAGE rather than the registry — wrong the moment a
  deployment builds a registry that is not `createRegistry()`. `SCALAR_KINDS` is exported for the
  same reason, and `ScalarKind` is now DERIVED from it rather than restated beside it.

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
