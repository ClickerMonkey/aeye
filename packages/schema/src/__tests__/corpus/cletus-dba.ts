/**
 * CORPUS: cletus's DBA query grammar (packages/cletus/src/helpers/dba.ts
 * `createDBASchemas(types)`), the `query` tool (tools/dba.ts:117) with its
 * `shouldUseStringSchema` fallback, and the prompts that answer with a
 * query (operations/dba.tsx: query_fixer, query_builder).
 *
 * In cletus the grammar is rebuilt from the user's type definitions on every
 * call: a recursive set of `z.lazy` schemas named with `.meta({ aid })`,
 * where Table / SourceColumn / Insert / Update / Delete depend on the types.
 * In `a` it is ONE static module: the type-independent grammar is defined
 * once, the type-dependent names are `declare`d with their code types and
 * supplied by a `dynamic` step keyed by the types array.
 */
import { expectTypeOf } from 'expect-type';
import { a, type AllowRefs, type AnySchema, type SchemaOf } from '../../index';
import { prompt, tool, type Context } from '../../proposal/core-api';
import type { CletusCtx, TypeDefinition, TypeField } from './cletus-tools';

// ============================================================================
// The code types (helpers/dba.ts:62-206, verbatim)
// ============================================================================

export type Source = string;
export type Table = string;
export type Column = string;
export type Alias = string;
export type SourceColumn = { source: Source; column: Column | '*' };
export type Constant = number | string | boolean | null;
export type Aggregate = 'count' | 'min' | 'max' | 'avg' | 'sum';
export type Binary = '+' | '-' | '*' | '/';
export type Unary = '-';
export type Comparison = '=' | '<' | '>' | '<=' | '>=' | '<>' | 'like' | 'notLike';
export type SelectOrSet = Select | SetOperation;
export type BooleanValue =
  | { kind: 'comparison'; left: Value; cmp: Comparison; right: Value }
  | { kind: 'in'; value: Value; in: Value[] | SelectOrSet }
  | { kind: 'between'; value: Value; between: [Value, Value] }
  | { kind: 'isNull'; isNull: Value }
  | { kind: 'exists'; exists: SelectOrSet }
  | { kind: 'and'; and: BooleanValue[] }
  | { kind: 'or'; or: BooleanValue[] }
  | { kind: 'not'; not: BooleanValue };
export type SqlFunction =
  | 'concat' | 'substring' | 'length' | 'lower' | 'upper' | 'trim' | 'replace'
  | 'abs' | 'ceil' | 'floor' | 'round' | 'power' | 'sqrt'
  | 'now' | 'current_date' | 'date_add' | 'date_sub' | 'extract' | 'date_trunc'
  | 'coalesce' | 'nullif' | 'greatest' | 'least';
export type FunctionCall = { kind: 'function'; function: SqlFunction; args: Value[] };
export type WindowValue = { kind: 'window'; function: Aggregate | string; value: Value; partitionBy?: Value[] | null; orderBy?: Sort[] | null };
export type Value =
  | SourceColumn
  | Constant
  | Select
  | BooleanValue
  | FunctionCall
  | WindowValue
  | { kind: 'binary'; left: Value; op: Binary; right: Value }
  | { kind: 'unary'; unary: Unary; value: Value }
  | { kind: 'aggregate'; aggregate: Aggregate; value: Value | '*' }
  | { kind: 'semanticSimilarity'; table: Table; query: string }
  | { kind: 'case'; case: { when: BooleanValue; then: Value }[]; else?: Value | null };
export type Sort = { value: Value; dir: 'asc' | 'desc' };
export type DataSource =
  | { kind: 'table'; table: Table }
  | { kind: 'aliased'; table: Table; as: string }
  | { kind: 'subquery'; subquery: SelectOrSet; as: string };
