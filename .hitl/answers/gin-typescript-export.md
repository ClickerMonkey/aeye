# gin → runnable TypeScript export: answers

14 of 14 answered. Written by questionme; the answers themselves are in the .json next to this file.

## Output shape & calling convention

### api: What is the API surface?

engine.toTypeScript + joinTypeScript + renderTypeScriptFile

Applied: Got it — building on these (incl. async 'auto' and export keyword options). Will commit locally only.

### args: gin calls take a named-args object (`x.add({other: 3})`, lambda `args.name`). How should methods and exported functions take parameters in TS?

One args object: (args: { plan: string }) => R

Applied: Got it — building on these (incl. async 'auto' and export keyword options). Will commit locally only.

### async: gin evaluation is async (host natives can hit a DB/network). Should generated functions be async?

Always async; every host/method call is awaited

Applied: Got it — building on these (incl. async 'auto' and export keyword options). Will commit locally only.

### scope: A function's free variables (globals registered on the engine, `extras` at run) — how do they reach the compiled code?

A typed context parameter: fn(args, ctx: Ctx)

Applied: Got it — building on these (incl. async 'auto' and export keyword options). Will commit locally only.

## Natives & runtime semantics

### natives: How do built-in natives compile?

Inline idiomatic TS + a small emitted prelude for the rest

Applied: Got it — building on these (incl. async 'auto' and export keyword options). Will commit locally only.

### eq: gin's `num.eq` is epsilon-approximate. Compiled equality should be…

Faithful (helper with gin's epsilon)

Applied: Got it — building on these (incl. async 'auto' and export keyword options). Will commit locally only.

### methods: Methods on referenced types (e.g. Person.fullName implemented by a gin template expr, Customer.upgrade by a host native). In the types they are function-typed properties. Where do their implementations come from at run time?

The value already carries them; host attaches impls

Applied: Got it — building on these (incl. async 'auto' and export keyword options). Will commit locally only.

### constraints: Type constraints (num{min=0, whole}, text{pattern}, list{max}) and named extensions (`Email extends text`):

Plain aliases + constraints as /** */ doc comments

Applied: Got it — building on these (incl. async 'auto' and export keyword options). Will commit locally only.

### runtime-types: `any.is(T)` / `any.as(T)` / `typeOf` need runtime type checks. How?

Emit a structural guard per type used (`isPerson(x)`)

Applied: Got it — building on these (incl. async 'auto' and export keyword options). Will commit locally only.

### exit: `flow: exit` (unwind to engine.run with a value) — compile as…

Throw a prelude ExitSignal caught by the outermost exported function

Applied: Got it — building on these (incl. async 'auto' and export keyword options). Will commit locally only.

## Scope & testing

### options: Which export options do you want in v1? (pick all)

types: 'referenced' | 'none' — emit every non-native type referenced, transitively; includeComments — gin docs as /** */; name — the exported function/const name for a top-level lambda; prelude: 'inline' | 'separate' — helpers in the code or as their own map entry; async: 'always' | 'auto' override; export keyword on emitted types/functions

Applied: Got it — building on these (incl. async 'auto' and export keyword options). Will commit locally only.

### llm-test: For the 'hand an LLM the types file' scenario, how far should v1 go?

Offline test only: types file compiles standalone; a hand-written function against it compiles and runs

Applied: Got it — building on these (incl. async 'auto' and export keyword options). Will commit locally only.

### release: When done: bump/commit/push?

Commit locally, I'll say when to push/release

Applied: Got it — building on these (incl. async 'auto' and export keyword options). Will commit locally only.

### anything: Anything else — e.g. a real program/types (ginny tools?) you want as the showcase test?

(skipped)

Applied: Got it — building on these (incl. async 'auto' and export keyword options). Will commit locally only.
