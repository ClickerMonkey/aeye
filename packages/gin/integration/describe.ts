/**
 * `describeGin(runtime)` — the instruction block the eval prompt shows the model.
 * Four parts, in order:
 *
 *  (a) TYPE DOCS — `toCodeDefinition()` for every in-scope type (built-in classes
 *      AND the case's custom types), the source of truth for which props / methods
 *      / call signatures exist.
 *  (b) GRAMMAR — a concise reference of gin's 12 expression kinds and the `args`
 *      path convention the generated function reads its parameters through.
 *  (c) FUNCTIONS — the signatures of THIS case's callable `fns` (distractors
 *      included — the model is NOT told which are distractors).
 *  (d) WORKED EXAMPLES — 3–5 (request → gin program → output) examples.
 *      `@aeye/ginny` ships ZERO; we include them deliberately to measure the lift.
 *
 * Then the TASK preamble: emit ONLY the function BODY as a gin `ExprDef`, reading
 * parameters via `args.<name>`, matching the declared `(args): returns` signature.
 */
import type { Registry, Type, TypeDef } from '../src/index';
import type { CaseRuntime } from './model';

/**
 * Rebuild a class's canonical instance with readable `generic` placeholder names
 * (e.g. `list<V>` instead of `list<any>`), mirroring `@aeye/ginny`'s
 * `placeholderize`. Returns undefined when the class can't be synthesized.
 */
function placeholderize(
  registry: Registry,
  cls: { NAME: string; from: (def: TypeDef, r: Registry) => Type },
): Type | undefined {
  let canonical: Type;
  try {
    canonical = cls.from({ name: cls.NAME }, registry);
  } catch {
    return undefined;
  }
  const keys = Object.keys(canonical.generic);
  if (keys.length === 0) return canonical;
  const genericDef: Record<string, TypeDef> = {};
  for (const k of keys) genericDef[k] = { name: k };
  try {
    return cls.from({ name: cls.NAME, generic: genericDef }, registry);
  } catch {
    return canonical;
  }
}

/**
 * `toCodeDefinition()` for every in-scope type: each built-in class (with
 * readable generic placeholders) plus every registered named type (the case's
 * custom types). Deduplicated by name. Mirrors ginny's `buildTypeDocs`.
 */
function buildTypeDocs(registry: Registry): string {
  const seen = new Set<string>();
  const docs: string[] = [];
  for (const cls of registry.typeClasses()) {
    const t = placeholderize(registry, cls);
    if (!t || seen.has(t.name)) continue;
    seen.add(t.name);
    try {
      docs.push(t.toCodeDefinition());
    } catch {
      /* skip on render failure */
    }
  }
  for (const t of registry.namedTypeList()) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    try {
      docs.push(t.toCodeDefinition());
    } catch {
      /* skip */
    }
  }
  return docs.join('\n\n');
}

/** The signatures of the case's callable `fns` (distractors NOT marked). */
function buildFnDocs(runtime: CaseRuntime): string {
  if (runtime.fns.length === 0) return '(none — solve the task with the built-in type methods only)';
  const lines: string[] = [];
  for (const spec of runtime.fns) {
    const fnType = runtime.registry.fn({
      args: runtime.registry.parse(spec.args),
      returns: runtime.registry.parse(spec.returns),
    });
    const docs = spec.docs ? ` — ${spec.docs}` : '';
    lines.push(`- \`fns.${spec.name}${fnType.toCode()}\`${docs}`);
  }
  return lines.join('\n');
}