export type Join = { source: DataSource; type: 'inner' | 'left' | 'right' | 'full'; on: BooleanValue[] };
export type AliasValue = { alias: Alias; value: Value };
export type ColumnValue = { column: Column; value: Value };
export type Select = {
  kind: 'select';
  distinct?: boolean | null;
  values: AliasValue[];
  from?: DataSource | null;
  joins?: Join[] | null;
  where?: BooleanValue[] | null;
  groupBy?: Value[] | null;
  having?: BooleanValue[] | null;
  orderBy?: Sort[] | null;
  offset?: number | null;
  limit?: number | null;
};
export type Insert = {
  kind: 'insert';
  table: Table;
  as?: string | null;
  columns: Column[];
  values?: Value[] | null;
  select?: SelectOrSet | null;
  returning?: AliasValue[] | null;
  onConflict?: { columns: Column[]; doNothing?: boolean | null; update?: ColumnValue[] | null } | null;
};
export type Update = {
  kind: 'update';
  set: ColumnValue[];
  table: Table;
  as?: string | null;
  from?: DataSource | null;
  joins?: Join[] | null;
  where?: BooleanValue[] | null;
  returning?: AliasValue[] | null;
};
export type Delete = {
  kind: 'delete';
  table: Table;
  as?: string | null;
  joins?: Join[] | null;
  where?: BooleanValue[] | null;
  returning?: AliasValue[] | null;
};
export type SetOperation = { kind: 'union' | 'intersect' | 'except'; left: Select; right: Select; all?: boolean | null };
export type Statement = Insert | Update | Select | Delete | SetOperation;
export type WithStatement =
  | { kind: 'cte'; name: string; statement: Statement }
  | { kind: 'cte-recursive'; name: string; statement: Select; recursiveStatement: Select };
export type CTEStatement = { kind: 'withs'; withs: WithStatement[]; final: Statement };
export type Query = Statement | CTEStatement;

// ============================================================================
// Descriptions (helpers/dba.ts:9-34, verbatim)
// ============================================================================

function generateFieldDescription(field: TypeField): string {
  const parts: string[] = [field.type];
  if (field.required) parts.push('required');
  if (field.enumOptions?.length) parts.push(`options:[${field.enumOptions.join(',')}]`);
  if (field.onDelete) parts.push(`onDelete:${field.onDelete}`);
  return `${field.friendlyName}: ${parts.join(' ')}`;
}
export function generateAllFieldDescriptions(type: TypeDefinition, context: 'select' | 'insert' | 'update'): string {
  const systemFields: string[] = [];
  if (context === 'select') systemFields.push('id: string required', 'created: number required', 'updated: number required');
  else if (context === 'insert') systemFields.push('id: string automatic', 'created: number automatic', 'updated: number automatic');
  else systemFields.push('id: string read-only', 'created: number read-only', 'updated: number read-only');
  return [...systemFields, ...type.fields.map(generateFieldDescription)].join('; ');
}

// ============================================================================
// The type-independent grammar (helpers/dba.ts:220-571), defined once
// ============================================================================

const ALIAS_DOC = 'Table alias - should only be specified when it needs be disambiguated from another source of the same name';

