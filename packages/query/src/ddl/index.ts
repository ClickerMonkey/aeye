/**
 * DDL barrel: table shapes, the DDL writers (one per dialect, reached as
 * `dialect.ddl`), and the bridge between tables and gin types.
 */
export {
  ColumnType,
  type ColumnTypeKind,
  ColumnDefault,
  ColumnSpec,
  ForeignKeySpec,
  UniqueSpec,
  TableSpec,
  sameColumnType,
  columnTypeWidens,
} from './table';
export {
  DdlAction,
  DdlStep,
  DdlError,
  type ColumnChange,
  type TableDiff,
  type DdlWriter,
  SqlDdl,
  AnsiDdl,
  readCommonType,
  splitNative,
  pkName,
  fkName,
  uqName,
  ckName,
} from './writer';
export { PostgresDdl, SqliteDdl, SqlServerDdl } from './dialects';
export { UUID_PATTERN, tableToGinType, ginTypeToTable, ginToColumnType, scalarType, type GinTableOptions } from './gin';
export { tableToQueryType, scalarFieldType, type QueryTypeOptions } from './query-type';
