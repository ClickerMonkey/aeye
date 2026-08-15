# `@aeye/gin` changelog

Releases before `0.4.0` are recorded in the git log (`chore(release): @aeye/gin <version>`
commits); this file starts here and is the place to look from now on.

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