export const Grammar = a.define({
  // dba.ts:221-223
  Source: a.string().describe('Table name, alias, or CTE name'),
  Column: a.string().describe('Column name'),
  Alias: a.string().describe('Alias for a value in SELECT or RETURNING clause'),
  // dba.ts:240
  Constant: a.union([a.number(), a.string(), a.boolean(), a.null()]).describe('Constant value: number, string, boolean, or null'),
  // dba.ts:247-257
  Aggregate: a.enum(['count', 'min', 'max', 'avg', 'sum']).describe('Aggregate function'),
  Binary: a.enum(['+', '-', '*', '/']).describe('Binary operator'),
  Unary: a.enum(['-']).describe('Unary operator'),
  Comparison: a.enum(['=', '<', '>', '<=', '>=', '<>', 'like', 'notLike']).describe('Comparison operator'),
  Function: a.enum([
    'concat', 'substring', 'length', 'lower', 'upper', 'trim', 'replace',
    'abs', 'ceil', 'floor', 'round', 'power', 'sqrt',
    'now', 'current_date', 'date_add', 'date_sub', 'extract', 'date_trunc',
    'coalesce', 'nullif', 'greatest', 'least',
  ]).describe('Built-in SQL function'),
  // dba.ts:260
  Value: a.union([
    a.ref('SourceColumn'),
    a.ref('Constant'),
    a.ref('Select'),
    a.ref('BooleanValue'),
    a.ref('FunctionCall'),
    a.ref('WindowValue'),
    a.object({
      kind: a.literal('binary'),
      left: a.ref('Value').describe('Left operand'),
      op: a.ref('Binary').describe('Binary operator'),
      right: a.ref('Value').describe('Right operand'),
    }).describe('Binary operation'),
    a.object({
      kind: a.literal('unary'),
      unary: a.ref('Unary').describe('Unary operator'),
      value: a.ref('Value').describe('Operand value'),
    }).describe('Unary operation'),
    a.object({
      kind: a.literal('aggregate'),
      aggregate: a.ref('Aggregate').describe('Aggregate function'),
      value: a.union([a.ref('Value'), a.literal('*')]).describe('Value to aggregate'),
    }).describe('Aggregate operation'),
    a.object({
      kind: a.literal('semanticSimilarity'),
      table: a.ref('Table').describe('Table to compare against using semantic similarity'),
      query: a.string().describe('User query to compare for semantic similarity'),
    }).describe('Semantic similarity search'),
    a.object({
      kind: a.literal('case'),
      case: a.array(a.object({
        when: a.ref('BooleanValue').describe('Condition'),
        then: a.ref('Value').describe('Result value when condition is true'),
      })).describe('CASE branches'),
      else: a.ref('Value').nullable().optional().describe('Default value when no conditions match'),
    }).describe('CASE expression'),
  ]).describe('SQL value expression'),
  // dba.ts:298
  BooleanValue: a.union([
    a.object({ kind: a.literal('comparison'), left: a.ref('Value').describe('Left operand'), cmp: a.ref('Comparison').describe('Comparison operator'), right: a.ref('Value').describe('Right operand') }).describe('Comparison expression'),
    a.object({ kind: a.literal('in'), value: a.ref('Value').describe('Value to test'), in: a.union([a.array(a.ref('Value')), a.ref('SelectOrSet')]).describe('List of values or subquery') }).describe('IN predicate'),
    a.object({ kind: a.literal('between'), value: a.ref('Value').describe('Value to test'), between: a.tuple([a.ref('Value'), a.ref('Value')]).describe('Range bounds [min, max]') }).describe('BETWEEN predicate'),
    a.object({ kind: a.literal('isNull'), isNull: a.ref('Value').describe('Value to test for NULL. Should not be a constant, should be a column or expression.') }).describe('IS NULL predicate'),
    a.object({ kind: a.literal('exists'), exists: a.ref('SelectOrSet').describe('Subquery to test for existence') }).describe('EXISTS predicate'),
    a.object({ kind: a.literal('and'), and: a.array(a.ref('BooleanValue')).describe('Boolean expressions to AND together') }).describe('AND expression'),
    a.object({ kind: a.literal('or'), or: a.array(a.ref('BooleanValue')).describe('Boolean expressions to OR together') }).describe('OR expression'),
    a.object({ kind: a.literal('not'), not: a.ref('BooleanValue').describe('Boolean expression to negate') }).describe('NOT expression'),
  ]).describe('Boolean expression'),
  // dba.ts:337
  FunctionCall: a.object({
    kind: a.literal('function'),
    function: a.ref('Function').describe('Function name'),
    args: a.array(a.ref('Value')).describe('Function arguments'),
  }).describe('Function call'),
  // dba.ts:343
  Sort: a.object({ value: a.ref('Value').describe('Value to sort by'), dir: a.enum(['asc', 'desc']).describe('Sort direction') }).describe('Sort specification'),
  // dba.ts:348
  WindowValue: a.object({
    kind: a.literal('window'),
    function: a.union([a.ref('Aggregate'), a.string()]).describe('Window function name'),
    value: a.ref('Value').describe('Value to compute over'),
    partitionBy: a.array(a.ref('Value')).nullable().optional().describe('PARTITION BY expressions'),
    orderBy: a.array(a.ref('Sort')).nullable().optional().describe('ORDER BY specifications'),
  }).describe('Window function'),
  // dba.ts:356 / 361
  AliasValue: a.object({ alias: a.ref('Alias').describe('Alias name'), value: a.ref('Value').describe('Value expression') }).describe('Aliased value for SELECT or RETURNING'),
  ColumnValue: a.object({ column: a.ref('Column').describe('Column name'), value: a.ref('Value').describe('Value to assign') }).describe('Column assignment for INSERT or UPDATE'),
  // dba.ts:367
  SelectOrSet: a.union([a.ref('Select'), a.ref('SetOperation')]).describe('SELECT query or set operation'),
  // dba.ts:372
  DataSource: a.union([
    a.object({ kind: a.literal('table'), table: a.ref('Table').describe('Table name') }).describe('Table data source'),
    a.object({ kind: a.literal('aliased'), table: a.ref('Table').describe('Table name'), as: a.string().describe('Alias') }).describe('Table data source when an alias is required'),
    a.object({ kind: a.literal('subquery'), subquery: a.ref('SelectOrSet').describe('Subquery'), as: a.string().describe('Alias') }).describe('Subquery data source'),
  ]).describe('Data source for FROM clause'),
  // dba.ts:389
  Join: a.object({
    source: a.ref('DataSource').describe('Data source to join'),
    type: a.enum(['inner', 'left', 'right', 'full']).describe('Join type'),
    on: a.array(a.ref('BooleanValue')).describe('Join conditions (ANDed together)'),
  }).describe('JOIN specification'),
  // dba.ts:395
  Select: a.object({
    kind: a.literal('select'),
    distinct: a.boolean().nullable().optional().describe('Whether to return distinct rows, use false by default true if required to satisfy requirements'),
    values: a.array(a.ref('AliasValue')).describe('Values to select'),
    from: a.ref('DataSource').nullable().optional().describe('FROM data source'),
    joins: a.array(a.ref('Join')).nullable().optional().describe('JOIN clauses'),
    where: a.array(a.ref('BooleanValue')).nullable().optional().describe('WHERE conditions (ANDed together)'),
    groupBy: a.array(a.ref('Value')).nullable().optional().describe('GROUP BY expressions'),
    having: a.array(a.ref('BooleanValue')).nullable().optional().describe('HAVING conditions (ANDed together)'),
    orderBy: a.array(a.ref('Sort')).nullable().optional().describe('ORDER BY specifications'),
    offset: a.number().nullable().optional().describe('Number of rows to skip'),
    limit: a.number().nullable().optional().describe('Maximum number of rows to return'),
  }).describe('SELECT statement'),
  // dba.ts:533
  SetOperation: a.object({
    kind: a.enum(['union', 'intersect', 'except']).describe('Set operation type'),
    left: a.ref('Select').describe('Left SELECT query'),
    right: a.ref('Select').describe('Right SELECT query'),
    all: a.boolean().nullable().optional().describe('Whether to include duplicates (ALL)'),
  }).describe('Set operation (UNION, INTERSECT, EXCEPT)'),
  // dba.ts:540
  Statement: a.union([a.ref('Insert'), a.ref('Update'), a.ref('Select'), a.ref('Delete'), a.ref('SetOperation')]).describe('SQL statement'),
  // dba.ts:548
  WithStatement: a.union([
    a.object({ kind: a.literal('cte'), name: a.string().describe('CTE name'), statement: a.ref('Statement').describe('CTE statement') }).describe('Simple CTE'),
    a.object({
      kind: a.literal('cte-recursive'),
      name: a.string().describe('CTE name'),
      statement: a.ref('Select').describe('Initial SELECT for recursive CTE'),
      recursiveStatement: a.ref('Select').describe('Recursive SELECT'),
    }).describe('Recursive CTE'),
  ]).describe('WITH statement (CTE)'),
  // dba.ts:562
  CTEStatement: a.object({
    kind: a.literal('withs'),
    withs: a.array(a.ref('WithStatement')).describe('CTE definitions'),
    final: a.ref('Statement').describe('Final statement that uses the CTEs'),
  }).describe('Statement with CTEs'),
  // dba.ts:568
  Query: a.union([a.ref('Statement'), a.ref('CTEStatement')]).describe('Complete SQL query'),
}).declare<{ Table: Table; SourceColumn: SourceColumn; Insert: Insert; Update: Update; Delete: Delete }>();

