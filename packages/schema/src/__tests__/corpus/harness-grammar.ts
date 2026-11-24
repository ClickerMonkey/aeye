/**
 * CORPUS: the program grammar the harness's authoring drafts are typed by — `session.state.program.schemas()`
 * (sdk/src/program/runtime.ts:133): gin's `buildSchemas` over a registry of the built-in types plus the types bound in
 * the session (the target fn's args, `fire`, a loaded table type…), cached until more are bound (`kept.count ===
 * this.#named.length`), with the `keptLazy` workaround (runtime.ts:144 "LIBRARY GAP (gin)") for zod's lazy recursion.
 *
 * In `a` the grammar is one module defined once (recursion is `a.ref`, no workaround); only the session's named types
 * are dynamic (keyed by how many are bound, as `schemas()` is). This is the SUBSET of gin's grammar the harness's
 * drafts and fixtures use (gin's own grammar — every Expr and TypeDef class — is the gin corpus's): TypeDefs of the
 * built-in classes the harness writes (text, num, bool, date, timestamp, duration, any, enum, list, optional,
 * nullable, obj, record) or a named type; Exprs `get` (paths of prop / args / key steps), `new`, `template`, `if`,
 * `block`, `define`. Descriptions are gin's own (packages/gin/src/exprs/*.ts).
 */
import { expectTypeOf } from 'expect-type';
import { a } from '../../index';

/** A gin TypeDef of the classes the harness writes, as code holds it (gin schema.ts `TypeDef`, narrowed per class). */
export type TypeDefT =
  | { name: 'text'; docs?: string; options?: { minLength?: number; maxLength?: number; pattern?: string } }
  | { name: 'num'; docs?: string; options?: { min?: number; max?: number; whole?: boolean } }
  | { name: 'bool' | 'date' | 'timestamp' | 'duration' | 'any'; docs?: string }
  | { name: 'enum'; docs?: string; generic?: { V: TypeDefT }; options: { values: Record<string, string | number> } }
  | { name: 'list'; docs?: string; generic: { V: TypeDefT }; options?: { minLength?: number; maxLength?: number } }
  | { name: 'optional' | 'nullable'; generic: { T: TypeDefT } }
  | ObjTypeDefT
  | { name: 'record'; generic: { V: TypeDefT } }
  | { name: string };
export interface ObjTypeDefT { name: 'obj'; docs?: string; props: Record<string, { type: TypeDefT; docs?: string }> }
/** A gin expression of the kinds the harness's drafts use. */
export type ExprT =
  | { kind: 'get'; path: PathStepT[] }
  | { kind: 'new'; type: TypeDefT; value?: unknown }
  | { kind: 'template'; template: ExprT | string; params?: ExprT }
  | { kind: 'if'; ifs: { condition: ExprT; body: ExprT }[]; else?: ExprT }
  | { kind: 'block'; lines: ExprT[] }
  | { kind: 'define'; vars: { name: string; type?: TypeDefT; value: ExprT }[]; body: ExprT };
export type PathStepT = { prop: string } | { args: Record<string, ExprT> } | { key: ExprT };

const lengths = a.object({ minLength: a.int().min(0).optional(), maxLength: a.int().min(1).optional() });
const docs = a.string().optional();

