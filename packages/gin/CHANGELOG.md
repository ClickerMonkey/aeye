# `@aeye/gin` changelog

Releases before `0.4.0` are recorded in the git log (`chore(release): @aeye/gin <version>`
commits); this file starts here and is the place to look from now on.

## 0.4.2

Four defects found by the first real consumers of `0.4.1`, plus one diagnostic
regression found while fixing them. **Three of the four are `0.4.1`'s own** — the
cost of tightening a seam is that the tightening has to be right, and two places
it was not. `0.4.1`'s headline fixes are confirmed working in a real consumer:
`Resource.parse(handle).raw` now carries its props, and the specialized-generic
path walk resolves (`typeOf(res.data.USD)` is `num`, `validate` is clean).

### The DECLARED type is asked before the node's SHAPE (**the important one**)

`parseValue` tested for the value-envelope shape `'type' in json && 'value' in
json` and refused a node carrying an expr `kind` — **before** consulting
`expectedType`. So the same value got a different verdict depending on how deep
it sat:

```ts
fn.parse({kind:'new', type:{name:'bool'}, value:false})   // OK
obj{probe: fn}.parse({probe: <that same node>})           // THREW
list<fn>.parse([<the new node>])                          // THREW
obj{probe: fn}.parse({probe: {kind:'get', path:[…]}})     // OK
```

`new` is the only expr kind carrying BOTH a `type` and a `value` key, which is
why it alone tripped the envelope branch and `get` in the identical slot did
not. But **a `fn` value IS an ExprDef** — `FnType.parse` and `FnType.valid`
accept a `{kind, …}` node, and `FnType.toNewSchema` describes exactly that to a
model — so a fn-declared slot holding its own body was refused as smuggling.

**0.4.1 did not create this and did not merely expose it; it changed one wrong
answer for another.** Measured on the 0.4.0 tree at the same call:

```
0.4.0  obj{probe:fn}.parse({probe:<new bool false>})
  slot type : bool          ← the LAMBDA replaced by the LITERAL its body constructs
  slot raw  : false
```

That is the corruption class the slot-type reconciliation was written to kill,
and it was live in a shipping product. The refusal was a strict improvement; it
was still the wrong answer for a slot whose declared type says an ExprDef is its
value.

Fixed by making the dispatch order explicit and written out in the body rather
than left to fall out of an `if` chain — **(1)** an already-built `Value`,
**(2)** the DECLARED type when it claims Expr values, **(3)** a `{type, value}`
envelope, **(4)** plain data. New `Type.parsesExprValue()` declares the claim on
the type instead of testing for a class, so it travels with an `Extension` over
`fn`, an `optional<fn>`, an `or<fn, text>`. `any` answers **false**
deliberately: it accepts every value but does not DECLARE that an ExprDef is one
of them. The refusal now also names the slot that refused (`This slot is
declared \`text\`.`).

A value that parses standalone and throws one level in is always a
dispatch-order bug, so the test asserts all four measurements together — the
asymmetry is the thing that must not come back.

### A `Value` is not a payload (**0.4.1 regression**)

`isRecordPayload` did not exclude `Value`, and a `Value` passes every structural
test for "a plain object". So when a nested `{kind:'new', …}` slot was
evaluated, `newFill` handed back the finished `Value` — and `Extension.newFill`,
adding a defaulted stored local prop, **spread it into a fresh object**,
destroying the `(type, raw)` pair. It surfaced three frames later as

```
text.parse: expected string, got undefined
```

blaming a field that was never missing. It needed all three conditions at once —
a NESTED `new`, an Extension with a STORED local prop, and a `default` on it —
which is why it looked like "defaults are broken" from outside: the `default` is
what made the loop write anything at all, and without one the `Value` came back
untouched by luck. This is the `params: [new HttpParam{…}]` form the authoring
guides teach.

`isRecordPayload` now excludes `Value` — the truthful definition, since a
`Value` is a BUILT value and never a payload awaiting construction — which fixes
every site at once. `ObjType`'s own field-map probe routes through the same
predicate.

### `fn.create()` produced a value `fn.valid()` rejects

```ts
r.fn({args: r.obj({x: {type: r.num()}})}).create()   // null
                                        .valid(null) // false
```

The one type whose own constructor produced a value its own predicate refused —
the `map.create()` shape the create/parse sweep exists to catch. It propagated:
`obj{m: fn}.valid(obj.create())` was `false`, and `list<fn>.parse([fn.create()])`
threw **`list.parse: length constraints violated`** for a one-element list with
no bounds declared anywhere.

