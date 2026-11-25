/**
 * The CODE shapes the grammar module decodes to (`a.infer` of `GinGrammar`'s results),
 * narrowed per class / kind as the grammar writes them. Structurally gin's
 * `TypeDef` / `ExprDef` (schema.ts); exported as the `GinShapes` namespace.
 */


export interface PropDef { docs?: string; type: TypeDef; get?: ExprDef; default?: ExprDef; set?: ExprDef }

export interface GetSetDef { docs?: string; key: TypeDef; value: TypeDef; get?: ExprDef; set?: ExprDef; loop?: ExprDef; loopDynamic?: boolean }

export interface CallDef { docs?: string; types?: Record<string, TypeDef>; args: TypeDef; returns?: TypeDef; throws?: TypeDef; get?: ExprDef; set?: ExprDef }

export interface InitDef { docs?: string; args: TypeDef; run: ExprDef }
export type Generic = Record<string, TypeDef>;

export interface TypeAny { name: 'any' }
export interface TypeVoid { name: 'void' }
export interface TypeNull { name: 'null' }
export interface TypeBool { name: 'bool'; options?: { trueText?: string; falseText?: string } }
export interface TypeNum {
  name: 'num';
  options?: { min?: number; max?: number; whole?: boolean; minPrecision?: number; maxPrecision?: number; prefix?: string; suffix?: string };
}
export interface TypeText { name: 'text'; options?: { minLength?: number; maxLength?: number; pattern?: string; flags?: string } }
export interface TypeList { name: 'list'; generic?: { V: TypeDef }; options?: { minLength?: number; maxLength?: number } }
export interface TypeMap { name: 'map'; generic?: { K: TypeDef; V: TypeDef } }
export interface TypeTuple { name: 'tuple'; options: { elements: TypeDef[] } }
export interface TypeObject { name: 'obj'; props?: Record<string, PropDef> }
export interface TypeOptional { name: 'optional'; generic?: { T: TypeDef } }
export interface TypeNullable { name: 'nullable'; generic?: { T: TypeDef } }
export interface TypeNot { name: 'not'; options: { excluded: TypeDef } }
export interface TypeOr { name: 'or'; options: { types: TypeDef[] } }
export interface TypeAnd { name: 'and'; options: { types: TypeDef[] } }
export interface TypeEnum { name: 'enum'; generic?: { V: TypeDef }; options: { values: Record<string, unknown> } }
export interface TypeLiteral { name: 'literal'; generic?: { T: TypeDef }; options: { value: unknown } }
export interface TypeFunction { name: 'fn'; call?: CallDef }
export interface TypeInterface { name: 'interface'; props?: Record<string, PropDef>; get?: GetSetDef; call?: CallDef }
export interface TypeTyp { name: 'typ'; generic?: { T: TypeDef } }
export interface TypeDate { name: 'date'; options?: { min?: string; max?: string; utc?: boolean } }
export interface TypeTimestamp { name: 'timestamp'; options?: { min?: string; max?: string; utc?: boolean; precision?: 'ms' | 's' | 'us' } }
export interface TypeDuration { name: 'duration' }
export interface TypeColor { name: 'color'; options?: { hasAlpha?: boolean } }

export interface TypeExtension {
  name: string;
  extends: string;
  docs?: string;
  satisfies?: string[];
  generic?: Generic;
  options?: Record<string, unknown>;
  props?: Record<string, PropDef>;
  get?: GetSetDef;
  call?: CallDef;
  init?: InitDef;
  constraint?: ExprDef;
}

export interface TypeNamed { name: string }

export type TypeClass =
  | TypeAny | TypeVoid | TypeNull | TypeBool | TypeNum | TypeText | TypeList | TypeMap | TypeTuple | TypeObject
  | TypeOptional | TypeNullable | TypeNot | TypeOr | TypeAnd | TypeEnum | TypeLiteral | TypeFunction | TypeInterface
  | TypeTyp | TypeDate | TypeTimestamp | TypeDuration | TypeColor;
export type TypeDef = TypeNamed | TypeClass | TypeExtension;


export type PathStep = { prop: string } | { args: Record<string, ExprDef>; generic?: Generic; catch?: ExprDef } | { key: ExprDef };

export interface BlockExpr { kind: 'block'; comment?: string; lines: ExprDef[] }
export interface DefineExpr { kind: 'define'; comment?: string; vars: { name: string; type?: TypeDef; value: ExprDef }[]; body: ExprDef }
export interface FlowExpr { kind: 'flow'; action: 'break' | 'continue' | 'return' | 'exit' | 'throw'; value?: ExprDef; error?: ExprDef }
export interface GetExpr { kind: 'get'; path: PathStep[] }
export interface IfExpr { kind: 'if'; comment?: string; ifs: { condition: ExprDef; body: ExprDef }[]; else?: ExprDef }
export interface LambdaExpr { kind: 'lambda'; comment?: string; type: TypeDef; body: ExprDef; constraint?: ExprDef }
export interface LoopExpr {
  kind: 'loop'; comment?: string; over: ExprDef; body: ExprDef; key?: string; value?: string;
  parallel?: { concurrent?: ExprDef; rate?: ExprDef };
}
export interface NativeExpr { kind: 'native'; comment?: string; id: string; type?: TypeDef }
export interface NewExpr { kind: 'new'; type: TypeDef; value?: unknown }
export interface SetExpr { kind: 'set'; comment?: string; path: PathStep[]; value: ExprDef }
export interface SwitchExpr { kind: 'switch'; comment?: string; value: ExprDef; cases: { equals: ExprDef[]; body: ExprDef }[]; else?: ExprDef }
export interface TemplateExpr { kind: 'template'; template: ExprDef | string; params?: ExprDef }
export type ExprDef =
  | NewExpr | GetExpr | SetExpr | DefineExpr | BlockExpr | IfExpr | SwitchExpr | LoopExpr | LambdaExpr | TemplateExpr | FlowExpr | NativeExpr;
