import { z } from 'zod';
import type { Message } from '@aeye/core';
import { buildSchemas, ObjType } from '@aeye/gin';
import type { TypeDef, Type } from '@aeye/gin';
import { ai } from '../ai';
import { modelFor, toolIterationsConfig } from '../model-selection';
import { ask } from '../tools/ask';
import { printFn } from '../tools/print-fn';
import { searchFns } from '../tools/search-fns';
import { runSubagent } from '../progress';
import { logger } from '../logger';
import { MAX_PROGRAMMER_DEPTH, type ProgrammerChainEntry } from '../context';
import { createRunState } from '../run-state';
// `programmer` and `designer` form a circular import (programmer ↔
// findOrCreateFunctions → designer → createNewFn → programmer). The
// reference here is only used inside `createNewFn`'s `call` async fn,
// so by call-time both modules have finished initializing — ESM live
// bindings make this safe.
import { programmer } from './programmer';

const getFn = ai.tool({
  name: 'get_fn',
  description: 'Get the full signature of a function by name.',
  instructions: 'Retrieve function signature by name.',
  schema: z.object({ name: z.string() }),
  call: async (input: { name: string }, _refs, ctx) => {
    try {
      // `readFn` returns the TypeDef directly — `call.get` holds the body.
      const typeDef = ctx.store.readFn(input.name);
      const type = ctx.registry.parse(typeDef);
      return `${input.name}: ${type.toCode()}`;
    } catch {
      return `Function '${input.name}' not found.`;
    }
  },
});