`fn` sat in the sweep's `noDerivableWitness` bucket on the reasoning that "a fn
value is a JS function / string ref / Expr; there is nothing to synthesize". Two
of those three are indeed underivable — **the third is not, and the declaration
names it.** `fn.create()` is now `{kind:'new', type: <returns>}`, a body that
constructs the declared return type's own zero value: `valid`, runnable, and
deliberately valueless so a fn returning a fn cannot spiral into recursive
`create()` calls. A fn with no declared return gets a `void` body. `fn` moved to
`inhabitable` in the sweep, along with an obj holding a fn field and a
`list<fn>`.

`FnType.parse` is unchanged and still returns `Value(this, null)` for an input
it cannot read (`parse(42)`). That half of the open `parse`/`valid` asymmetry is
a separate ask and is not closed here.

### One mistake now reports ONE problem (**0.4.1 regression**)

`typeOf` returns `any` for everything it cannot infer, and `validateNewValue`
compared that against the slot's declared type — so an unresolvable variable
produced `var.unknown` **and** "this slot is declared `text` but the expression
here produces `any`", the second pointing at the slot instead of at the name the
author got wrong. `any` as a RESULT means "not known", never "known to be
wrong", and is now suppressed. `any` as the declared SLOT type is unrelated and
still accepts everything.

### Two findings reported, not fixed

Both measured, both with the root cause named, so neither has to be
re-discovered:

- **`registry.parse(ext.toJSON())` does not round-trip an Extension**, and a
  slot declared with the result refuses the original with the baffling
  *"declared `HttpParam` but the value carries `HttpParam`"*. Root cause is the
  `extends` fold in `Registry.parseInner`, which re-attributes an Extension's
  LOCAL props to the base — turning SURFACE into SHAPE, so a method comes back
  as a required field and `back.valid(back.parse(row).raw)` is `false`.
  **0.4.1 removed the fold's original justification** (it existed because
  `Extension.parse` never consulted the local; it does now), and the comment at
  the site said so and was stale — corrected. **Not removed, and the blocker is
  specific:** `Extension.compatible` compares BASES only, so moving props to the
  local gives every Extension over `obj` the same empty base and
  `HttpParam.compatible(HttpHeader)` becomes `true`. Compatibility is what every
  declared-return and claim check rests on. Teach `compatible` about stored
  local props first; doing it in the other order silently widens everything.

- **"`validateWalk` does not walk a slot whose declared type is a named
  Extension"** — **could not be reproduced**, across eight shapes including the
  exact `new HttpRequest{headers: [new HttpHeader{…}]}` form, a named type
  extending a NAMED base, a named type carrying a method in local props, a list
  element with and without an inner `new`, and a name bound in a `registry.scope`
  OVERLAY rather than registered. All eight report. One row in the original
  table is explained: a `template` whose placeholder is unresolvable reports
  `template.placeholder.unresolved` rather than `var.unknown` — a different,
  more specific code, not silence. A reproduction against `0.4.2` is welcome.

### Tests

99 files / 1199 tests, up from 98 / 1154. New `fn-slot-expr-value.test.ts` (25
tests; **19 of them fail against 0.4.1**, verified by running the file against
the stashed tree — the six that pass are the deliberate "must not change"
assertions). `new-payload-walk.test.ts` grew the `default`-through-a-nested-`new`
matrix and the single-problem assertions; `fn.test.ts` grew the `create()`
witness and every failure it propagated into.

## 0.4.1

**Five asks from the consuming product, and they turned out to be ONE defect wearing five
faces.** A `Value` is a `(Type, raw)` pair where every nested slot is itself a `Value` carrying
its own concrete type. So wherever a value meets a **declaring context** — a container's element
type, an Extension's local props, a specialized generic's binding, a `new` payload slot — there
are TWO type opinions present. gin kept exactly one of them and silently discarded the other,
and **which one it kept varied by seam**:

| Seam | Kept | Discarded | Symptom |
|---|---|---|---|
| `Extension.parse` | the Type | the raw | `W.parse({id:'i'}).raw` was `{}` while `toValueSchema()` REQUIRED `id` |
| the path walk over a specialization | the declared Type | the raw's per-slot Types | `res.data.USD` ⇒ `no prop 'USD' on type 'alias'` |
| a composite slot | the raw's own Type | the declared element type | a `num` inside a `list<text>`, and `valid()` said true |

