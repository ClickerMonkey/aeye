/**
 * Gin JSON Schema — the shape of serialized types and expressions.
 * All data types are JSON-compatible. Runtime classes parse these into executable objects.
 */

// ============================================================================
// TYPE SCHEMA
// ============================================================================

export interface TypeDef<TOptions = any> {
  name: string;
  docs?: string;
  extends?: string;
  satisfies?: string[];
  generic?: Record<string, TypeDef>;
  options?: TOptions;
  init?: { docs?: string; args: TypeDef; run: ExprDef };
  props?: Record<string, PropDef>;
  get?: GetSetDef;
  call?: CallDef;
  /**
   * Optional runtime predicate that every value of this type must satisfy.
   * Evaluated with `this` bound to the value; must return bool. Consumed
   * by Extension (base types carry their invariants in `options`). Use for
   * logic that options can't express, e.g. `this.startsWith('user-')`.
   */
  constraint?: ExprDef;
}

export interface PropDef {
  docs?: string;
  type: TypeDef;
  get?: ExprDef;
  default?: ExprDef;
  set?: ExprDef;
}

export interface GetSetDef {
  docs?: string;
  key: TypeDef;
  value: TypeDef;
  get?: ExprDef;
  set?: ExprDef;
  loop?: ExprDef;
  /**
   * When true, `LoopExpr` re-evaluates `over` BEFORE every iteration
   * and binds the resulting value to `value` (and the iteration index
   * to `key`). The loop continues while `value.raw` is truthy and
   * exits when it becomes falsy. With this flag the type does NOT
   * need a `loop` native — gin's loop machinery iterates directly.
   *
   * Bool sets this to get while-loop semantics. Other types can opt
   * in with whatever truthy semantic makes sense for their `raw`
   * (optional → present, num → non-zero, etc.).
   */
  loopDynamic?: boolean;
}

export interface CallDef {
  docs?: string;
  /**
   * Local type aliases scoped to THIS call. Each entry is a TypeDef
   * referenced inside `args` / `returns` / `throws` / `get` / `set` via
   * a bare `{name: '<aliasName>'}` reference. Aliases process AFTER
   * the parent type's generics (so they may reference generic
   * placeholders) and BEFORE the call slots (so the slots resolve
   * against them). Sequential — later aliases may reference earlier.
   * Inlining happens at parse time inside `decodeCall`.
   */
  types?: Record<string, TypeDef>;
  args: TypeDef;
  returns?: TypeDef;
  throws?: TypeDef;
  get?: ExprDef;
  set?: ExprDef;
}

// ============================================================================
// EXPRESSION SCHEMA
// ============================================================================

export interface ExprDef {
  kind: string;
  comment?: string;
  [key: string]: any;
}

export type PathStepDef = PathPropDef | PathCallDef | PathIndexDef;
export type PathDef = PathStepDef[];

export interface PathPropDef {
  prop: string;
}

export interface PathCallDef {
  args: Record<string, ExprDef>;
  generic?: Record<string, TypeDef>;
  catch?: ExprDef;
}

export interface PathIndexDef {
  key: ExprDef;
}

// Expression shapes
export interface NewExprDef extends ExprDef {
  kind: 'new';
  type: TypeDef;
  value?: any;
}

export interface GetExprDef extends ExprDef {
  kind: 'get';
  path: PathDef;
}

export interface SetExprDef extends ExprDef {
  kind: 'set';
  path: PathDef;
  value: ExprDef;
}

export interface DefineExprDef extends ExprDef {
  kind: 'define';
  vars: { name: string; type?: TypeDef; value: ExprDef }[];
  body: ExprDef;
}

export interface BlockExprDef extends ExprDef {
  kind: 'block';
  lines: ExprDef[];
}

export interface IfExprDef extends ExprDef {
  kind: 'if';
  ifs: { condition: ExprDef; body: ExprDef }[];
  else?: ExprDef;
}

export interface SwitchExprDef extends ExprDef {
  kind: 'switch';
  value: ExprDef;
  cases: { equals: ExprDef[]; body: ExprDef }[];
  else?: ExprDef;
}

export interface LoopExprDef extends ExprDef {
  kind: 'loop';
  over: ExprDef;
  body: ExprDef;
  key?: string;
  value?: string;
  parallel?: { concurrent?: ExprDef; rate?: ExprDef };
}

export interface LambdaExprDef extends ExprDef {
  kind: 'lambda';
  type: TypeDef;
  body: ExprDef;
  /**
   * Pre-call predicate. Evaluated BEFORE the body with `args` in scope;
   * must return bool. On false, the call fails. Runtime enforcement lives
   * in `LambdaExpr.evaluate`; also appears in the fn's Zod description.
   */
  constraint?: ExprDef;
}

export interface TemplateExprDef extends ExprDef {
  kind: 'template';
  template: string;
  /**
   * Optional expression evaluating to an obj whose props supply
   * placeholder values. When omitted (or when a particular `{name}`
   * key isn't on the obj), placeholders fall back to a scope lookup
   * — so a `${baseUrl}` placeholder resolves to the surrounding
   * `define` of the same name. Provide `params` only when the
   * placeholders need values that aren't already in scope.
   */
  params?: ExprDef;
}

export interface FlowExprDef extends ExprDef {
  kind: 'flow';
  action: 'break' | 'return' | 'continue' | 'exit' | 'throw';
  value?: ExprDef;
  error?: ExprDef;
}

export interface NativeExprDef extends ExprDef {
  kind: 'native';
  id: string;
  type?: TypeDef;
}

// ============================================================================
// GLOBAL
// ============================================================================

export interface GlobalDef {
  docs?: string;
  type: TypeDef;
  value?: any;
}
