# @aeye/gin — Registry & Engine

The `Registry` is the central object — it owns the type catalog, native bindings,
expr-class dispatch, parsing, and the type builders (it implements `TypeBuilder`
and `TypeScope`). The `Engine` owns evaluation, validation, inference, and
rendering. Start with `createRegistry()` + `createEngine(r)`. See
[overview](./aeye-gin.md).

```ts
import { createRegistry, createEngine } from '@aeye/gin';
const r = createRegistry();           // all built-ins, natives, expr classes
const engine = createEngine(r);
```

## Registry — key methods

| Method | Purpose |
|---|---|
| `parse(def, scope?)` | `TypeDef` → `Type`. Refuses any key it would not read — see [strict parsing](./aeye-gin-types.md#the-typedef-wire-format-and-strict-parsing). |
| `parseExpr(def, scope?)` | `ExprDef` → `Expr` (idempotent on `Expr`; `undefined` passes through). |
| `parseValue(json, expectedType?, scope?)` | `{type,value}` envelope, live `Value`, or raw → `Value`. `expectedType` is the type DECLARED for the slot and is **enforced** — see [slot reconciliation](#a-slot-enforces-its-declared-type). |
| `lookup(name)` | `Type` by name (registered instance → built-in fallback). |
| `define(cls)` | Register a built-in Type **class** for JSON dispatch. Declare `optionKeys` / `genericKeys` on it to opt into strict parsing. |
| `typeClass(name)` | The class registered under `name` (or `undefined`). Its `declaresGenerics` / `valuesAreTypes` flags drive the [reference walk](./aeye-gin-types.md#named-type-references-references-closure). |
| `register(type)` | Register a named Type **instance** (typically an Extension). Resolves to the INSTANCE, whose `toJSON()` inlines the definition — see [type scopes](#type-scopes--register-vs-the-overlay). |
| `scope(bindings?)` | A `LocalScope` OVERLAY above this registry: names that resolve for one session, and still round-trip as `{name}`. Does not mutate the registry. |
| `extend(base, local)` | Create a named Extension (real subtype); `base` is a `Type` or name. Declare type parameters with `generic`, and bind them at a use site with `Extension.specialize({ … })` — or by parsing `{name, generic:{…}}`. |
| `augment(name, { props?, get?, call?, init? })` | Add to an existing type by name. |
| `augmentation(name)` | Read an augmentation back. |
| `setNative(id, impl, effects?)` | Wire a JS fn as a gin native (with declared effects). |
| `getNative(id)` / `nativeEffects(id)` | Read native impl / its effects. |
| `nativeExpr(id)` | Build a parsed `{kind:'native', id}` Expr. |
| `defineExpr(cls)` / `exprClass(kind)` | Register / look up an Expr class. |
| `like(type)` / `compatible(type)` | Pick registered type(s) compatible with a constraint. |
| `getTypesFor(ifaceName)` | All registered types satisfying an interface. |
| `validate(engine)` | Sweep & validate every registered/augmented type's surface. |
| `toCode` / `toGinCode` / `toJSONCode` | Render an expr (see codegen doc). |

Type builders (`r.num()`, `r.list(...)`, `r.obj({...})`, `r.fn({...})`, ...) are
documented in the [type system doc](./aeye-gin-types.md#building-types-programmatically-typebuilder).
Each returns its concrete class carrying the TypeScript value it describes
(`Infer<typeof t>`), so a registry can be used directly as a typed builder.

## Engine — key methods

| Method | Returns | Purpose |
|---|---|---|
| `run(expr, extras?)` | `Promise<Value>` | Execute. Builds a fresh root scope per call. |
| `validate(expr, scope?, ctx?)` | `Problems` | Static analysis (unknown vars/props, type mismatches, misplaced flow, no-op loops). Never throws. |
| `typeOf(expr, scope?)` | `Type` | Static return-type inference (`any` on unknowns). Never throws. |
| `validateValue(value, scope?)` | `Promise<Problems>` | Run a value through its type's constraint chain. |
| `toCode(expr, options?)` | `string` | TS-flavored display source. |
| `toGinCode(expr, options?)` | `Code` | TS-flavored source **with spans**. |
| `toJSONCode(expr, indent=2)` | `Code` | JSON form **with spans**. |
| `registerGlobal(name, { type, value, docs? })` | `this` | Add a global to every root scope. |
| `getGlobal` / `getGlobals` / `globalTypeScope` | — | Read globals / their type scope. |
| `createRootScope(extras?)` | `Scope` | Root scope = globals + extras. |
| `evaluate(expr, scope)` | `Promise<Value>` | Parse-if-needed then dispatch. |

> Gotcha: `toCode` returns a **string**; `toGinCode` and `toJSONCode` return a
> **`Code`** (text + spans). Use the latter two when you need
> `code.formatProblems(problems)` underlines.

## Type scopes — `register` vs the overlay

Two different things are called "the registry knows this name", and the
difference decides what gets written back the next time the def is serialized:

| | Where | `parse({name:'X'})` gives | `toJSON()` of that |
|---|---|---|---|
| `registry.register(X)` | the registry, for the process | THE INSTANCE | the **full definition, inline** |
| `registry.scope({ X })` | a `LocalScope` overlay, for one session | an `AliasType` | `{ "name": "X" }` |

```ts
const session = r.scope({ time: timeType });   // this session only
session.parse({ name: 'time' }).props();       // resolves — props, methods, all of it
session.parse({ name: 'time' }).toJSON();      // => { name: 'time' }   still a reference
r.lookup('time');                              // => undefined — the registry is untouched
```

Reach for the overlay when a name is true for ONE session / execution / request
rather than for the process: a type contributed by an installed package, a
staged type being authored, a caller-supplied vocabulary. Registering those
globally instead is how a stored `{"name":"time"}` field was rewritten, at an
unrelated read-modify-write, into the whole inline definition of a package type
that had merely been registered at boot — wrong props, wrong docs, no error
anywhere. `register` is right for a type the registry OWNS; it is the wrong tool
for a name you only want to resolve.

`LocalScope` and the `TypeScope` interface are exported (**0.4.0**). Layer
another with `new LocalScope(scope, {…})`, add bindings in dependency order with
`.bind(name, type)`, and pass a scope to anything that resolves names —
`registry.parse(def, scope)`, `type.valid(raw, scope)`, `type.compatible(other,
opts, scope)`, `type.toValueSchema({ scope })`.

### Type names, and namespaced ones

A type's `name` (and `extends`, and each `satisfies` entry) is an identifier,
optionally namespaced with `/`: `Entry`, `fs/Entry`, `my-app/billing/Invoice`
(`TYPE_NAME`, `isTypeName`). A host that loads types from several sources
keeps them apart by qualifying them and hands gin the qualified names as they
stand: `registry.parse`, `scope.bind`, `typeReferences` and `typeClosure` all
take them. Whitespace and other punctuation are refused with a pointer to the
rule.

## A slot enforces its declared type

A composite holds a `Value` per slot, each carrying its own concrete type — so
at every slot there are two type opinions: the one the container DECLARES and
the one the value CARRIES. gin reconciles them, in one rule, wherever they meet
(`parseValue`, every composite's `valid`, an Extension's stored props, and the
`new.slot.type` validator).

The rule (`slotAccepts`) is `declared.compatible(carried)` — "does the declared
type accept every value of the carried one" — so a genuine **subtype still
lands**, which is the entire point of per-slot types. An `Extension` on the right counts as its
base: `positive extends num` is accepted into a `num` slot.

```ts
r.list(r.text()).parse([{ type: { name: 'num' }, value: 5 }]);
// throws: registry.parseValue: this slot is declared `text` but the value carries `num`

r.list(animal).parse([{ type: { name: 'Dog' }, value: { name: 'rex' } }]);
// OK — element type is Dog, not Animal
```

No `expectedType` means no second opinion to reconcile against, and the
envelope's own type stands.

### The declared type is asked FIRST

`parseValue` resolves a node in a fixed order, and the order is the contract:

1. an already-built `Value` — nothing to interpret, only to reconcile;
2. **the DECLARED type**, when it says an Expr node is one of its values;
3. a `{type, value}` envelope;
4. plain logical data, judged by the declared type.

Step 2 exists because a few types genuinely take an `ExprDef` as their value —
`fn` above all, whose value IS an ExprDef (`FnType.parse`, `FnType.valid` and
`FnType.toNewSchema` all say so). A `fn`-declared slot holding a `lambda` is
the ordinary case, not a smuggled expression. `Type.parsesExprValue()` declares
it, so the rule travels with an `Extension` over `fn`, an `optional<fn>`, an
`or<fn, text>`. `any` answers **false** on purpose: it accepts every value but
does not declare that an ExprDef is one of them.

**Fixed in 0.4.2.** Reading the node's SHAPE before asking the declared type
made the same value parse differently depending on how deep it sat:

```ts
fn.parse({kind:'new', type:{name:'bool'}, value:false})   // OK
obj{probe: fn}.parse({probe: <that same node>})           // THREW  ← 0.4.1
list<fn>.parse([<the new node>])                          // THREW  ← 0.4.1
obj{probe: fn}.parse({probe: {kind:'get', path:[…]}})     // OK — `get` has no
                                                          //   `type`/`value` keys
```

`new` is the only expr kind carrying both a `type` and a `value` key, which is
why it alone tripped the envelope branch. **A value that parses standalone and
throws one level in is always a dispatch-order bug** — under 0.4.0 the same
call did not throw at all, it silently returned `{probe: Value(bool, false)}`,
replacing the lambda with the literal its body constructs.

**Changed in 0.4.1.** Before, the carried type simply won: a `num` sat inside a
`list<text>`, `valid()` returned `true` (each cell was asked whether it was
valid BY ITS OWN LIGHTS, never against the declared element type),
`validateValue()` reported nothing, and the only surface that noticed was a
generated Zod schema — which is a prompt schema, not a validator.

## Value wire forms — what to serialize, and what it costs

Four forms, from two independent choices (`EncodeOptions`): whether nested slots
carry a `{type, value}` envelope (`form`), and whether a registered type is
written as its full definition or as a `{name}` reference (`typeRefs`).

| Call | Nested envelopes | Types | Cost¹ | Recovers a per-element subtype |
|---|---|---|---|---|
| `value.encodeLogical()` | none | none | **1.0x** | no — re-parse against the declared type |
| `value.toJSONLogical()` | none | one, at the top, by name | **~1.0x** | no — demoted to the declared type |
| `value.toJSONRefs()` | every slot | by name | ~4x | **yes** |
| `value.toJSON()` *(default, unchanged)* | every slot | full definition | ~7x | yes |

¹ measured on `list<project>`, 1000 rows, four scalar fields each, against the
logical JSON as the baseline. Pinned in `value-wire-forms.test.ts`.

All four are read back by `registry.parseValue` — the last three directly, and
`encodeLogical()` by re-parsing against the declared type
(`type.parse(logical)`). `typeRefs:'name'` requires the consumer to share the
registry: a name it has not registered parses to an unbound alias, which is
universal. That is why it is opt-in.

An `obj` field (or an Extension's stored prop) whose `optional` slot holds
nothing is left out of every form, the way a JSON object omits a key it has no
value for, so `encodeLogical()` passes the type's own `toValueSchema()`. A bare
absent `optional` (not in a field) still encodes as `null`.

**New in 0.4.1.** `encodeLogical` closes a real gap: there used to be exactly
two ways to hold a typed value — the live `Value` or the full envelope — and no
third, envelope-free one. `encode()` drops only the OUTER layer, so a
`list<num>` still encoded as `[{type,value}]`, and nothing could be added from
outside because the composite/leaf split lives on `Type.encode`. And the
envelope's ~7x was never the cost of carrying a type: a registered type's
`toJSON()` inlines its whole DEFINITION at every element. gin already draws the
reference-vs-definition distinction on the type side (`register` vs `scope`,
above); `typeRefs:'name'` applies it to the value envelope.

## Scopes, globals, and `extras`

A program runs in a `Scope`. Root-scope variables come from globals (registered
via `engine.registerGlobal`) plus per-call `extras`. Each sub-call (lambda body,
method invocation) creates a **child scope** — no implicit leaks between branches.
`extras` is `Record<string, Value>`:

```ts
const result = await engine.run(program, { one: r.num().parse(1) });
```

```ts
engine.registerGlobal('pi', { type: r.num(), value: 3.14159, docs: 'circle constant' });
```

The engine is stateless across runs; mutations live in the scope graph, not on
the engine or registry.

## Native functions

A native is a JS function registered by string id. It receives the runtime scope
and the registry:

```ts
import { val } from '@aeye/gin';

r.setNative('Email.domain', (scope, reg) => {
  const self = scope.get('this')!.raw as string;       // instance methods read `this`
  return val(reg.text(), self.split('@')[1] ?? '');
});
```

Inside a native:
- `scope.get('this')` — the receiver (instance methods).
- `scope.get('args')` — the args obj `Value` (callable types).
- `scope.get('key')` / `scope.get('value')` — index get/set.
- `scope.get('yield')` — loop iterators call this with each `(key, value)`.
- `val(type, raw)` — build a fresh `Value`.

`setNative(id, impl, effects?)` — `effects` defaults to the conservative
`STATE|SYSTEM|EXTERNAL` for *user* natives (assume worst case). Built-in pure
natives opt into `Effects.NONE`. Declare accurately so effect propagation /
no-op detection works.

## Schema generation for LLMs

gin's grammar — every valid `TypeDef` / `ExprDef` against **this** registry,
extensions and augmentations included — is one `@aeye/schema` module,
`GinGrammar` (`grammar.ts`). It is built once: static named types per class and
kind (`Type_num`, `Type_object`, `Expr_define`, `PathStep`, `PropDef`, …,
recursive through `a.ref('TypeDef')` / `a.ref('Expr')`), plus one dynamic step
`(registry, overrides?)` for what the registry decides: the `TypeDef` union (the
registry's named types by name, a branch per type class, the inline Extension),
`Type_Extension`'s `extends` enum, the `Expr` union of the registered kinds,
`new` (or its `newStrict` branches `New_<name>` / `New_<class>`), and the named
types' own value schemas. A bind is cached per registry (identity +
`registry.version`, bumped by `define` / `register` / `defineExpr` / `augment`)
and overrides, and rendering for the next request is free. There is nothing to
regenerate after registering types.

Each model gets the JSON Schema its provider can read (records as pairs for
OpenAI strict, recursion as JSON text for Anthropic strict, …) and the answer
is decoded back into the code shape, with mistakes told in `@aeye/schema`'s
format (the model's JSON with markers, "did you mean").

```ts
import { a } from '@aeye/schema';
import { buildSchemas, GinGrammar } from '@aeye/gin';

buildSchemas(r).Expr;                       // Bound<GinShapes.ExprDef>: render(profile), parse(answer)
buildSchemas(r, { newStrict: true }).Type;  // Bound<GinShapes.TypeDef>

// A tool's arguments: a root over the grammar, bound per ctx (e.g. with @aeye/ai):
const writeProgram = ai.tool({
  name: 'write_program',
  schema: GinGrammar.result(a.object({ program: a.ref('Expr') }))
    .adapt((ctx: { registry: Registry }) => [ctx.registry, { newStrict: true }]),
  call: async ({ program }) => {             // program: GinShapes.ExprDef
    const expr = r.parseExpr(program);
    const problems = engine.validate(expr);
    if (problems.hasErrors) {
      return { ok: false, errors: engine.toGinCode(expr).formatProblems(problems) };
    }
    const result = await engine.run(expr);
    return { ok: true, value: result.toJSON() };
  },
});
```

`BuildSchemasOverrides`: `{ types?: Type[], newStrict?: boolean, namedRefs?: boolean }`.
- `types` surfaces specific instances as first-class branches (explicit ones win over the registry's of the same name).
- `newStrict` locks `new` to a union over every constructible type: one branch per named type (its own `toNewA()` value) and per class.
- `namedRefs` also accepts any type by its name alone (`{ name: 'ns/Name' }`), checked when the def is parsed.

| Export | What it is |
|---|---|
| `GinGrammar` | The module: `.result(root)` → a `Bundle` bound with `(registry, overrides?)`; `.adapt(ctx => [...])` for a Tool / Prompt. |
| `GinGrammarStatic` | The static grammar before the registry step, for a module that adds its own dynamic step (`.declare<…>().dynamic(ctx => ({ ...grammarDefs(ctx.registry), Mine: … }))`). |
| `grammarDefs(registry, overrides?)`, `grammarKey(...)` | The dynamic step and its cache key, to reuse in such a step. |
| `TypeDefSchema`, `ExprSchema` | `GinGrammar.result('TypeDef' \| 'Expr')`. |
| `buildSchemas(registry, overrides?)` | `{ Type, Expr }` bound for one registry. |
| `type.toA(opts?)`, `ginValue(type, opts?)` | A VALUE of a type (see [Value schemas](./aeye-gin-types.md#value-schemas-toa)). |
| `GinShapes` | The code types the grammar decodes to (`GinShapes.TypeDef`, `GinShapes.ExprDef`, `GinShapes.TypeNum`, …). |

A type class registered beyond the built-ins contributes its TypeDef branch with
a `static toA()` (and its class-level `new` value with `static toNewA()`); an
expr kind its ExprDef with `static toA()`. Without them the branch is a loose
`{ name }` / `{ kind }` object.

**Errors.** A model's answer that doesn't fit the grammar (an unknown kind, a
missing field, a misspelt key) is told back in `@aeye/schema`'s format, at the
tool's `errorFormat`. What gin finds once a program fits — unknown variables,
type mismatches, a call with the wrong args (`engine.validate`) — is gin's own:
render it with `Code.formatProblems` (`engine.toGinCode(expr).formatProblems(problems)`),
as ginny's `write` does. The two never overlap: the schema says what a program
IS, gin says whether it makes sense.

**Deprecated: the zod grammar.** `buildZodSchemas(registry, overrides?)` (the
old `buildSchemas`, every class's `static toSchema` / `toNewSchema`) is kept
only because `toValueSchema` (zod) needs it for `typ` / `fn` values. Nothing in
aits gives it to a model. It goes once the harness moves to `a`.

## End-to-end example

```ts
import { createRegistry, createEngine, val, Init } from '@aeye/gin';

const r = createRegistry();

// 1. Extension — a real subtype of text.
const Email = r.extend(r.text({ pattern: '^[^@]+@[^@]+$', minLength: 3 }), {
  name: 'Email',
  props: { domain: r.method({}, r.text(), 'Email.domain') },
});
r.register(Email);
r.setNative('Email.domain', (scope, reg) =>
  val(reg.text(), (scope.get('this')!.raw as string).split('@')[1] ?? ''));

// 2. Augmentation — add a percent constructor to num.
r.augment('num', {
  init: new Init({
    args: r.obj({ percent: { type: r.num({ min: 0, max: 100 }) } }),
    run: r.nativeExpr('num.fromPercent'),
  }),
});
r.setNative('num.fromPercent', (scope, reg) => {
  const args = scope.get('args')!.raw as Record<string, { raw: number }>;
  return val(reg.num({ min: 0, max: 1 }), args.percent.raw / 100);
});

// 3. Run a program (here hand-written; usually authored by an LLM).
const engine = createEngine(r);
const program = {
  kind: 'define',
  vars: [
    { name: 'opacity', value: { kind: 'new', type: { name: 'num' }, value: { percent: 75 } } },
    { name: 'addr',    value: { kind: 'new', type: { name: 'Email' }, value: 'team@example.com' } },
  ],
  body: { kind: 'get', path: [{ prop: 'addr' }, { prop: 'domain' }, { args: {} }] },
};
const out = await engine.run(program);
console.log(out.raw); // 'example.com'
```

Augmentations and extensions live on the registry — pass that same registry to
`createEngine` AND to `buildSchemas` so the LLM sees the full surface.

## Read next

- [Type system](./aeye-gin-types.md)
- [Expressions](./aeye-gin-expressions.md)
- [Codegen & diagnostics](./aeye-gin-codegen.md)