The middle and bottom rows are **opposite errors at the same seam class** — one trusts the
declaration and refuses to look at the value, the other trusts the value and refuses to look at
the declaration. That is not two bugs that rhyme; it is one missing step, absent in both
directions. Every claim below was reproduced against `0.4.0` before anything was written, and
each reproduction is now a test.

Two corrections to the asks as filed are recorded at the end — **do not re-file them.**

### The `new` payload: one shared traversal, used by all four consumers (**P0**)

`NewExpr.evaluate` filled embedded Exprs at an obj's OWN fields, one level, and nowhere else.
`Type.newEffects` / `newComplexity` already descended composite element slots — so gin's static
analysis and its evaluator disagreed about what a `new` payload contains. Everything reaching a
list element, a map key or value, a tuple position or a **nested obj** was handed to `Type.parse`
as data:

```
new obj{a:text} <- {a: <get>}                    validate []   run OK      ← the only row that worked
new obj{a: obj{b:text}} <- {a: {b: <get>}}       validate []   run THREW
new list<text> <- [ <get> ]                      validate []   run THREW
new map<text,text> <- [ {key:<get>, value:<get>} ] validate [] run THREW
new tuple<text,text> <- [ <get>, "lit" ]         validate []   run THREW
new optional<list<text>> <- [ <get> ]            validate []   run THREW
```

Every static gate green, the run broken — which is the worst shape a defect can take for an
agent iterating against `validate`.

**And a PERMISSIVE element type made it worse, not better.** `list<any>` — or anything extending
`any` — ACCEPTED the raw `{"kind":"get",…}` node as the value. A program reading a credential
into such a param shipped the expression itself instead of what it evaluates to: a wrong value
on the wire rather than a failure. The type chosen for convenience turned a loud error into a
silent one.

Fixed by making the payload walk **one type-driven recursive traversal** —
`Type.forEachNewSlot(value, visitor)` (sync read) and `Type.newFill(value, engine, scope)` (async
map) — which `newEffects`, `newComplexity`, `validate` and `evaluate` all run on. A type that
decomposes its payload for one consumer can no longer fail to decompose it for another. Slots
evaluate **sequentially in authored order**, because a slot's Expr may carry `STATE` effects.

### `validate` now walks a `new` payload at all (**P0**)

Not "walked it and mis-scoped it" — `NewExpr.validateWalk` returned after one "missing value"
warning without touching `this.value`. So `validate(new obj{a: <get missing>})` reported
`hasErrors: false`, and the belief that an unbound name dies to gin's unknown-variable check was
simply false inside a `new`. Every read an authoring agent writes lives inside some `new`.

Now reported: an unresolvable variable anywhere in the payload (with the problem path pointing at
the slot), and a new `new.slot.type` error where a slot's Expr produces a type the slot cannot
accept —

```
new.slot.type — this slot is declared `text` but the expression here produces `num`
```

A genuine subtype is accepted; a permissive slot stays quiet, because nothing is known there to
contradict.

### A slot enforces its DECLARED type (**P0**, and it was silent)

`{kind:'new', type, value}` and a `JSONValue` envelope `{type, value}` are the same JSON shape,
so an expression written into a value slot was read as a literal of whatever type it named and
`kind` was ignored. Nothing downstream caught the result:

```ts
listText.valid(raw)                       // true   ← ListType.valid asked each cell whether it
                                          //          was valid BY ITS OWN LIGHTS
engine.validateValue(value)               // []
listText.toValueSchema().safeParse([5])   // FAILS  ← the only surface that saw it — and a
                                          //          generated schema is a PROMPT schema,
                                          //          not a validator
```

