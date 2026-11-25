import { a, type AnySchema, type SchemaOf } from '@aeye/schema';
import type { TypeDefinition, TypeField } from '../schemas';

/**
 * Generate a concise description for a field including all relevant metadata.
 */
function generateFieldDescription(field: TypeField): string {
  const parts: string[] = [field.type];

  if (field.required) parts.push('required');
  if (field.enumOptions?.length) parts.push(`options:[${field.enumOptions.join(',')}]`);
  if (field.onDelete) parts.push(`onDelete:${field.onDelete}`);

  return `${field.friendlyName}: ${parts.join(' ')}`;
}

/**
 * Generate field descriptions for a type, including system fields based on context.
 */
function generateAllFieldDescriptions(type: TypeDefinition, context: 'select' | 'insert' | 'update'): string {
  const systemFields: string[] = [];

  if (context === 'select') {
    systemFields.push('id: string required', 'created: number required', 'updated: number required');
  } else if (context === 'insert') {
    systemFields.push('id: string automatic', 'created: number automatic', 'updated: number automatic');
  } else if (context === 'update') {
    systemFields.push('id: string read-only', 'created: number read-only', 'updated: number read-only');
  }

  return [...systemFields, ...type.fields.map(generateFieldDescription)].join('; ');
}

/**
 * Generate a comprehensive description of a type including all its metadata.
 * Used for prompts that need full type information.
 */
export function describeType(type: TypeDefinition): string {
  const parts: string[] = [];
  
  parts.push(`Name: ${type.name}`);
  parts.push(`Friendly Name: ${type.friendlyName}`);
  
  if (type.description) {
    parts.push(`Description: ${type.description}`);
  }
  
  parts.push(`Fields: ${generateAllFieldDescriptions(type, 'select')}`);
  
  return parts.join(' | ');
}

/**
 * Generate comprehensive descriptions for all types.
 */
export function describeTypes(types: TypeDefinition[]): string {
  return types.map(describeType).join('\n');
}

export type Source = string; // table or alias or with statement name
export type Table = string; // table that can be read from
export type Column = string; // column name, used for insert/update (lvalues)
export type Alias = string; // alias for a value, used for select or returning
export type SourceColumn = { source: Source, column: Column | '*' }; // used for rvalues, '*' expands to all columns
export type Constant = number | string | boolean | null; // dates are represented as strings in yyyy-mm-dd format and dateTimes include millisecond precision. duration fields are stored as pg intervals
export type Aggregate = 'count' | 'min' | 'max' | 'avg' | 'sum';
export type Binary = '+' | '-' | '*' | '/';
export type Unary = '-';
export type Comparison = '=' | '<' | '>' | '<=' | '>=' | '<>' | 'like' | 'notLike'; // etc
export type SelectOrSet = Select | SetOperation;

export type BooleanValue =
  { kind: 'comparison', left: Value, cmp: Comparison, right: Value } |
  { kind: 'in', value: Value, in: Value[] | SelectOrSet } | // select should have exactly one value.
  { kind: 'between', value: Value, between: [Value, Value] } |
  { kind: 'isNull', isNull: Value } |
  { kind: 'exists', exists: SelectOrSet } | // select values should be [1] and a limit of 1 for efficiency
  { kind: 'and', and: BooleanValue[] } |
  { kind: 'or', or: BooleanValue[] } |
  { kind: 'not', not: BooleanValue };

export type Function = 
  'concat' | 'substring' | 'length' | 'lower' | 'upper' | 'trim' | 'replace' | // string
  'abs' | 'ceil'|'floor' | 'round' | 'power' | 'sqrt'| // number
  'now' | 'current_date' | 'date_add' | 'date_sub' | 'extract' | 'date_trunc' | // date
  'coalesce' | 'nullif' | 'greatest' | 'least'; // logic

export type FunctionCall = {
  kind: 'function';
  function: Function;
  args: Value[];
};

export type WindowValue = {
  kind: 'window';
  function: Aggregate | string;
  value: Value;
  partitionBy?: Value[] | null;
  orderBy?: Sort[] | null;
};

export type Value =
  SourceColumn |
  Constant |
  Select | // that has limit of 1 and one value, or one value thats an aggregate
  BooleanValue |
  FunctionCall |
  WindowValue |
  { kind: 'binary', left: Value, op: Binary, right: Value } | // +/*-
  { kind: 'unary', unary: Unary, value: Value } |
  { kind: 'aggregate', aggregate: Aggregate, value: Value | '*'} |
  { kind: 'semanticSimilarity', table: Table, query: string } | // special, returns a number between 1 and -1, 1 being most similar to the users question. expensive but if the user has a question that cant be perfectly represented as a query this can work well against an entire row of a table.
  { kind: 'case', case: { when: BooleanValue, then: Value }[], else?: Value | null }

