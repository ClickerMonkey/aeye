/**
 * Query transforms barrel — query→query rewrites that keep a query logically
 * equivalent while adapting it for reuse or inspection:
 *  - `autoPaginate` binds `limit` / `offset` to named bind params.
 *  - `drillDown` un-ravels an aggregate into the underlying-row query.
 */
export { autoPaginate, type AutoPaginateOptions } from './auto-paginate';
export {
  drillDown,
  drillDownInto,
  type DrillValue,
  type DrillParam,
  type DrillDownResult,
  type DrillDownSuccess,
  type DrillDownFailure,
  type DrillDownIntoSuccess,
} from './drill-down';