`Registry.parseValue`'s `expectedType` is now **enforced** rather than used as a fallback, and
every composite's `valid` asks the same question, through one rule: `slotAccepts(declared,
carried)`. A genuine **subtype still lands** — a `Dog` in a `list<Animal>` is what per-slot types
are FOR. An expression reaching a bare `parse` is now diagnosed instead of reinterpreted:

```
registry.parseValue: this node is an EXPRESSION (kind:'new'), not a value envelope — an Expr
only evaluates inside a program (`Engine.run`/`Engine.evaluate`); a bare `parse` takes data.
```

**Found on the way in, and fixed narrowly.** `compatible` matches on the LEFT's class and never
opens the right, so `num.compatible(<Extension over num>)` is `false` — contradicting
`Extension`'s own stated invariant that every Extension value is a valid base value. gin's own
`composite-values.test.ts` covers exactly that case (a `positive` in a `map<num, text>` key
slot), so it surfaced immediately. `slotAccepts` walks the Extension chain; the general fix
belongs in `compatible` itself and is NOT made here — it would move a relation the whole library
is written against, and it is the same family as the open `A.compatible(or<A, A>)` ask.

### An Extension's local props are DATA or SURFACE, and gin now knows which

Nothing drew the line, so every local prop was surface to `parse`/`valid`/`encode` and shape to
`toValueSchema` — three surfaces of one type disagreeing:

```ts
W.toValueSchema().safeParse({})   // FAILS: path ['id'] expected string, received undefined
W.parse({id:'i', opt:'o'}).raw    // {}                  ← every field discarded
W.valid({})                       // true                ← and the loss was blessed
Object.keys(W.props())            // [... 'id', 'opt']   ← still advertised
```

A local prop is **surface** when something else computes it — a `get` expression, or a callable
type (a method carries its body in `get`). Everything else is **stored data** the value carries:
filled by `parse`, required by `valid`, emitted by `encode`, populated by `create`/`random`, and
demanded by `toValueSchema`. One predicate, consulted by all six, so they cannot drift apart
again. The converse case is fixed by the same line: a type whose methods rode local props had a
value schema demanding every method on every value, which no caller can supply — the reason a
`Resource` handle had to use `augment` instead.

Only over a record-shaped base; an `Extension` over `text` has nowhere to put a field and does
not try. The composition the product settled on by measurement — data on the base, methods in
local props — is unchanged.

### A path read resolves a specialization, and falls back to the value's own types

Everything about `specialize` worked except the one thing it exists for. `props()['data'].type`
is still `AliasType('T')` on a bound instance; the binding rides a `LocalScope` that
`valid`/`parse`/`encode` all route through, and the path walk had nowhere to receive it:

```ts
bound.toCode()                                  // 'HttpResponse<obj{USD: num, EUR: num}>'  ok
e.typeOf({get: res.data}, {res: bound})         // 'T'   ← unresolved AliasType             BROKEN
e.validate({get: res.data.USD}, {res: bound})   // ["no prop 'USD' on type 'alias'"]
```

`Path.walk` / `typeOf` / `validateWalk` now resolve a prop declared as a type PARAMETER through
the receiver's own bindings. Only an alias is resolved — `simplify` on anything else is a
canonicalizer, and running every prop read through it would change what the walk reports about
types that were never in question. An unspecialized generic still reads as its placeholder: the
walk reads bindings, it does not guess.

**And at run time the walk has a second source.** A composite's raw holds a `Value` per slot,
each with its own concrete type, and the walk consulted only `dv.type` — answering a question
about a value without looking at it. When the declared type has no such prop, the walk now
consults the value's own slot before reporting `no prop`. The declaration always gets first
refusal.

### Four value wire forms, at three very different costs

There used to be exactly two ways to hold a typed value — the live `Value`, or the full
envelope — and **no third, envelope-free, type-preserving form**. `Value.encode()` drops only the
OUTER layer, so a `list<num>` still encoded as `[{type,value}]`, and nothing could be added from
outside because the composite/leaf split lives on `Type.encode`. Consumers that had to hand a
bare value across a boundary reimplemented gin's own walk.

And the envelope's cost was never the cost of carrying a type: a registered named type's
`toJSON()` inlines its **whole definition at every element**. gin already draws the
reference-vs-definition distinction on the TYPE side (`register` inlines, `scope` references) —
it just never applied it to the value envelope.

| Call | Nested envelopes | Types | Cost¹ | Recovers a per-element subtype |
|---|---|---|---|---|
| `value.encodeLogical()` | none | none | **1.00x** | no — re-parse against the declared type |
| `value.toJSONLogical()` | none | one, at the top, by name | **1.00x** | no — demoted to the declared type |
| `value.toJSONRefs()` | every slot | by name | 4.1x | **yes** |
| `value.toJSON()` *(default, unchanged)* | every slot | full definition | 6.9x | yes |

¹ `list<project>`, 1000 rows, four scalar fields each, against the logical JSON. Pinned in
`value-wire-forms.test.ts` so the numbers cannot rot. Carrying the type now costs a flat ~70
bytes rather than a multiple of the payload.

All four read back through `registry.parseValue`. `typeRefs:'name'` needs the consumer to share
the registry (an unregistered name parses to an unbound alias, which is universal), which is why
it is opt-in and why `toJSON()`'s default is untouched. Internally there is now ONE recursive
serializer — `Type.encodeAs(raw, opts, scope?)` — and every composite's `encode` delegates to it,
so a type cannot serialize one way for the default form and another way for a logical one.

### A closed set declared on a PROP is respelled, and a numeric one keeps its labels

`{type:{name:'text'}, values:['todo','done']}` on a prop is the same mistake as
`{name:'text', options:{values:[…]}}`, one level down — measured twice in a live product
database, both times on a status column. The message named the valid keys and stopped; it now
names the construct, with the author's own members respelled through gin's own `toJSON`:

```
gin.parse: prop 'status' has unknown key 'values' — a closed set of constants is the prop's
TYPE in gin, not a key beside it: {"type":{"name":"enum","generic":{"V":{"name":"text"}},…}}
```

And the respelling **keeps the author's LABELS for a numeric set**. gin built the suggestion from
the members' VALUES, so `{Low: 1, High: 9}` came back as `{"1":1,"9":9}` — the author wrote
names, the correction silently deleted them, and a model that pasted it back lost them from the
column's value set. Text sets were byte-perfect (label and value coincide there), which is why it
survived. Only the bare-ARRAY spelling still synthesizes labels.

### Two asks CORRECTED — already closed, do not re-file

Both were filed from product-side observation and re-measured here against this source:

- **"the parser silently ignores unknown keys; a mis-keyed generic becomes `list<any>` and passes
  every claim check"** — closed. `{name:'list', generic:{item:…}}` and
  `{name:'list', options:{item:…}}` are both refused with an actionable message, and `0.4.0`
  extended the refusal to the nested def shapes and path steps.
- **"three printer defects: a dead `indent` option, depth-unaware `joinAuto`, `obj` never
  wrapping"** — closed. `CodeOptions.indent` is resolved in one place (`indentOf`) and honoured
  by `toCode`, `toCodeDefinition` and every nested wrap; `joinAuto` indents already-multi-line
  items so nesting composes; `obj` wraps on width, item length or an already-wrapped child.

### Exports added

`Value.encodeLogical`, `Value.toJSONLogical`, `Value.toJSONRefs`, `Value.toJSON(opts?)`;
`Type.encodeAs`, `Type.toJSONRef`, `Type.forEachNewSlot`, `Type.newFill`, `Type.validateNewValue`;
`NewSlotVisitor`, `EncodeOptions`, `slotAccepts`, `encodeSlot`, `embeddedExpr`,
`isRecordPayload`, `ENVELOPE_ENCODE`; `PROP_DEF_HINTS`, `CALL_DEF_HINTS`, `DefKeyHint`. The
`json-type` module is re-exported at last — `JSONValue`, `JSONOf`, `RuntimeOf` — so a consumer
can name the type `Value.toJSON()` returns instead of re-deriving it.

### Compatibility

No wire format changed and no default output moved: `toJSON()` / `encode()` are byte-identical
(pinned per composite in `value-wire-forms.test.ts`). What changed is that some things gin used
to ACCEPT are now refused — a value whose carried type the declared slot does not accept, and an
`ExprDef` handed to a bare `parse`. In every case measured, what breaks is a value that was
already wrong and silently meant something else. `Extension.valid` now requires an Extension's
stored local props, which is the point of the fix; a type composing data on the base and methods
in local props is unaffected.

### Tests

98 files / 1153 tests, up from 93 / 1043. New: `new-payload-walk.test.ts` (the seven payload
shapes, the permissive-slot swallow, the validate blind spot, sequential ordering),
`slot-type-reconciliation.test.ts` (the reconciliation, subtype preservation, the Expr-vs-envelope
diagnosis), `extension-stored-props.test.ts` (data vs surface across all six surfaces),
`generic-envelope-path.test.ts` (specialization through the walk, and the runtime fallback),
`value-wire-forms.test.ts` (the four forms, the measured costs, and a per-composite pin that the
default output is unchanged). `wire-strict-keys.test.ts` grew the prop-`values` respelling and the
numeric-label case.

`gaps-parallel.test.ts`'s empirical-concurrency tests are wall-clock sensitive and flake under
load on some machines; they fail identically on the unmodified `0.4.0` tree (measured, 3/3 runs)
and are unrelated to anything here.

## 0.4.0

Four items raised by the consuming product against `0.3.13`, each re-measured against this
source before anything was written. Two are additive API (**G-new-1**, **G-new-2**); one is a
new opt-in on an existing method (**G-new-3**); one **REFUSES DEFS THAT USED TO PARSE**
(**G-new-4**) and is why this is a minor rather than a patch. The breaking half is the same
class of change `0.3.11` made for `TypeDef` keys, one level down — and it found a live
mis-declaration in gin's own rendering fixture on the way in.

### G-new-1 — the scope OVERLAY is public: `registry.scope()`, `LocalScope`, `TypeScope`

`Registry.parseInner`'s bare-name arm has always had two behaviours, and the difference is a
data-corruption story rather than a nuance:

```ts
if (s.localLookup(def.name) !== undefined) return new AliasType(scope, { name: def.name });
//                                          ↑ OVERLAY: resolves, re-serializes BY NAME
if (this.namedTypes.has(def.name)) return this.namedTypes.get(def.name);
//                                        ↑ REGISTERED: the instance, whose toJSON() INLINES
```

gin HAD the overlay (`LocalScope` over a `TypeScope` parent chain) and did not export it — so a
caller who wanted "resolve this name for this session without claiming it globally" had only
`register`, whose instance re-serializes its whole definition inline where the reference used to
be. Measured in the consuming product: a stored user type's `timestamp` field came back out of an
unrelated read-modify-write carrying an unrelated package's `time` definition — wrong props, wrong
docs, no error at any layer — because a boot had `register`ed that name into the shared registry.
Nothing had to be installed and nothing had to be used; a boot was enough.

```ts
const session = r.scope({ time: timeType });   // this session only
session.parse({ name: 'time' }).props();       // resolves — props, methods, all of it
session.parse({ name: 'time' }).toJSON();      // => { name: 'time' }   a reference stays a reference
r.lookup('time');                              // => undefined — the registry is untouched
```

- `Registry.scope(bindings?)` → `LocalScope`, an overlay above the registry.
- `LocalScope` and the `TypeScope` interface are exported. Layer with
  `new LocalScope(scope, {…})` (inner wins), extend with `.bind(name, type)` in dependency order.
- `TypeScope` gained no member, deliberately: a structural implementer of the five-member
  interface keeps compiling.

Nothing about `register` changed. It remains right for a type the registry OWNS; the overlay is
for a name that is true for one session, execution or request.

### G-new-2 — `toValueSchema` takes a scope, like every other value-side op

`valid`, `parse`, `compatible` and `props` all take a trailing `TypeScope`; `toValueSchema(opts?)`
took none. So a signature naming a type its schema-building registry does not hold resolved to an
unbound `AliasType`, whose value schema is `z.any()` — the derived gate accepted every value, and
there was no parameter with which to fix it at the call site.

```ts
const session = registry.scope({ Deployment: deploymentType });
fnType.call()!.args.toValueSchema({ scope: session });   // enforced, nested slots included
```

`ValueSchemaOptions.scope` rides the options bag rather than a positional parameter because a
value schema recurses through slots that already thread `opts` verbatim — so every nested list
element, obj field and map value inherits it, where a positional argument would have to be
re-threaded by each composite and silently dropped by any that forgot. `toNewSchema` reads it too
(it extends the same bag), and the base `toNewSchema` now resolves its `init` through it.

### G-new-3 — `toValueSchema({ unknownKeys: 'refuse' })`, opt-in

Measured on `0.3.13`: `obj{type: text, charThreshold: num}.toValueSchema().safeParse({type:'graph',
charThreshold:5000, bogus:1})` succeeded with `bogus` silently gone. A REQUIRED knob is safe (it
fails as missing); a mis-spelt OPTIONAL one disappears without a word, is stored, and does nothing.

`'refuse'` reaches every nested object, an `Extension`'s local props, and a map's `{key, value}`
entry envelope; `interface`, which passes width through by default, refuses under it too. The issue
is zod's `unrecognized_keys`, so it names the key and its path.

**Opt-in, not the default — and the ask was filed asking for the opposite, so here is the
measurement that changed it.** gin's value semantics are width-subtyped at all three surfaces that
exist today:

```ts
narrow.compatible(wide)                                // true  — a wider obj IS a value of it
narrow.valid({ a: Value(num,1), zz: 9 })               // true  — valid reads the declared fields
Object.keys(narrow.parse({ a: 1, zz: 9 }).raw)         // ['a'] — parse copies them and drops the rest
```

Strict-by-default would make the generated schema the ONE surface in the library that rejects a
value gin's own type system calls a value of that type. Whether an extra key is legitimate width or
a typo depends on the BOUNDARY — an authored settings bag versus a wider row flowing through a
narrower view — and only the caller knows which. That is the opposite of the WIRE side, where
`registry.parse` refuses with no opt-out because a def is gin's own format and an ignored key there
is data loss.

### G-new-4 — the refusal reaches the NESTED def shapes, and path steps (**breaking**)

`0.3.11` stopped at the `TypeDef`. The identical mistake one level down kept its identical silent
fate, in shapes an LLM writes constantly:

```ts
{ name: 'fn', call: { args: {…}, retruns: { name: 'num' } } }   // was: a fn with NO return type
{ name: 'obj', props: { a: { typ: { name: 'num' } } } }         // was: a prop with no type
```

Now checked against their own key lists, with the same `did you mean` correction: `PropDef`
(`docs`, `type`, `get`, `default`, `set`), `GetSetDef` (`docs`, `key`, `value`, `get`, `set`,
`loop`, `loopDynamic`), `CallDef` (`docs`, `types`, `args`, `returns`, `throws`, `get`, `set`),
init (`docs`, `args`, `run`). Each list carries the same `AssertCovered` compile-time proof against
its interface that `TYPE_DEF_KEYS` does, so adding a field and forgetting the list is a build error
rather than a false refusal.

A **PATH STEP must name exactly one form.** `PathStepDef` is a union — `{prop}` |
`{args, generic?, catch?}` | `{key}` — and `PathStep.from` took the first form it recognized and
dropped the rest. Measured on the consuming product's acceptance lane, 2026-08-10: the fused
spelling accounted for **30 of 33 refusals in one turn**, because it parsed as a bare prop read and
was then diagnosed as `method 'announce' needs arguments` — about the arguments supplied in that
very step, so the model rewrote the one thing that was right until its budget ran out.

```
{ "prop": "announce", "args": { "note": … } }
→ gin.parse: path step names 2 forms ('prop' and 'args') —
  each is its own step: [{"prop":"announce"}, {"args":{…}}]