/** The static grammar (gin's TypeDef / Expr schemas, `aid`s as named types). */
export const grammar = {
  TypeDef: a.union([
    a.object({ name: a.literal('text'), docs, options: lengths.extend({ pattern: a.string().optional() }).optional() }),
    a.object({ name: a.literal('num'), docs, options: a.object({ min: a.number().optional(), max: a.number().optional(), whole: a.boolean().optional() }).optional() }),
    a.object({ name: a.enum(['bool', 'date', 'timestamp', 'duration', 'any']), docs }),
    a.object({ name: a.literal('enum'), docs, generic: a.object({ V: a.ref('TypeDef') }).optional(), options: a.object({ values: a.record(a.union([a.string(), a.number()])) }) }),
    a.object({ name: a.literal('list'), docs, generic: a.object({ V: a.ref('TypeDef') }), options: lengths.optional() }),
    a.object({ name: a.enum(['optional', 'nullable']), generic: a.object({ T: a.ref('TypeDef') }) }),
    a.ref('ObjTypeDef'),
    a.object({ name: a.literal('record'), generic: a.object({ V: a.ref('TypeDef') }) }),
    // a named type the session has bound, by name
    a.object({ name: a.ref('NamedType') }),
  ]).describe('A gin type: a built-in class by `name`, or a named type by its name.'),
  ObjTypeDef: a.object({
    name: a.literal('obj'),
    docs,
    props: a.record(a.object({ type: a.ref('TypeDef'), docs: a.string().optional() })).describe('The fields, by name.'),
  }),
  PathStep: a.union([
    a.object({ prop: a.string() }),
    a.object({ args: a.record(a.ref('Expr')) }),
    a.object({ key: a.ref('Expr') }),
  ]),
  Expr: a.discriminatedUnion('kind', [
    a.object({
      kind: a.literal('get'),
      path: a.array(a.ref('PathStep')).min(1).describe('Steps walked left-to-right starting from a scope variable. Step shapes: `{prop:"name"}` for prop/method access, `{args:{…}}` to call the previous step, `{key:Expr}` for index access.'),
    }),
    a.object({
      kind: a.literal('new'),
      type: a.ref('TypeDef').describe('TypeDef of the value being constructed.'),
      // gin: `z.any().optional()` (a value whose slots may hold Exprs)
      value: a.unknown().optional().describe('Initial value matching `type`.'),
    }),
    a.object({
      kind: a.literal('template'),
      template: a.union([a.ref('Expr'), a.string()]).describe('The template string — either a literal string or an Expr that evaluates to text. Placeholders use `{name}` syntax.'),
      params: a.ref('Expr').optional().describe('Optional obj-typed expression supplying placeholder values.'),
    }),
    a.object({
      kind: a.literal('if'),
      ifs: a.array(a.object({ condition: a.ref('Expr'), body: a.ref('Expr') })).describe('Ordered list of `{condition, body}` branches — first true condition wins.'),
      else: a.ref('Expr').optional(),
    }),
    a.object({ kind: a.literal('block'), lines: a.array(a.ref('Expr')) }),
    a.object({
      kind: a.literal('define'),
      vars: a.array(a.object({ name: a.string(), type: a.ref('TypeDef').optional(), value: a.ref('Expr') })),
      body: a.ref('Expr'),
    }),
  ]),
} as const;

/** A named type bound in the session (`ProgramAuthoring.preload`, `loadTypes`). */
export interface BoundType {
  readonly name: string;
  readonly def: TypeDefT;
}
/** The session state `schemas()` reads: its bound named types, in order. */
export interface ProgramSessionLike {
  readonly named: readonly BoundType[];
}

/**
 * runtime.ts:133 `schemas()`: the grammar plus the session's named types, kept until more are bound. The names are
 * an enum of what the session has bound; a session with none takes any name (gin parses it later).
 */
export const Grammar = a
  .define(grammar)
  .declare<{ NamedType: string }>()
  .dynamic(
    (session: ProgramSessionLike) => ({
      NamedType: session.named.length > 0 ? a.enum(session.named.map((t) => t.name) as [string, ...string[]]) : a.string(),
    }),
    { key: (session) => `${session.named.length}:${session.named.map((t) => t.name).join(',')}` },
  );

/** gin's `Expr` (`schemas().Expr`): a whole program. */
export const Program = Grammar.result('Expr');
/** gin's `Type` (`schemas().Type`). */
export const TypeDefSchema = Grammar.result('TypeDef');

type Program = a.infer<typeof Program>;
type TypeDefOut = a.infer<typeof TypeDefSchema>;
// The grammar's code types are gin's ExprDef / TypeDef, recursion included.
expectTypeOf<Extract<Program, { kind: 'define' }>['body']>().toEqualTypeOf<Program>();
expectTypeOf<Extract<Program, { kind: 'get' }>['path'][number]>().toMatchTypeOf<{ prop: string } | { args: Record<string, Program> } | { key: Program }>();
expectTypeOf<Extract<TypeDefOut, { name: 'list' }>['generic']['V']>().toEqualTypeOf<TypeDefOut>();
expectTypeOf<Extract<TypeDefOut, { name: 'obj' }>['props'][string]['type']>().toEqualTypeOf<TypeDefOut>();
expectTypeOf<Program>().toMatchTypeOf<ExprT>();
expectTypeOf<TypeDefOut>().toMatchTypeOf<TypeDefT>();
expectTypeOf(Program.bind).parameters.toEqualTypeOf<[session: ProgramSessionLike]>();
