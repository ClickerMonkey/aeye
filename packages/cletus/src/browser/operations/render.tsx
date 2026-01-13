import React from 'react';
import { Operation, OperationKind } from '../../schemas';
import { OperationDataFor } from '../../operations/types';
import { OperationDisplay, OperationDisplayProps } from '../components/OperationDisplay';


export type RendererDisplayProps = Pick<OperationDisplayProps, 
  'operation' | 
  'operationIndex' |
  'onApprove' |
  'onReject' |
  'approvalDecision' |
  'onToggleDecision' |
  'hasMultipleOperations' | 
  'isProcessing' | 
  'isLast'
>;

/**
 * Create a renderer for a specific operation kind
 * @param common 
 * @returns 
 */
export const createRenderer = (common: Partial<OperationDisplayProps> = {}) => {
  return <K extends OperationKind>(
    getLabel: (op: OperationDataFor<K>) => string, 
    getSummary?: (op: OperationDataFor<K>) => string | React.ReactNode | null,
    getProps?: (op: OperationDataFor<K>) => Partial<OperationDisplayProps>
  ) => {
    return (props: RendererDisplayProps) => {
      const operation = props.operation as any as OperationDataFor<K>;
      const label = getLabel(operation);
      const summary = operation.error || (getSummary ? getSummary(operation) : null) || operation.analysis;
      const additionalProps = getProps ? getProps(operation) : {};

      return (
        <OperationDisplay
          {...common}
          {...props}
          {...additionalProps}
          label={label}
          summary={summary}
        />
      );
    };
  }
};

export function linkFile(filepath: string, filename: string = filepath.match(/[\\/]([^\\/]+)$/)?.[1] || filepath) {
  return `[${filename}](${filepath})`;
}