// ============================================================================
// The type-dependent names (helpers/dba.ts:211-531)
// ============================================================================

/**
 * The dynamic schemas are built from runtime data (`types.map(...)`), so their
 * static types are loose and are cast to the declared code types. Casting to
 * `SchemaOf<AllowRefs<T>>` (what `dynamic` asks for) does NOT work here: see
 * the AllowRefs tuple gap below.
 */
type Dyn = {
  Table: SchemaOf<Table>;
  SourceColumn: SchemaOf<SourceColumn>;
  Insert: SchemaOf<Insert>;
  Update: SchemaOf<Update>;
  Delete: SchemaOf<Delete>;
};

/**
 * GAP (types): allowrefs-tuple — `AllowRefs<T>` maps a tuple to an array
 * (`[string, string]` → `string[]`), so a dynamic schema cast to
 * `SchemaOf<AllowRefs<Decl>>` resolves to the array type and `result` reports
 * "declared type does not match" (BooleanValue's `between: [Value, Value]`, dba.ts:76).
 */
type Pair = { p: [string, string] };
export const AllowRefsTuple = a.declare<{ P: Pair }>()
  .dynamic(() => ({ P: a.object({ p: a.tuple([a.string(), a.string()]) }) as SchemaOf<AllowRefs<Pair>> }))
  // @ts-expect-error GAP: allowrefs-tuple — remove once AllowRefs keeps tuples.
  .result('P');
