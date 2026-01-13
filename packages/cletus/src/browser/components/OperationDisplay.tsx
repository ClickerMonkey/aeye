import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Operation } from '../../schemas';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { MarkdownContent } from './Markdown';
import { is } from 'zod/v4/locales';


/**
 * Get status color and label for an operation status
 */
export function getStatusInfo(status: Operation['status']): { color: string; label: string } {
  switch (status) {
    case 'done':
      return { color: 'text-green-400', label: 'completed' };
    case 'doing':
      return { color: 'text-orange-400', label: 'in progress' };
    case 'analyzed':
      return { color: 'text-yellow-400', label: 'pending approval' };
    case 'doneError':
      return { color: 'text-red-400', label: 'error' };
    case 'analyzeError':
      return { color: 'text-red-400', label: 'analysis error' };
    case 'analyzedBlocked':
      return { color: 'text-red-400', label: 'blocked' };
    case 'rejected':
      return { color: 'text-red-400', label: 'rejected' };
    default:
      return { color: 'text-muted-foreground', label: status };
  }
}

/**
 * Calculate elapsed time for an operation
 */
export function getElapsedTime(op: Operation): string {
  if (!op.start) return '';
  const duration = op.end ? op.end - op.start : Date.now() - op.start;

  if (duration < 1000) return `${Math.round(duration)}ms`;
  if (duration < 60000) return `${(duration / 1000).toFixed(1)}s`;
  return `${Math.floor(duration / 60000)}m ${Math.round((duration % 60000) / 1000)}s`;
}

/**
 * Checks if an array can be rendered as a table
 */
const canRenderAsTable = (data: any[]): boolean => {
  if (data.length <= 1) return false;

  // All items must be objects
  if (!data.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
    return false;
  }

  // Collect all unique keys
  const allKeys = new Set<string>();
  for (const item of data) {
    Object.keys(item).forEach(key => allKeys.add(key));
  }

  // Must have <= 20 columns
  if (allKeys.size > 20) return false;

  // All values must be primitives (string, number, boolean, null, undefined)
  for (const item of data) {
    for (const value of Object.values(item)) {
      if (value !== null && value !== undefined && typeof value === 'object') {
        return false;
      }
    }
  }

  return true;
};

/**
 * Renders a primitive value for table cells
 */
const renderPrimitiveValue = (value: any): React.ReactNode => {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic">null</span>;
  }
  if (typeof value === 'string') {
    // Handle newlines in strings for table cells
    const lines = value.split('\n');
    return (
      <span className="text-green-400">
        {lines.map((line, i) => (
          <React.Fragment key={i}>
            {line}
            {i < lines.length - 1 && <br />}
          </React.Fragment>
        ))}
      </span>
    );
  }
  if (typeof value === 'number') {
    return <span className="text-blue-400">{value}</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="text-purple-400">{value.toString()}</span>;
  }
  return <span>{String(value)}</span>;
};

/**
 * Renders JSON data in a friendly HTML format
 */