/** A concise reference of gin's 12 expression kinds + the `args` convention. */
const GRAMMAR = `## Gin program grammar (concise)

A gin program is a tree of \`ExprDef\` JSON objects. Every node has \`kind: "..."\`
plus the fields that kind declares. The twelve kinds:

- \`new\` — construct a value: \`{ kind:"new", type:<TypeDef>, value:<raw | Expr slots> }\`.
  Scalars: \`{ kind:"new", type:{name:"num"}, value:42 }\`. Composite slots are Exprs.
- \`get\` — read through a path: \`{ kind:"get", path:[<step>, ...] }\`. Steps:
  \`{prop:"name"}\` (first step = a scope variable; later steps = a prop/method of the
  previous value), \`{args:{argName:<Expr>, ...}}\` (CALL the previous step), and
  \`{key:<Expr>}\` (indexed access, e.g. \`list[0]\`). A no-arg method auto-calls, so
  \`[{prop:"opt"},{prop:"has"}]\` yields \`opt.has()\`.
- \`set\` — write through a path: \`{ kind:"set", path:[...], value:<Expr> }\`.
- \`define\` — bind locals then evaluate a body: \`{ kind:"define", vars:[{name,type?,value}], body:<Expr> }\`.
- \`block\` — sequence; result is the LAST line: \`{ kind:"block", lines:[<Expr>, ...] }\`.
- \`if\` — \`{ kind:"if", ifs:[{condition:<bool Expr>, body:<Expr>}], else?:<Expr> }\`.
- \`switch\` — value-based branching: \`{ kind:"switch", value:<Expr>, cases:[{equals:[<Expr>], body}], else? }\`.
- \`loop\` — iterate any iterable: \`{ kind:"loop", over:<Expr>, body:<Expr>, key?, value? }\`.
- \`lambda\` — a closure: \`{ kind:"lambda", type:<fn TypeDef>, body:<Expr> }\`. Inside, \`args\`
  is the call's arguments obj and \`recurse\` is the lambda itself.
- \`template\` — string interpolation: \`{ kind:"template", template:"Hi {who}", params:<obj Expr> }\`.
- \`flow\` — non-local control: \`{ kind:"flow", action:"break"|"continue"|"return"|"exit"|"throw", value?/error? }\`.
- \`native\` — escape hatch; do NOT emit it. Built-in methods are reached via \`get\` paths.

Method args use the parameter name from the type's definition (e.g. \`num.add\` takes
\`{ other: <num> }\`). If a prop isn't in a type's definition above, it does not exist.

## Reading the function's parameters

You are writing the BODY of a function. Its parameters arrive as the \`args\` object.
Read a parameter named \`p\` with \`{ kind:"get", path:[{prop:"args"},{prop:"p"}] }\`.
Call a provided function with \`{ kind:"get", path:[{prop:"fns"},{prop:"<name>"},{args:{...}}] }\`.`;

/** 3–5 worked (request → program → output) examples. */
const EXAMPLES = `## Worked examples

### Example 1 — "add one to n" for \`(args:{ n:num }): num\`
Program (the function body):
\`\`\`json
{ "kind":"get", "path":[
  {"prop":"args"},{"prop":"n"},{"prop":"add"},
  {"args":{"other":{"kind":"new","type":{"name":"num"},"value":1}}}
]}
\`\`\`
Output for \`{ n: 4 }\`: \`5\`.

### Example 2 — "double x using the double function" for \`(args:{ x:num }): num\`
Program:
\`\`\`json
{ "kind":"get", "path":[
  {"prop":"fns"},{"prop":"double"},
  {"args":{"x":{"kind":"get","path":[{"prop":"args"},{"prop":"x"}]}}}
]}
\`\`\`
Output for \`{ x: 3 }\`: \`6\`.

### Example 3 — "count the done items" for \`(args:{ items:list<obj{done:bool}> }): num\`
Filter to the done items, then take the length:
\`\`\`json
{ "kind":"get", "path":[
  {"prop":"args"},{"prop":"items"},{"prop":"filter"},
  {"args":{"fn":{"kind":"lambda",
    "type":{"name":"fn","call":{"args":{"name":"obj","props":{"value":{"type":{"name":"obj","props":{"done":{"type":{"name":"bool"}}}}}}},"returns":{"name":"bool"}}},
    "body":{"kind":"get","path":[{"prop":"args"},{"prop":"value"},{"prop":"done"}]}}}},
  {"prop":"length"}
]}
\`\`\`
Output for \`{ items:[{done:true},{done:false},{done:true}] }\`: \`2\`.

### Example 4 — "return whether n is positive" for \`(args:{ n:num }): bool\`
\`\`\`json
{ "kind":"get", "path":[
  {"prop":"args"},{"prop":"n"},{"prop":"gt"},
  {"args":{"other":{"kind":"new","type":{"name":"num"},"value":0}}}
]}
\`\`\`
Output for \`{ n: -2 }\`: \`false\`.`;

/**
 * Build the full instruction block for a case: type docs, grammar, this case's
 * function signatures, worked examples, and the task preamble naming the exact
 * `(args): returns` signature the emitted body must satisfy.
 */
export function describeGin(runtime: CaseRuntime): string {
  const signature = `(${runtime.argsType.toCode()}): ${runtime.returnsType.toCode()}`;
  return [
    '# Write a gin function body',
    '',
    'You generate gin programs — JSON expression trees (`ExprDef`). Emit ONLY the',
    'BODY of the requested function as a single `ExprDef`. Do not wrap it in a lambda;',
    'the harness wraps it for you against the signature below.',
    '',
    '## Types in scope',
    '',
    'These are every type available, with their full method surfaces — the source of',
    'truth for which props / methods exist on each value:',
    '',
    '```',
    buildTypeDocs(runtime.registry),
    '```',
    '',
    GRAMMAR,
    '',
    '## Functions available to your program',
    '',
    buildFnDocs(runtime),
    '',
    EXAMPLES,
    '',
    '## Your task',
    '',
    `Write the body of a function with signature \`${signature}\`.`,
    'Read each parameter via `args.<name>` (see "Reading the function\'s parameters").',
    'The body\'s result must be a value of the return type. Emit the `ExprDef` only.',
  ].join('\n');
}