const many = <T>(xs: AnySchema[], one: () => AnySchema): SchemaOf<T> =>
  (xs.length >= 2 ? a.union(xs as [AnySchema, ...AnySchema[]]) : xs[0] ?? one()) as SchemaOf<T>;

/** `createDBASchemas(types)`'s type-dependent schemas, by their `aid` names. */
export function typeDefs(types: TypeDefinition[]): Dyn {
  const tableNames = types.map((t) => t.name);
  const tableDescriptions = types.map((t) => `${t.friendlyName} (${t.name})` + (t.description ? `: ${t.description}` : '')).join('; ');
  // dba.ts:216
  const Table = tableNames.length > 0
    ? a.enum(tableNames as [string, ...string[]]).describe(`Database table. Tables: ${tableDescriptions}`)
    : a.string().describe('Database table name');
  // dba.ts:225
  const SourceColumn = a.union([
    ...types.map((t) => a.object({
      source: a.literal(t.name),
      column: a.enum(['id', 'created', 'updated', ...t.fields.map((f) => f.name), '*'] as [string, ...string[]])
        .describe(`Column from ${t.name} (${t.friendlyName}). Use '*' to select all columns. Fields: ${generateAllFieldDescriptions(t, 'select')}`),
    }).describe(`Reference to a column from ${t.friendlyName} table (${t.name})`)),
    a.object({
      source: a.ref('Source').describe('Alias or CTE name'),
      column: a.union([a.ref('Column'), a.literal('*')]).describe('Column name from the source, or "*" to select all columns'),
    }).describe('Reference to a column from a CTE, aliased table/subquery'),
  ] as unknown as [AnySchema, ...AnySchema[]]).describe('Reference to a column from a specific source. Use column: "*" to select all columns from that source.') as SchemaOf<SourceColumn>;

  const typesWithFields = types.filter((t) => t.fields.length > 0);
  const typedColumns = (t: TypeDefinition, context: 'insert' | 'update') => {
    const Col = a.enum(['id', 'created', 'updated', ...t.fields.map((f) => f.name)] as [string, ...string[]])
      .describe(`Column from ${t.name} (${t.friendlyName}). Fields: ${generateAllFieldDescriptions(t, context)}`);
    const ColVal = a.object({ column: Col.describe('Column name'), value: a.ref('Value').describe('Value to assign') })
      .describe(`Column assignment for ${t.name} (${t.friendlyName})`);
    return { Col, ColVal };
  };
  // dba.ts:413
  const typedInserts = typesWithFields.map((t) => {
    const { Col, ColVal } = typedColumns(t, 'insert');
    return a.object({
      kind: a.literal('insert'),
      table: a.literal(t.name).describe(`Insert into ${t.name} table`),
      as: a.string().nullable().optional().describe(ALIAS_DOC),
      columns: a.array(Col).describe(`Columns to insert into ${t.name}`),
      values: a.array(a.ref('Value')).nullable().optional().describe('Values to insert (mutually exclusive with select)'),
      select: a.ref('SelectOrSet').nullable().optional().describe('SELECT query for values (mutually exclusive with values)'),
      returning: a.array(a.ref('AliasValue')).nullable().optional().describe('RETURNING clause'),
      onConflict: a.object({
        columns: a.array(Col).describe('Conflict target columns'),
        doNothing: a.boolean().nullable().optional().describe('Whether to do nothing on conflict'),
        update: a.array(ColVal).nullable().optional().describe('Column updates on conflict'),
      }).nullable().optional().describe('ON CONFLICT clause'),
    }).describe(`INSERT statement for ${t.name}`);
  });
  // dba.ts:440
  const genericInsert = () => a.object({
    kind: a.literal('insert'),
    table: a.ref('Table').describe('Target table'),
    as: a.string().nullable().optional().describe(ALIAS_DOC),
    columns: a.array(a.ref('Column')).describe('Columns to insert into'),
    values: a.array(a.ref('Value')).nullable().optional().describe('Values to insert (mutually exclusive with select)'),
    select: a.ref('SelectOrSet').nullable().optional().describe('SELECT query for values (mutually exclusive with values)'),
    returning: a.array(a.ref('AliasValue')).nullable().optional().describe('RETURNING clause'),
    onConflict: a.object({
      columns: a.array(a.ref('Column')).describe('Conflict target columns'),
      doNothing: a.boolean().nullable().optional().describe('Whether to do nothing on conflict'),
      update: a.array(a.ref('ColumnValue')).nullable().optional().describe('Column updates on conflict'),
    }).nullable().optional().describe('ON CONFLICT clause'),
  }).describe('INSERT statement');
  // dba.ts:463
  const typedUpdates = typesWithFields.map((t) => {
    const { ColVal } = typedColumns(t, 'update');
    return a.object({
      kind: a.literal('update'),
      set: a.array(ColVal).describe(`Column assignments for ${t.name}`),
      table: a.literal(t.name).describe(`Update ${t.name} table`),
      as: a.string().nullable().optional().describe(ALIAS_DOC),
      from: a.ref('DataSource').nullable().optional().describe('FROM data source'),
      joins: a.array(a.ref('Join')).nullable().optional().describe('JOIN clauses'),
      where: a.array(a.ref('BooleanValue')).nullable().optional().describe('WHERE conditions (ANDed together)'),
      returning: a.array(a.ref('AliasValue')).nullable().optional().describe('RETURNING clause'),
    }).describe(`UPDATE statement for ${t.name}`);
  });
  // dba.ts:486
  const genericUpdate = () => a.object({
    kind: a.literal('update'),
    set: a.array(a.ref('ColumnValue')).describe('Column assignments'),
    table: a.ref('Table').describe('Target table'),
    as: a.string().nullable().optional().describe(ALIAS_DOC),
    from: a.ref('DataSource').nullable().optional().describe('FROM data source'),
    joins: a.array(a.ref('Join')).nullable().optional().describe('JOIN clauses'),
    where: a.array(a.ref('BooleanValue')).nullable().optional().describe('WHERE conditions (ANDed together)'),
    returning: a.array(a.ref('AliasValue')).nullable().optional().describe('RETURNING clause'),
  }).describe('UPDATE statement');
  // dba.ts:505 (every type, fields or not)
  const typedDeletes = types.map((t) => a.object({
    kind: a.literal('delete'),
    table: a.literal(t.name).describe(`Delete from ${t.name} table`),
    as: a.string().nullable().optional().describe(ALIAS_DOC),
    joins: a.array(a.ref('Join')).nullable().optional().describe('JOIN clauses'),
    where: a.array(a.ref('BooleanValue')).nullable().optional().describe('WHERE conditions (ANDed together)'),
    returning: a.array(a.ref('AliasValue')).nullable().optional().describe('RETURNING clause'),
  }).describe(`DELETE statement for ${t.name}`));
  // dba.ts:517
  const genericDelete = () => a.object({
    kind: a.literal('delete'),
    table: a.ref('Table').describe('Target table'),
    as: a.string().nullable().optional().describe(ALIAS_DOC),
    joins: a.array(a.ref('Join')).nullable().optional().describe('JOIN clauses'),
    where: a.array(a.ref('BooleanValue')).nullable().optional().describe('WHERE conditions (ANDed together)'),
    returning: a.array(a.ref('AliasValue')).nullable().optional().describe('RETURNING clause'),
  }).describe('DELETE statement');

  // dba.ts:456/498/527: a union of the typed forms (2+), the one typed form, or the generic one.
  return {
    Table: Table as SchemaOf<Table>,
    SourceColumn,
    Insert: many<Insert>(typedInserts, genericInsert).describe('INSERT statement'),
    Update: many<Update>(typedUpdates, genericUpdate).describe('UPDATE statement'),
    Delete: many<Delete>(typedDeletes, genericDelete).describe('DELETE statement'),
  };
}