const createNewFn = ai.tool({
  name: 'create_new_fn',
  description: 'Spin up a programmer to implement a new function and persist it.',
  instructions:
    'Create a new reusable function by recursively invoking the programmer. ' +
    'Decide the function\'s signature here (args type, return type) — the programmer needs it ' +
    'spelled out so it knows exactly what body to write instead of looping back through find_or_create_functions. ' +
    'CRITICAL: every value the function should operate on must be a parameter in `args`. ' +
    'If the user wrote "compute prime factors of a number", the number is a PARAMETER (`{ name: "obj", props: { n: { type: { name: "num" } } } }`) — ' +
    'do NOT bake a sample like 56 into the body. The whole point of saving a function is so the user can call it again with different inputs.',
  schema: (ctx) => {
    const opts = buildSchemas(ctx.registry);
    return z.object({
      name: z.string().describe('Unique function name (camelCase)'),
      description: z.string().describe('What the function should do'),
      types: z
        .record(z.string(), opts.Type as z.ZodType<TypeDef>)
        .optional()
        .describe(
          'Optional `call.types` aliases — declare reusable named types here ONCE and reference them inside `args` / `returns` as a bare `{name: "<alias>"}`. ' +
          'Use whenever the same composite type would appear more than once in the signature. ' +
          'Example: `{ "positiveInt": { "name": "num", "options": { "whole": true, "min": 1 } } }` lets you write `args: { name: "obj", props: { n: { type: { name: "positiveInt" } } } }` and `returns: { name: "list", generic: { V: { name: "positiveInt" } } }` — instead of repeating the full options block twice. ' +
          'Sequential: later aliases may reference earlier. Pick alias names that don\'t collide with built-in type-class names (`num`, `list`, `obj`, etc.) — bare `{name: "num"}` always resolves to the built-in num.',
        ),
      args: (opts.Type as z.ZodType<TypeDef>).describe(
        'TypeDef of the function\'s parameter object. The PROPS of this obj ARE the function\'s parameters — ' +
        'each prop becomes a scope variable in the body when the function is called. ' +
        'Examples: function taking one number → `{ name: "obj", props: { n: { type: { name: "num" } } } }`; ' +
        'function taking text and a list → `{ name: "obj", props: { name: { type: { name: "text" } }, items: { type: { name: "list", generic: { V: { name: "any" } } } } } }`. ' +
        'Only use `{ name: "obj" }` (empty obj, no props) for genuinely nullary functions — most useful functions have parameters, so default to listing them as props. ' +
        'May reference any alias declared in `types` via `{name: "<alias>"}` (saves repetition).',
      ),
      returns: (opts.Type as z.ZodType<TypeDef>).describe(
        'TypeDef of the function\'s return value — e.g. `{ name: "list", generic: { V: { name: "num" } } }` for `list<num>`. ' +
        'May reference any alias declared in `types` via `{name: "<alias>"}`.',
      ),
    });
  },
  // Defensive — the deepest programmer is supposed to write inline, but
  // also block designer.createNewFn at the cap in case a different path
  // got us here.
  applicable: (ctx) => (ctx.programmerDepth ?? 0) < MAX_PROGRAMMER_DEPTH - 1,
  call: async (
    input: {
      name: string;
      description: string;
      args: TypeDef;
      returns: TypeDef;
      types?: Record<string, TypeDef>;
    },
    _refs,
    ctx,
  ) => {
    // Diagnostic anchors so an OOM inside the spawn boundary is
    // localizable. Without these, the log truncates at the outer
    // `→ create_new_fn` tool-start line and we have to guess which
    // step ate the heap.
    logger.mem(`createNewFn ${input.name} start`);

    // Parse the designer-supplied signature into runtime Types. When
    // the designer declared `types` aliases, args/returns may
    // reference them — we resolve those by parsing through a synthetic
    // FnType TypeDef. `decodeCall` builds a LocalScope binding each
    // alias sequentially, so bare `{name: "<alias>"}` references
    // inside args/returns resolve via AliasType through that scope.
    let argsType: ObjType;
    let returnsType: Type;
    try {
      const fnDef: TypeDef = {
        name: 'fn',
        call: {
          ...(input.types ? { types: input.types } : {}),
          args: input.args,
          returns: input.returns,
        },
      };
      const parsedFn = ctx.registry.parse(fnDef);
      const parsedCall = (parsedFn as { _call?: { args: Type; returns?: Type } })._call;
      if (!parsedCall) throw new Error('parsed FnType has no call spec');
      if (!(parsedCall.args instanceof ObjType)) {
        throw new Error(`expected args to be an obj type, got '${parsedCall.args.name}'`);
      }
      argsType = parsedCall.args;
      if (!parsedCall.returns) throw new Error('returns is required');
      returnsType = parsedCall.returns;
    } catch (e: unknown) {
      // Return-as-string (not throw) so the designer's LLM sees the
      // failure reason in the tool result. `ToolInterrupt` would be
      // captured by `@aeye/core` as a suspension event with an empty
      // tool result — the LLM gets nothing useful and silently emits
      // `created: []`.
      return (
        `// FAILED: could not parse signature for '${input.name}': ${e instanceof Error ? e.message : String(e)}. `
        + `args must be an obj type whose props are the function's parameters — e.g. \`{ name: "obj", props: { n: { type: { name: "num" } } } }\`. `
        + `If you declared \`types\` aliases, ensure each is declared before it's referenced and that referenced names are bare \`{name: "<alias>"}\`. `
        + `Do NOT include '${input.name}' in your final \`created\` list.`
      );
    }

    logger.mem(`createNewFn ${input.name} signature parsed`);
    const argsCode = (() => { try { return argsType.toCode(); } catch { return JSON.stringify(input.args); } })();
    const returnsCode = (() => { try { return returnsType.toCode(); } catch { return JSON.stringify(input.returns); } })();
    logger.mem(`createNewFn ${input.name} toCode done (args=${argsCode.length} returns=${returnsCode.length})`);

    // `argsType` is guaranteed to be an `ObjType` by the parse step
    // above, so its `fields` map is the parameter list directly.
    const paramNames: string[] = Object.keys(argsType.fields);
    const paramList = paramNames.length === 0
      ? '(no parameters — body should produce a value of the return type with no inputs)'
      : paramNames.map((p) => `\`${p}\``).join(', ');

    // Build the chain ancestry for the inner programmer. Each prior
    // designer call appended its `create_new_fn` input as one entry.
    // The current call appends itself BEFORE the inner programmer is
    // launched so the deepest entry is "you are here".
    const parentChain = ctx.programmerChain ?? [];
    const youAreHere: ProgrammerChainEntry = {
      name: input.name,
      argsCode,
      returnsCode,
      description: input.description,
    };
    const innerChain: ProgrammerChainEntry[] = [...parentChain, youAreHere];

    // Render the chain block — only when there's an enclosing caller
    // (depth ≥ 1). At depth 0 there is no parent fn; the user's
    // request is already in the conversation as a regular message.
    const chainBlock = (() => {
      if (parentChain.length === 0 && !ctx.originalRequest) return '';
      const lines: string[] = [];
      lines.push(`## Call chain — why this function exists`);
      lines.push(``);
      if (ctx.originalRequest) {
        lines.push(`Top-level user request:`);
        for (const ln of ctx.originalRequest.split('\n')) lines.push(`> ${ln}`);
        lines.push(``);
      }
      lines.push(`Your function is being built to support a chain of callers:`);
      lines.push(``);
      innerChain.forEach((entry, i) => {
        const here = i === innerChain.length - 1 ? '     ← YOU ARE HERE' : '';
        lines.push(`  ${i + 1}. ${entry.name}(${entry.argsCode}): ${entry.returnsCode}${here}`);
        lines.push(`     "${entry.description}"`);
      });
      lines.push(``);
      lines.push(
        innerChain.length === 1
          ? `Keep your scope tight to what the top-level request actually needs — don't add features it doesn't ask for.`
          : `The level-${innerChain.length - 1} caller (\`${parentChain[parentChain.length - 1]!.name}\`) is building its function and needs yours to do its job. Keep your scope tight to what that caller actually needs — don't add features the chain above doesn't ask for.`,
      );
      lines.push(``);
      return lines.join('\n') + '\n';
    })();

    // Spell out the job in the recursive programmer's first user
    // message so it has the full signature in scope and doesn't try to
    // delegate back to find_or_create_functions / create_new_fn.
    const request = [
      `You ARE the writer of this gin function. The designer has already designed the signature; your job is to author the body. Do NOT call find_or_create_functions or delegate elsewhere.`,
      ``,
      `Function name: ${input.name}`,
      `Args type:     ${argsCode}`,
      `Returns type:  ${returnsCode}`,
      `Description:   ${input.description}`,
      ``,
      chainBlock,
      `## How parameters work`,
      ``,
      `Parameters are bound under a single \`args\` scope variable (the entire signature obj). To read a parameter, walk the path \`args.<name>\`.`,
      `- For \`(n: num, m: text): R\`, read \`n\` via \`{ kind: "get", path: [{ prop: "args" }, { prop: "n" }] }\`, and \`m\` via \`{ kind: "get", path: [{ prop: "args" }, { prop: "m" }] }\`.`,
      `- DO NOT redeclare params with \`define\` — they are already bound under \`args\`.`,
      `- DO NOT read a bare \`n\` or \`obj\` from scope; those names aren't there.`,
      ``,
      `Parameters available: ${paramList}`,
      ``,
      `## Recursion via \`recurse\``,
      ``,
      `The function itself is bound as the scope variable \`recurse\` — call it to recurse. Path: \`{ kind: "get", path: [{ prop: "recurse" }, { args: { ...new args... } }] }\`.`,
      `Example pattern (factorial-style descent): test \`args.n\`; base-case returns a literal; recursive case calls \`recurse({ n: args.n.sub({ other: 1 }) })\` and combines that with \`args.n\`.`,
      `Use \`recurse\` for any self-calls — do NOT try to look up the function by its eventual saved name (\`${input.name}\`); that name is not yet bound during testing.`,
      ``,
      `## Inputs are PARAMETERS, not constants`,
      ``,
      `The body must operate on \`args.*\` — not on hardcoded sample values. test() will call your body with sample values to verify it works, but the SAVED body must compute its result from whichever values the caller passes in.`,
      `- Wrong: \`define n = new num{value: 56}\` then loop on \`n\` — this hardcodes 56 forever.`,
      `- Right: get('args').get('n') (i.e. path \`[{prop:"args"}, {prop:"n"}]\`), and operate on that.`,
      `If you find yourself writing \`new num{value: <some literal from the description>}\`, ask whether that value should actually come from \`args\` — usually it should.`,
      ``,
      `## Steps`,
      ``,
      `1. \`write({ program: <body that reads args.* and produces a ${returnsCode}> })\`.`,
      `2. \`test({ args: { ${paramNames.map((p) => `${p}: <sample>`).join(', ')} } })\` — concrete sample values matching the args type; the args schema is auto-built from the function's args type.`,
      `3. \`finish({ saveAs: '${input.name}' })\` once the test passes — this persists the body with the designer-designed signature.`,
    ].join('\n');

    // Fresh sub-conversation, fresh runState we can read after the run
    // finishes, bumped programmerDepth so the recursion cap kicks in,
    // and `targetFn` so test()/finish() can specialize their behavior.
    const messages: Message[] = [{ role: 'user', content: request }];
    const childDepth = (ctx.programmerDepth ?? 0) + 1;
    const innerRunState = createRunState();
    const innerCtx = {
      ...ctx,
      messages,
      programmerDepth: childDepth,
      programmerChain: innerChain,
      runState: innerRunState,
      targetFn: {
        name: input.name,
        argsType,
        returnsType,
        ...(input.types
          ? {
            callTypes: input.types,
            sourceArgs: input.args,
            sourceReturns: input.returns,
          }
          : {}),
      },
    };

    logger.mem(`createNewFn ${input.name} request built (chars=${request.length}) — spawning inner programmer`);
    await runSubagent(
      `programmer: ${input.name} (depth ${childDepth})`,
      () => programmer.get('stream', {}, innerCtx),
      ctx.signal,
    );
    logger.mem(`createNewFn ${input.name} inner programmer returned`);

    // Verify the inner programmer actually produced a working draft.
    // Return the failure as a string (not a `ToolInterrupt` throw) so
    // the designer's LLM sees WHY in the tool result and can decide to
    // try a different signature, give up cleanly, or relay the reason.
    // Strings starting with `// FAILED:` are the convention the
    // designer's prompt teaches to keep the failed name out of the
    // final `created` list.
    if (!innerRunState.lastTest?.success) {
      const why = innerRunState.lastTest?.error ?? 'no successful test was recorded';
      return (
        `// FAILED: function '${input.name}' was NOT created — programmer did not reach a passing test (${why}). `
        + `Refine the description / signature and try again, or do not include this name in your final \`created\` list.`
      );
    }
    if (!ctx.loadedFns.has(input.name)) {
      return (
        `// FAILED: function '${input.name}' was NOT saved — programmer reached a passing test but didn't call finish({ saveAs: '${input.name}' }). `
        + `Do not include this name in your final \`created\` list.`
      );
    }
    return `Function '${input.name}' created (${argsCode} → ${returnsCode}). It is now safe to include '${input.name}' in your final \`created\` list.`;
  },
});