```

A step selecting no form at all now names the selector it probably meant (`{arg:…}` → ``did you
mean `args`?``) instead of the unactionable `unknown step shape`. The LLM-facing schema description
for a `get`/`set` path teaches the split spelling up front.

**Found on the way in, and fixed rather than tolerated:** gin's own `code-render-demo` fixture
declared a generic lambda's type parameter as `call.generic`. `Call.from` ignored it entirely and
the fixture passed anyway — because the unbound `{name:'T'}` left in the signature is a universal
alias that matches anything. So the refusal for a `generic` on a `CallDef` names the construct:
*a fn declares its type parameters on the TYPE, not the call*, with the correct def spelt out.

**Who this breaks.** Anyone whose stored defs carry a key in one of those nested shapes that gin
never read, or a fused path step. In every case measured, what breaks is a def that was already
wrong and silently meant something else. Only AUTHORED shapes are checked — every `from(...)` also
accepts the in-memory instance it produced (`Prop`, `GetSet`, `Call`, `Init`), and those carry
gin's own fields by construction, so nothing pays a key scan per path-walk to police shapes gin
itself built.

### Exports added

`Registry.scope`; `LocalScope`, `TypeScope`; `ValueSchemaOptions.scope`,
`ValueSchemaOptions.unknownKeys`; `PROP_DEF_KEYS`, `GET_SET_DEF_KEYS`, `CALL_DEF_KEYS`,
`INIT_DEF_KEYS`, `checkDefKeys`, `checkPathStep`.

### Tests

93 files / 1043 tests, up from 91 / 1010. New: `scope-overlay.test.ts` (the overlay, the
`register` contrast it exists to prevent, and the scope reaching a value schema through three
composites) and `value-unknown-keys.test.ts` (the measured strip, the refusal, and the three
width-subtyping surfaces that argue for opt-in). `wire-strict-keys.test.ts` grew the nested-shape
and path-step halves, including a maximal legitimate def with every nested key populated at once.
