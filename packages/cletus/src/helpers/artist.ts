import { EChartsOption } from 'echarts';
import { a } from '@aeye/schema';

// ============================================================================
// Chart Display Schemas
// ============================================================================

export const ChartDataPointSchema = a.object({
  name: a.string().describe('Name/label for the data point'),
  value: a.number().describe('Numeric value for the data point'),
});

export type ChartDataPoint = a.infer<typeof ChartDataPointSchema>;

/**
 * A chart group whose variantOptions are ECharts options per variant
 * (a record keyed by the group's variants; every key optional).
 */
function chartGroupSchema<const G extends string, const V extends readonly [string, ...string[]]>(group: G, variants: V, dataDescription: string) {
  return a.object({
    chartGroup: a.literal(group),
    title: a.string().optional().describe('Optional chart title'),
    data: a.array(ChartDataPointSchema).describe(dataDescription),
    variantOptions: a.record(a.enum(variants), a.record(a.unknown())).optional().describe('Optional variant-specific ECharts options'),
    defaultVariant: a.enum(variants).optional().describe('Default variant to display'),
  });
}

export const PartToWholeChartSchema = a.object({
  chartGroup: a.literal('partToWhole'),
  title: a.string().optional().describe('Optional chart title'),
  data: a.array(ChartDataPointSchema).describe('Array of data points showing parts of a whole'),
  variantOptions: a.object({
    pie: a.record(a.unknown()).optional(),
    donut: a.record(a.unknown()).optional(),
    treemap: a.record(a.unknown()).optional(),
    sunburst: a.record(a.unknown()).optional(),
  }).optional().describe('Optional variant-specific ECharts options'),
  defaultVariant: a.enum(['pie', 'donut', 'treemap', 'sunburst']).optional().describe('Default variant to display'),
});

export const CategoryComparisonChartSchema = chartGroupSchema('categoryComparison', ['bar', 'horizontalBar', 'pictorialBar'], 'Array of data points for category comparison');
export const TimeSeriesChartSchema = chartGroupSchema('timeSeries', ['line', 'area', 'step', 'smoothLine'], 'Array of time-series data points');
export const DistributionChartSchema = chartGroupSchema('distribution', ['histogram', 'boxplot'], 'Array of data points for distribution analysis');
export const CorrelationChartSchema = chartGroupSchema('correlation', ['scatter', 'effectScatter', 'heatmap'], 'Array of data points for correlation analysis');
export const RankingChartSchema = chartGroupSchema('ranking', ['orderedBar', 'horizontalOrderedBar'], 'Array of data points to rank');
export const HierarchicalChartSchema = chartGroupSchema('hierarchical', ['treemap', 'sunburst', 'tree'], 'Array of hierarchical data points');
export const FlowChartSchema = chartGroupSchema('flow', ['sankey', 'funnel'], 'Array of flow/funnel data points');
export const GeospatialChartSchema = chartGroupSchema('geospatial', ['map'], 'Array of geographic data points');
export const MultivariateComparisonChartSchema = chartGroupSchema('multivariateComparison', ['groupedBar', 'stackedBar', 'radar', 'parallel'], 'Array of data points for multivariate comparison');

// Union of all chart schemas, picked by `chartGroup`
export const ChartConfigSchema = a.discriminatedUnion('chartGroup', [
  PartToWholeChartSchema,
  CategoryComparisonChartSchema,
  TimeSeriesChartSchema,
  DistributionChartSchema,
  CorrelationChartSchema,
  RankingChartSchema,
  HierarchicalChartSchema,
  FlowChartSchema,
  GeospatialChartSchema,
  MultivariateComparisonChartSchema,
]);

export type ChartConfig = a.infer<typeof ChartConfigSchema>;


// ============================================================================
// Chart Display Types
// ============================================================================

export type ChartGroup = 
  | 'partToWhole'
  | 'categoryComparison'
  | 'timeSeries'
  | 'distribution'
  | 'correlation'
  | 'ranking'
  | 'hierarchical'
  | 'flow'
  | 'geospatial'
  | 'multivariateComparison';

export type ChartVariant = 
  // partToWhole
  | 'pie' | 'donut' | 'treemap' | 'sunburst'
  // categoryComparison
  | 'bar' | 'horizontalBar' | 'pictorialBar'
  // timeSeries
  | 'line' | 'area' | 'step' | 'smoothLine'
  // distribution
  | 'histogram' | 'boxplot'
  // correlation
  | 'scatter' | 'effectScatter' | 'heatmap'
  // ranking
  | 'orderedBar' | 'horizontalOrderedBar'
  // hierarchical (overlaps with partToWhole)
  | 'tree'
  // flow
  | 'sankey' | 'funnel'
  // geospatial
  | 'map'
  // multivariateComparison
  | 'groupedBar' | 'stackedBar' | 'radar' | 'parallel';

export const ChartGroupVariants: Record<ChartGroup, ChartVariant[]> = {
  partToWhole: ['pie', 'donut', 'treemap', 'sunburst'],
  categoryComparison: ['bar', 'horizontalBar', 'pictorialBar'],
  timeSeries: ['line', 'area', 'step', 'smoothLine'],
  distribution: ['histogram', 'boxplot'],
  correlation: ['scatter', 'effectScatter', 'heatmap'],
  ranking: ['orderedBar', 'horizontalOrderedBar'],
  hierarchical: ['treemap', 'sunburst', 'tree'],
  flow: ['sankey', 'funnel'],
  geospatial: ['map'], // Removed scatter to avoid duplication with correlation group
  multivariateComparison: ['groupedBar', 'stackedBar', 'radar', 'parallel'],
};

export type ChartDisplayInput = {
  chart: ChartConfig;
};

export type ChartDisplayOutput = {
  chartGroup: ChartGroup;
  availableVariants: ChartVariant[];
  currentVariant: ChartVariant;
  option: EChartsOption;
  data: ChartDataPoint[];
  variantOptions: Partial<Record<ChartVariant, Partial<EChartsOption>>>;
};