/**
 * Edit an existing saved function. The new signature is checked
 * against the old for backwards-compatibility BEFORE the programmer
 * is spawned to write a fresh body:
 *
 *   - args (contravariant): the new args obj must accept every
 *     old-args input. Concretely — every required field on the old
 *     args must be present on the new with a wider-or-equal type;
 *     newly-added fields must be optional.
 *   - returns (covariant): the new return type must produce values
 *     that fit the old return type's contract. Narrowing return is
 *     always fine; widening is rejected.
 *
 * The body is written from scratch — `targetFn` is set on the inner
 * programmer's ctx exactly the same as `create_new_fn`. The disk
 * record is overwritten on `finish()` only after the programmer
 * reaches a passing test.
 */
const editFn = ai.tool({
  name: 'edit_fn',
  description: 'Edit a saved function: new signature (compat-checked) + fresh body authored by an inner programmer.',
  instructions:
    'Replace a saved function. The new args / returns are checked against the old: existing callers must keep working. ' +
    'Allowed: widen args (add optional params, widen field types), narrow returns. ' +
    'Rejected: removing required args, narrowing arg types, widening returns.',
  schema: (ctx) => {
    const opts = buildSchemas(ctx.registry);
    return z.object({
      name: z.string().describe('Saved function name (matches the file at `./fns/<name>.json`).'),
      description: z.string().describe('Updated description for the body programmer'),
      types: z
        .record(z.string(), opts.Type as z.ZodType<TypeDef>)
        .optional()
        .describe('Optional `call.types` aliases — same semantics as `create_new_fn`.'),
      args: (opts.Type as z.ZodType<TypeDef>).describe('New args TypeDef. Must accept every value the old args accepted.'),
      returns: (opts.Type as z.ZodType<TypeDef>).describe('New return TypeDef. Must be assignable back into the old return type.'),
    });
  },
  applicable: (ctx) => (ctx.programmerDepth ?? 0) < MAX_PROGRAMMER_DEPTH - 1,
  call: async (
    input: {
      name: string;
      description: string;
      args: TypeDef;
      returns: TypeDef;
      types?: Record<string, TypeDef>;
    },
    _refs,
    ctx,
  ) => {
    // 1. Read the existing fn off disk and parse it. If anything goes
    //    wrong here, the edit is fundamentally not possible — surface
    //    the reason and bail.
    let oldFnDef: TypeDef;
    try {
      oldFnDef = ctx.store.readFn(input.name);
    } catch {
      return `// FAILED: function '${input.name}' not found at \`./fns/${input.name}.json\`. Use \`create_new_fn\` instead, or \`search_fns\` to find what's actually saved.`;
    }
    let oldArgsType: ObjType;
    let oldReturnsType: Type;
    try {
      const oldFn = ctx.registry.parse(oldFnDef);
      const oldCall = (oldFn as { _call?: { args: Type; returns?: Type } })._call;
      if (!oldCall?.args || !(oldCall.args instanceof ObjType)) {
        throw new Error('saved fn has no obj-typed args');
      }
      if (!oldCall.returns) throw new Error('saved fn has no return type');
      oldArgsType = oldCall.args;
      oldReturnsType = oldCall.returns;
    } catch (e: unknown) {
      return `// FAILED: could not parse on-disk fn '${input.name}': ${e instanceof Error ? e.message : String(e)}.`;
    }

    // 2. Parse the proposed new signature exactly like create_new_fn.
    let newArgsType: ObjType;
    let newReturnsType: Type;
    try {
      const fnDef: TypeDef = {
        name: 'fn',
        call: {
          ...(input.types ? { types: input.types } : {}),
          args: input.args,
          returns: input.returns,
        },
      };
      const parsedFn = ctx.registry.parse(fnDef);
      const parsedCall = (parsedFn as { _call?: { args: Type; returns?: Type } })._call;
      if (!parsedCall) throw new Error('parsed FnType has no call spec');
      if (!(parsedCall.args instanceof ObjType)) {
        throw new Error(`expected args to be an obj type, got '${parsedCall.args.name}'`);
      }
      newArgsType = parsedCall.args;
      if (!parsedCall.returns) throw new Error('returns is required');
      newReturnsType = parsedCall.returns;
    } catch (e: unknown) {
      return `// FAILED: could not parse new signature for '${input.name}': ${e instanceof Error ? e.message : String(e)}.`;
    }

    // 3. Backwards-compat check. Args contravariant, returns
    //    covariant. We delegate to the per-Type `compatible` methods
    //    (obj's already accepts extra optional fields after the
    //    obj-compat fix; non-obj types fall through to the standard
    //    "values fit" relation).
    if (!newArgsType.compatible(oldArgsType)) {
      return (
        `// FAILED: new args type '${safeToCode(newArgsType)}' is not a backwards-compatible widening of old args '${safeToCode(oldArgsType)}'.\n`
        + `// Allowed: add optional params, widen existing param types.\n`
        + `// Rejected: removing required params, narrowing param types.`
      );
    }
    if (!oldReturnsType.compatible(newReturnsType)) {
      return (
        `// FAILED: new return type '${safeToCode(newReturnsType)}' is not assignable to old '${safeToCode(oldReturnsType)}'.\n`
        + `// Returns may NARROW (subset), not WIDEN — callers expecting the old shape must still receive values that fit it.`
      );
    }

    // 4. Compat passed — spawn an inner programmer to author a fresh
    //    body, identical machinery to create_new_fn from this point.
    const argsCode = (() => { try { return newArgsType.toCode(); } catch { return JSON.stringify(input.args); } })();
    const returnsCode = (() => { try { return newReturnsType.toCode(); } catch { return JSON.stringify(input.returns); } })();
    const paramNames: string[] = Object.keys(newArgsType.fields);
    const paramList = paramNames.length === 0
      ? '(no parameters)'
      : paramNames.map((p) => `\`${p}\``).join(', ');

    const parentChain = ctx.programmerChain ?? [];
    const youAreHere: ProgrammerChainEntry = {
      name: input.name,
      argsCode,
      returnsCode,
      description: input.description,
    };
    const innerChain: ProgrammerChainEntry[] = [...parentChain, youAreHere];

    const request = [
      `You ARE the writer of this gin function. You're EDITING an existing saved fn — old signature is being replaced and a new body is needed. Do NOT call find_or_create_functions or delegate elsewhere.`,
      ``,
      `Function name: ${input.name}`,
      `Old args:      ${safeToCode(oldArgsType)}`,
      `Old returns:   ${safeToCode(oldReturnsType)}`,
      `New args:      ${argsCode}`,
      `New returns:   ${returnsCode}`,
      `Description:   ${input.description}`,
      ``,
      `## How parameters work`,
      ``,
      `Parameters are bound under \`args\` — read \`args.<name>\` via \`{ kind: "get", path: [{ prop: "args" }, { prop: "<name>" }] }\`. Available params: ${paramList}.`,
      ``,
      `## Recursion via \`recurse\``,
      ``,
      `\`recurse\` is the (new) function bound for self-calls. Path: \`{ kind: "get", path: [{ prop: "recurse" }, { args: { ... } }] }\`.`,
      ``,
      `## Steps`,
      ``,
      `1. \`write({ program: <new body matching the new signature> })\`.`,
      `2. \`test({ args: { ${paramNames.map((p) => `${p}: <sample>`).join(', ')} } })\`.`,
      `3. \`finish({ saveAs: '${input.name}' })\` once the test passes — overwrites the existing on-disk fn.`,
    ].join('\n');

    const messages: Message[] = [{ role: 'user', content: request }];
    const childDepth = (ctx.programmerDepth ?? 0) + 1;
    const innerRunState = createRunState();
    const innerCtx = {
      ...ctx,
      messages,
      programmerDepth: childDepth,
      programmerChain: innerChain,
      runState: innerRunState,
      targetFn: {
        name: input.name,
        argsType: newArgsType,
        returnsType: newReturnsType,
        ...(input.types
          ? {
            callTypes: input.types,
            sourceArgs: input.args,
            sourceReturns: input.returns,
          }
          : {}),
      },
    };

    await runSubagent(
      `programmer: ${input.name} edit (depth ${childDepth})`,
      () => programmer.get('stream', {}, innerCtx),
      ctx.signal,
    );

    if (!innerRunState.lastTest?.success) {
      const why = innerRunState.lastTest?.error ?? 'no successful test was recorded';
      return `// FAILED: edit of '${input.name}' did not reach a passing test (${why}). The on-disk fn is UNCHANGED.`;
    }
    if (!ctx.loadedFns.has(input.name)) {
      return `// FAILED: programmer reached a passing test but didn't call finish({ saveAs: '${input.name}' }). The on-disk fn is UNCHANGED.`;
    }
    return `Function '${input.name}' edited (now ${argsCode} → ${returnsCode}). The new body has been persisted.`;
  },
});