/** Cached per types array (cletus replaces the array when the config changes). */
const byTypes = { key: (types: TypeDefinition[]) => types };

/** `createDBASchemas(types).QuerySchema` as one static bundle bound per types array. */
export const QuerySchema = Grammar.dynamic((types: TypeDefinition[]) => typeDefs(types), byTypes).result('Query');
expectTypeOf<a.infer<typeof QuerySchema>>().toEqualTypeOf<Query>();
expectTypeOf(QuerySchema.bind).parameters.toEqualTypeOf<[TypeDefinition[]]>();

// ============================================================================
// The `query` tool (tools/dba.ts:117) with the shouldUseStringSchema fallback
// ============================================================================

/** tools/dba.ts:10 */
export function shouldUseStringSchema(types: TypeDefinition[], maxQuerySchemaTypes: number): boolean {
  return types.length > maxQuerySchemaTypes;
}
/** tools/dba.ts:153 */
export const QUERY_STRING_DOC = 'A detailed description of the query to execute. Must be a comprehensive description of the query to perform (selects, inserts, updates, deletes, and ctes are supported - all major Postgres expressions). Must include which types are involved, any filter conditions, known record IDs if applicable, and the precise outcome desired. Be specific and details. Do not provide a SQL looking query - you do not have enough type information to do so. You can include SQL like logic at the end if its the best way to describe complex logic that is needed.';