const renderJsonAsHtml = (data: any, depth: number = 0): React.ReactNode => {
  if (data === null || data === undefined) {
    return <span className="text-muted-foreground italic">null</span>;
  }

  if (typeof data === 'string') {
    // Split by newlines and render each line
    const lines = data.split('\n');
    return (
      <span className="text-green-400">
        {lines.map((line, i) => (
          <React.Fragment key={i}>
            {line}
            {i < lines.length - 1 && <br />}
          </React.Fragment>
        ))}
      </span>
    );
  }

  if (typeof data === 'number') {
    return <span className="text-blue-400">{data}</span>;
  }

  if (typeof data === 'boolean') {
    return <span className="text-purple-400">{data.toString()}</span>;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <span className="text-muted-foreground">[]</span>;
    }

    // Check if we can render as a table
    if (canRenderAsTable(data)) {
      // Collect all unique keys across all objects
      const allKeys = new Set<string>();
      data.forEach(item => {
        Object.keys(item).forEach(key => allKeys.add(key));
      });
      const columns = Array.from(allKeys);

      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border">
                {columns.map(col => (
                  <th key={col} className="text-left p-2 text-cyan-400 font-semibold">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row, i) => (
                <tr key={i} className="border-b border-border/50">
                  {columns.map(col => (
                    <td key={col} className="p-2">
                      {renderPrimitiveValue(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    // Default array rendering
    return (
      <div className="ml-4">
        {data.map((item, i) => (
          <div key={i} className="border-l border-border pl-2 my-1">
            <span className="text-yellow-400">[{i}]:</span> {renderJsonAsHtml(item, depth + 1)}
          </div>
        ))}
      </div>
    );
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return <span className="text-muted-foreground">{'{}'}</span>;
    }
    return (
      <div className="ml-4">
        {entries.map(([key, value]) => (
          <div key={key} className="border-l border-border pl-2 my-1">
            <span className="text-cyan-400">{key}:</span> {renderJsonAsHtml(value, depth + 1)}
          </div>
        ))}
      </div>
    );
  }

  return <span>{String(data)}</span>;
};

/**
 * Expandable details component with tabs
 */
const OperationDetails: React.FC<{ operation: Operation }> = ({ operation }) => {
  const [activeTab, setActiveTab] = useState<'input' | 'output' | 'inputJson' | 'outputJson' | 'cacheJson' | 'analysis'>('input');
  const [isExpanded, setIsExpanded] = useState(false);

  const hasInput = operation.input !== undefined && operation.input !== null;
  const hasOutput = operation.output !== undefined && operation.output !== null;
  const hasCache = operation.cache !== undefined && operation.cache !== null && Object.keys(operation.cache).length > 0;
  const hasAnalysis = operation.analysis !== undefined && operation.analysis !== null && operation.analysis.trim().length > 0;

  if (!hasInput && !hasOutput && !hasCache && !hasAnalysis) {
    return null;
  }

  // Default to first available tab
  const effectiveTab =
    (activeTab === 'input' && hasInput) ||
    (activeTab === 'output' && hasOutput) ||
    (activeTab === 'inputJson' && hasInput) ||
    (activeTab === 'outputJson' && hasOutput) ||
    (activeTab === 'cacheJson' && hasCache) ||
    (activeTab === 'analysis' && hasAnalysis)
      ? activeTab
      : hasInput
      ? 'input'
      : hasOutput
      ? 'output'
      : hasCache
      ? 'cacheJson'
      : 'analysis';

  return (
    <div className="ml-6 mt-2 border border-border rounded-lg overflow-hidden bg-muted/30">
      {/* Tabs */}
      <div className="flex border-b border-border overflow-x-auto">
        {hasInput && (
          <button
            onClick={() => setActiveTab('input')}
            className={cn(
              'px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap',
              effectiveTab === 'input'
                ? 'bg-muted text-foreground border-b-2 border-neon-cyan'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            )}
          >
            Input
          </button>
        )}
        {hasOutput && (
          <button
            onClick={() => setActiveTab('output')}
            className={cn(
              'px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap',
              effectiveTab === 'output'
                ? 'bg-muted text-foreground border-b-2 border-neon-cyan'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            )}
          >
            Output
          </button>
        )}
        {hasInput && (
          <button
            onClick={() => setActiveTab('inputJson')}
            className={cn(
              'px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap',
              effectiveTab === 'inputJson'
                ? 'bg-muted text-foreground border-b-2 border-neon-cyan'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            )}
          >
            Input (JSON)
          </button>
        )}
        {hasOutput && (
          <button
            onClick={() => setActiveTab('outputJson')}
            className={cn(
              'px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap',
              effectiveTab === 'outputJson'
                ? 'bg-muted text-foreground border-b-2 border-neon-cyan'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            )}
          >
            Output (JSON)
          </button>
        )}
        {hasCache && (
          <button
            onClick={() => setActiveTab('cacheJson')}
            className={cn(
              'px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap',
              effectiveTab === 'cacheJson'
                ? 'bg-muted text-foreground border-b-2 border-neon-cyan'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            )}
          >
            Cache (JSON)
          </button>
        )}
        {hasAnalysis && (
          <button
            onClick={() => setActiveTab('analysis')}
            className={cn(
              'px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap',
              effectiveTab === 'analysis'
                ? 'bg-muted text-foreground border-b-2 border-neon-cyan'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            )}
          >
            Analysis
          </button>
        )}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="ml-auto px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground whitespace-nowrap"
        >
          {isExpanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      {/* Content */}
      {effectiveTab === 'input' || effectiveTab === 'output' ? (
        <div
          className={cn(
            'w-full p-3 text-xs font-mono bg-black text-white overflow-auto',
            isExpanded ? 'min-h-[12rem]' : 'max-h-[12rem] h-[12rem]'
          )}
        >
          {renderJsonAsHtml(effectiveTab === 'input' ? operation.input : operation.output)}
        </div>
      ) : (
        <textarea
          readOnly
          value={
            effectiveTab === 'inputJson'
              ? JSON.stringify(operation.input, null, 2)
              : effectiveTab === 'outputJson'
              ? JSON.stringify(operation.output, null, 2)
              : effectiveTab === 'cacheJson'
              ? JSON.stringify(operation.cache, null, 2)
              : operation.analysis || ''
          }
          className={cn(
            'w-full p-3 text-xs font-mono bg-black text-white border-0 resize-y overflow-auto',
            'focus:outline-none focus:ring-2 focus:ring-neon-cyan/50',
            isExpanded ? 'h-auto' : 'max-h-[12rem]'
          )}
          style={isExpanded ? { height: 'auto', minHeight: '12rem' } : { height: '12rem' }}
        />
      )}
    </div>
  );
};

export interface OperationDisplayProps {
  operation: Operation;
  label: string;
  summary?: React.ReactNode | string | null;
  summaryClasses?: string;
  borderColor?: string;
  bgColor?: string;
  labelColor?: string;
  message?: { cost?: number; usage?: any };
  operationIndex?: number;
  onApprove?: (index: number) => void;
  onReject?: (index: number) => void;
  approvalDecision?: 'approve' | 'reject';
  onToggleDecision?: (index: number, decision: 'approve' | 'reject') => void;
  hasMultipleOperations?: boolean;
  isProcessing?: boolean;
  isLast?: boolean;
}

/**
 * Base operation display component with consistent styling
 */
export const OperationDisplay: React.FC<OperationDisplayProps> = ({
  operation,
  label,
  summary,
  borderColor = 'border-border',
  summaryClasses = 'max-h-[8rem] overflow-y-auto',
  bgColor = 'bg-card/50',
  labelColor = 'text-foreground',
  message,
  operationIndex,
  onApprove,
  onReject,
  approvalDecision,
  onToggleDecision,
  hasMultipleOperations = false,
  isProcessing = false,
  isLast = false,
}) => {
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const { color: statusColor, label: statusLabel } = getStatusInfo(operation.status);
  const elapsed = getElapsedTime(operation);

  // Determine summary to display
  const displaySummary = operation.error ? operation.error : summary;

  const needsApproval = operation.status === 'analyzed' && !isProcessing && isLast;
  const isOperationProcessing = (operation.status === 'doing' || (!!operation.start && !operation.end)) && isLast;
  const showOptions = needsApproval || isOperationProcessing;

  return (
    <div className={cn('mb-3 rounded-lg p-3', needsApproval ? 'bg-yellow-500/5 border ' + borderColor : bgColor)}>
      {/* Header - Clickable */}
      <div
        className="flex items-center gap-2 mb-2 cursor-pointer hover:opacity-80 transition-opacity"
        onClick={() => setIsDetailsOpen(!isDetailsOpen)}
      >
        <span className={cn('text-lg', statusColor)}>●</span>
        <span className={cn('font-mono text-sm', labelColor)}>{label}</span>
        <span className="text-xs text-muted-foreground">[{statusLabel}]</span>
        {elapsed && <span className="text-xs text-muted-foreground">({elapsed})</span>}
      </div>

      {/* Summary */}
      {displaySummary && (
        <div className={cn('ml-6 text-sm mb-2 flex min-w-0', summaryClasses, operation.error ? 'text-red-400' : 'text-muted-foreground')}>
          {typeof displaySummary === 'string' ? (
            <>
              <span className="text-foreground flex-shrink-0">→&nbsp;</span>
              <div className="min-w-0 flex-1">
                <MarkdownContent
                  content={displaySummary}
                />
              </div>
            </>
          ) : (
            <div className="min-w-0 flex-1">
              {displaySummary}
            </div>
          )}
        </div>
      )}

      {/* Approval Buttons */}
      {showOptions && operationIndex !== undefined && (
        <div className="ml-6 mb-2">
          {!hasMultipleOperations && onApprove && onReject ? (
            // Single operation: immediate approve/reject
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onApprove(operationIndex)}
                disabled={isOperationProcessing}
                className="bg-green-500/10 text-green-400 border-green-400/30 hover:bg-green-400/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isOperationProcessing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                    Approve
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onReject(operationIndex)}
                disabled={isOperationProcessing}
                className="bg-red-500/10 text-red-400 border-red-400/30 hover:bg-red-400/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <XCircle className="w-4 h-4 mr-2" />
                Reject
              </Button>
            </div>
          ) : (
            // Multiple operations: toggle buttons
            onToggleDecision && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onToggleDecision(operationIndex, 'approve')}
                  disabled={isOperationProcessing}
                  className={cn(
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    approvalDecision === 'approve'
                      ? 'bg-green-500/20 text-green-400 border-green-400 hover:bg-green-500/30'
                      : 'text-green-400/50 border-green-400/30 hover:bg-green-400/10'
                  )}
                >
                  {isOperationProcessing && approvalDecision === 'approve' ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4 mr-2" />
                      Approve
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onToggleDecision(operationIndex, 'reject')}
                  disabled={isOperationProcessing}
                  className={cn(
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    approvalDecision === 'reject'
                      ? 'bg-red-500/20 text-red-400 border-red-400 hover:bg-red-500/30'
                      : 'text-red-400/50 border-red-400/30 hover:bg-red-400/10'
                  )}
                >
                  <XCircle className="w-4 h-4 mr-2" />
                  Reject
                </Button>
              </div>
            )
          )}
        </div>
      )}

      {/* Details */}
      {isDetailsOpen && (
        <>
          <OperationDetails operation={operation} />

          {/* Cost and Usage Info */}
          {message && (message.cost !== undefined || message.usage) && (
            <div className="ml-6 mt-2 text-xs text-muted-foreground">
              {message.cost !== undefined && message.cost > 0 && (
                <span>cost: ${message.cost.toFixed(5)}</span>
              )}
              {message.usage?.text && (
                <span>
                  {message.cost !== undefined && message.cost > 0 ? ' │ ' : ''}
                  tokens: {(message.usage.text.input || 0) + (message.usage.text.output || 0)}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