function safeToCode(t: { toCode?: () => string; name?: string } | undefined): string {
  if (!t) return '<unparsed>';
  try { return (t.toCode?.() ?? t.name) ?? '<unrenderable>'; }
  catch { return t.name ?? '<unrenderable>'; }
}

export const designer = ai.prompt({
  name: 'designer',
  description: 'Design or reuse gin functions — the reusable building blocks of programs.',
  metadata: modelFor('designer'),
  content: `You are the designer — responsible for designing and curating
reusable gin functions. Find an existing function that matches the
request or spin up a programmer to author a new one.

## Inputs become parameters

When designing a new function, every value the function "operates on"
must become a parameter in \`args\` — not a constant inside the body.
A user asking for "a function that computes prime factors of a number"
wants a function they can call later as \`primeFactors({ n: 5 })\`,
\`primeFactors({ n: 56 })\`, etc. — so the right signature is
\`{ name: "obj", props: { n: { type: { name: "num" } } } }\` returning
\`list<num>\`. Burying a sample value (like 56) inside the body would
make the function answer the same question forever.

When in doubt:
- Anything the user said should be variable → parameter.
- Anything the user said is fixed (a constant, a known formula) → may
  be a literal in the body.

## Honest reporting

\`use\` and \`created\` must reflect what is ACTUALLY available on disk:
- Only put a name in \`use\` if \`get_fn\` (or \`search_fns\` + \`get_fn\`)
  confirmed it exists.
- Only put a name in \`created\` if \`create_new_fn\` OR \`edit_fn\`
  returned successfully for that name in this session. If either
  raised an error, the function was NOT written — do NOT claim it as
  created. The programmer that consumes your output will load each
  name from disk and break if you fabricate entries.

If you couldn't satisfy the request, return empty arrays and let the
programmer write the work inline rather than claiming a non-existent
function.

## Edit vs create

Use \`edit_fn\` when the request is to MODIFY an existing saved fn
(widen its args, narrow its returns, change its body). The edit tool
enforces backwards-compatibility — args may add optional params or
widen existing param types; returns may narrow. If the requested
change would break callers (remove a required arg, narrow arg types,
widen returns), \`edit_fn\` rejects it and you should either tell the
caller it's incompatible OR \`create_new_fn\` under a different name.

Use \`create_new_fn\` for net-new functionality.

## Sequencing parallel requests

When a single request asks for multiple fns and one composes the
others (e.g. \`fetchAndSummarize\` calls \`fetchContent\` and
\`summarizeContent\`), you MUST issue \`create_new_fn\` calls
SEQUENTIALLY — one at a time — with the dependencies first, the
composer last. Independent fns can be created in any order.

Why: tool calls in a single LLM round run in parallel. If you queue
\`fetchContent\`, \`summarizeContent\`, AND \`fetchAndSummarize\` in
the same round, the inner programmer authoring \`fetchAndSummarize\`
sees neither dependency loaded — it has to re-derive the fetch + llm
logic inline, which is exactly the duplication this designer is
supposed to prevent. So:

  Round 1: \`create_new_fn\` for \`fetchContent\`. Wait for the
           result.
  Round 2: \`create_new_fn\` for \`summarizeContent\`. Wait.
  Round 3: \`create_new_fn\` for \`fetchAndSummarize\` — which can
           now reference both.

Request: {{description}}`,
  input: (input: { description: string }) => ({ description: input.description }),
  tools: [searchFns, getFn, printFn, createNewFn, editFn, ask],
  toolIterations: toolIterationsConfig(),
  excludeMessages: true,
  schema: z.object({
    use: z.array(z.string()).default([]).describe('Names of existing functions confirmed via get_fn / search_fns.'),
    created: z.array(z.string()).default([]).describe('Names of functions create_new_fn successfully wrote to disk this session. Do NOT include names where create_new_fn errored.'),
  }),
  // Round-trip the designer's structured output against disk before
  // returning it. Anything in `use` / `created` must actually be
  // readable via `store.readFn` — otherwise the designer is
  // hallucinating and the programmer downstream would hit ENOENT when
  // it tries to load the fn. Throwing here forces the prompt loop to
  // re-prompt the designer with the validation error so it can fix the
  // arrays.
  validate: (output, ctx) => {
    const { use = [], created = [] } = output;
    const missing: string[] = [];
    for (const name of [...use, ...created]) {
      try { ctx.store.readFn(name); } catch { missing.push(name); }
    }
    if (missing.length > 0) {
      throw new Error(
        `Your output references function(s) that are NOT on disk: ${missing.join(', ')}. ` +
        `Either remove them from \`use\` / \`created\` or actually create them via create_new_fn first. ` +
        `Do NOT report a function as created when create_new_fn raised an error.`,
      );
    }
  },
});