export type Sort = { value: Value, dir: 'asc'|'desc' };

export type DataSource =  {
  kind: 'table';
  table: Table;
} | {
  kind: 'aliased';
  table: Table;
  as: string;
} | {
  kind: 'subquery';
  subquery: SelectOrSet;
  as: string;
}
export type Join = {
  source: DataSource;
  type: 'inner' | 'left' | 'right' | 'full'; // or cross
  on: BooleanValue[];
}
export type AliasValue = {
  alias: Alias;  
  value: Value;
}
export type ColumnValue = {
  column: Column;
  value: Value;
}
export type Select = {
  kind: 'select';
  distinct?: boolean | null; // distinct rows
  values: AliasValue[]; // values to select, alias is required
  from?: DataSource | null;
  joins?: Join[] | null;
  where?: BooleanValue[] | null; // anded together
  groupBy?: Value[] | null;
  having?: BooleanValue[] | null; // anded together
  orderBy?: Sort[] | null;
  offset?: number | null;
  limit?: number | null;
}
export type Insert = {
  kind: "insert";
  table: Table;
  as?: string | null; // alias for the table
  columns: Column[];
  values?: Value[] | null; // or select, not both
  select?: SelectOrSet | null;
  returning?: AliasValue[] | null;
  onConflict?: {
    columns: Column[];
    doNothing?: boolean | null;
    update?: ColumnValue[] | null;
  } | null;
};
export type Update = {
  kind: "update";
  set: ColumnValue[];
  table: Table;
  as?: string | null; // alias for the table
  from?: DataSource | null;
  joins?: Join[] | null;
  where?: BooleanValue[] | null; // anded together
  returning?: AliasValue[] | null;
};
export type Delete = {
  kind: "delete";
  table: Table;
  as?: string | null; // alias for the table
  joins?: Join[] | null;
  where?: BooleanValue[] | null; // anded together
  returning?: AliasValue[] | null;
};
export type SetOperation = {
  kind: 'union' | 'intersect' | 'except';
  left: Select;
  right: Select;
  all?: boolean | null;
};
export type Statement = Insert | Update | Select | Delete | SetOperation;
export type WithStatement = 
  { kind: 'cte', name: string; statement: Statement } | // select, insert, update, delete with returning
  { kind: 'cte-recursive', name: string; statement: Select; recursiveStatement: Select };
// for efficiency, when using with statements any following or the final statement should ideally only select from a previous "with" since the results of withs are not indexed joining on them is slow.
export type CTEStatement = {
  kind: "withs",
  withs: WithStatement[];
  final: Statement;
};

export type Query = Statement | CTEStatement;

/// ============================================================================
// Schemas: the query grammar, ONE static module. The type-independent grammar
// is defined once; the type-dependent names (Table, SourceColumn, Insert,
// Update, Delete) are declared with their code types and supplied per call
// from the type definitions (cached by their content).
// ============================================================================

/**
 * A key for caching schemas built from type definitions. The config edits its
 * types in place, so the key is their content, not the array.
 */
export function typesKey(types: ReadonlyArray<TypeDefinition>): string {
  return JSON.stringify(types);
}

const ALIAS_DOC = 'Table alias - should only be specified when it needs be disambiguated from another source of the same name';

/**
 * The query grammar's named types; Table, SourceColumn, Insert, Update and
 * Delete are supplied by `dbaTypeDefs(types)`.
 */
export const DBAGrammar = a.define({
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
type Dyn = {
  Table: SchemaOf<Table>;
  SourceColumn: SchemaOf<SourceColumn>;
  Insert: SchemaOf<Insert>;
  Update: SchemaOf<Update>;
  Delete: SchemaOf<Delete>;
};

const many = <T>(xs: AnySchema[], one: () => AnySchema): SchemaOf<T> =>
  (xs.length >= 2 ? a.union(xs as [AnySchema, ...AnySchema[]]) : xs[0] ?? one()) as SchemaOf<T>;

/**
 * The type-dependent named types of the query grammar for the given types.
 */
export function dbaTypeDefs(types: TypeDefinition[]): Dyn {
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

/**
 * The query grammar for a set of types, as one bundle bound per types
 * (cached by their content): `QuerySchema.bind(types)`.
 */
export const QuerySchema = DBAGrammar
  .dynamic((types: TypeDefinition[]) => dbaTypeDefs(types), { key: (types) => typesKey(types) })
  .result('Query');
