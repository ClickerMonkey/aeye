// Schema (JSON shapes)
export * from './schema';
export type { Node, CodeOptions, SchemaOptions } from './node';
export { buildSchemas } from './schemas';

// Core
export * from './problem';
export {
  Code,
  code,
  span,
  plain,
  joinCode,
  joinLines,
  jsonObject,
  jsonArray,
  jsonString,
  formatProblem,
  formatProblems,
  type Span,
  type CodeLine,
  type FormatOptions,
  type FormatProblemsOptions,
  type JSONEntry,
} from './code';
export * from './value';
export * from './scope';
export * from './type';
export * from './extension';
export * from './spec';
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
