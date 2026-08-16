// Schema (JSON shapes)
export * from './schema';
export {
  TYPE_DEF_KEYS, PROP_DEF_KEYS, GET_SET_DEF_KEYS, CALL_DEF_KEYS, INIT_DEF_KEYS,
  CALL_DEF_HINTS, PROP_DEF_HINTS,
  checkWireKeys, checkDefKeys, checkPathStep,
  type CoversKeys, type AssertCovered, type DefKeyHint,
} from './wire';
// The JSON shapes of a VALUE. `Value.toJSON()` returns a `JSONValue<T>` and
// takes an `EncodeOptions`, so a consumer that could not name either had to
// re-derive both — the module was simply never re-exported.
export type { JSONValue, JSONOf, RuntimeOf, EncodeOptions } from './json-type';
export type { Node, CodeOptions, SchemaOptions } from './node';
export { buildSchemas } from './schemas';

// Core
export { didYouMean, nearest, editDistance, suggestionBudget, deepSuggest, alignSegments } from './aids';
export * from './problem';
export { Effects, combine as combineEffects, has as hasEffects, formatEffects } from './effects';
export {
  Code,
  code,
  span,
  plain,
  joinCode,
  joinLines,
  type Span,
  type CodeLine,
  type FormatOptions,
  type FormatProblemsOptions,
  type JSONEntry,
} from './code';
export * from './value';
export * from './scope';
export { LocalScope, type TypeScope } from './type-scope';
export * from './type';
export * from './extension';
export * from './builder';
export * from './registry';
export * from './flow-control';
export { Path, PathStep, PropStep, IndexStep, CallStep, walkPath, type PathMode } from './path';
export * from './analysis';
export * from './engine';
export * from './expr';
export { NewExpr } from './exprs/new';
export { GetExpr } from './exprs/get';
export { SetExpr } from './exprs/set';
export { DefineExpr } from './exprs/define';
export { BlockExpr } from './exprs/block';
export { IfExpr } from './exprs/if';
export { SwitchExpr } from './exprs/switch';
export { LoopExpr } from './exprs/loop';
export { LambdaExpr } from './exprs/lambda';
export { TemplateExpr } from './exprs/template';
export { FlowExpr } from './exprs/flow';
export { NativeExpr } from './exprs/native';

// Concrete types
export * from './types';

// Native implementations
export { registerBuiltinNatives } from './natives';