/**
 * Over `maxQuerySchemaTypes` (default 5) types the model gets a string
 * description instead of the grammar: `query` is `Query | string` for the code.
 */
export const QueryToolArgs = Grammar
  .declare<{ QueryArg: Query | string }>()
  .dynamic((ctx: CletusCtx) => {
    const data = ctx.config.getData();
    const asString = shouldUseStringSchema(data.types, data.user.maxQuerySchemaTypes ?? 5);
    return {
      ...typeDefs(asString ? [] : data.types),
      QueryArg: (asString
        ? a.string().describe(QUERY_STRING_DOC)
        : a.ref('Query').describe('The query to execute as a structured Query object')) as SchemaOf<Query | string>,
    };
  }, { key: (ctx) => ctx.config.getData() })
  .result(a.object({ query: a.ref('QueryArg') }));
expectTypeOf<a.infer<typeof QueryToolArgs>>().toEqualTypeOf<{ query: Query | string }>();
export const queryTool = tool({
  name: 'query',
  description: 'Execute complex SQL-like queries across data types',
  schema: QueryToolArgs,
  applicable: (ctx: CletusCtx) => ctx.config.getData().types.length > 0,
  call: (input) => (typeof input.query === 'string' ? `describe: ${input.query}` : input.query.kind),
});
expectTypeOf(queryTool.call).parameter(0).toEqualTypeOf<{ query: Query | string }>();

// ============================================================================
// Prompts answering with a query (operations/dba.tsx)
// ============================================================================

/** The (ctx, input) the dba prompts are given: the types the query may use. */
export type QueryPromptInput = { types: TypeDefinition[]; queryDescription?: string };

/** dba.tsx:607 query_fixer and dba.tsx:720 query_builder: `{ query: schemas.QuerySchema }`. */
export const QueryOutput = Grammar
  .dynamic((_ctx: Context<{}>, input: QueryPromptInput) => typeDefs(input.types), { key: (_ctx, input) => input.types })
  .result(a.object({ query: a.ref('Query') }));
expectTypeOf<a.infer<typeof QueryOutput>>().toEqualTypeOf<{ query: Query }>();
export const queryBuilder = prompt({
  name: 'query_builder',
  content: 'You are a database query builder. ...{{queryExamples}}',
  schema: QueryOutput,
});
export const queryFixer = prompt({ name: 'query_fixer', content: 'You are a database query fixer. ...', schema: QueryOutput });
expectTypeOf(queryFixer.schema!.bind).parameters.toEqualTypeOf<[Context<{}>, QueryPromptInput]>();
