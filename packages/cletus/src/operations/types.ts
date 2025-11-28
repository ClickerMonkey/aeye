import React from "react";
import { CletusAI, CletusAIContext } from "../ai";
import { ChatMode, Operation, OperationKind } from "../schemas";

import { Plus } from "@aeye/core";
import * as architect from './architect';
import * as artist from './artist';
import * as clerk from './clerk';
import * as dba from './dba';
import * as internet from './internet';
import * as librarian from './librarian';
import * as planner from './planner';
import * as secretary from './secretary';
import { ConfigFile } from "../config";

/**
 * Operation mode. Similar to chat mode but includes 'local' for operations
 * that can be performed without any approval (e.g. local file operations).
 * 
 * AI operations always require at least 'none' mode.
 */
export type OperationMode = ChatMode | 'local';

/**
 * Analysis result from an operation.
 */
export type OperationAnalysis = {
  /**
   * Description of what the operation would do.
   */
  analysis: string;
  /**
   * Whether the operation can actually be performed (validation passed).
   */
  doable: boolean;
};

/**
 * Operation with typed input and output.
 */
export type OperationOf<TInput, TOutput> = Omit<Operation, 'input' | 'output'> & {
  input: TInput;
  output?: TOutput;
}

/**
 * Definition of an operation.
 *
 * @param TInput  Type of the operation input
 * @param TOutput Type of the operation output
 */
export type OperationDefinition<TInput, TOutput> = {
  /**
   * Operation mode required to perform this operation.
   */
  mode: OperationMode | ((input: Partial<TInput>, context: CletusAIContext) => OperationMode);

  /**
   * Human-readable status message for this operation (max 64 chars recommended).
   * Should be concise and helpful without excessive input details.
   */
  status?: (input: TInput) => string;

  /**
   * Analyze the operation input and return a description and doability status.
   * This is used when the current chat mode does not allow automatic execution.
   *
   * @param input - Operation input
   * @param context - Cletus core context
   * @returns Analysis result with description and doability
   */
  analyze: (input: TInput, context: CletusAIContext) => Promise<OperationAnalysis>;

  /**
   * Run the operation and return the output.
   *
   * @param input - Operation input
   * @param context - Cletus core context
   * @returns - Operation output
   */
  do: (input: TInput, context: CletusAIContext) => Promise<TOutput>;

  /**
   * Optional custom content formatter for operation messages sent to the LLM.
   * If provided, this will be used to format the operation message instead of the default formatting.
   * This allows operations to control how their input/output is represented in the LLM context.
   *
   * @param op - The operation to format
   * @returns - Formatted string content for the LLM
   */
  content?: (op: OperationOf<TInput, TOutput>) => string;

  /**
   * Optional custom renderer for displaying this operation in the UI.
   * If provided, this will be used instead of the default operation display.
   *
   * @param op - The operation to render
   * @param config - Configuration file
   * @param showInput - Whether to show detailed input
   * @param showOutput - Whether to show detailed output
   * @returns - React component to display
   */
  render?: (op: OperationOf<TInput, TOutput>, ai: CletusAI, showInput?: boolean, showOutput?: boolean) => React.ReactNode;

  /**
   * A signature passed into the chat-agent's prompt to identify this operation.
   */
  signature: string;

  /**
   * Optional instructions to be included with the operation result message.
   * These instructions provide context-specific guidance to the LLM when processing operation results.
   * For example, file_read might include instructions to respect spacing and formatting.
   */
  instructions?: string;
};

// Operation definition for a specific operation kind
export type OperationDefinitionFor<K extends OperationKind> = OperationDefinition<OperationInputFor<K>, OperationOutputFor<K>>;

// Helper to define an operation
export function operationOf<TInput, TOutput, TExtension extends object = {}>(def: OperationDefinition<TInput, TOutput> & TExtension): OperationDefinition<TInput, TOutput> {
  return def;
}

// All operations are listed here.
export const Operations = {
  ...planner,
  ...librarian,
  ...clerk,
  ...secretary,
  ...architect,
  ...dba,
  ...artist,
  ...internet,
} as const;

// Operation type for a specific operation kind
export type OperationFor<K extends OperationKind> = typeof Operations[K];

// Operation input and output types for a specific operation kind
export type OperationInputFor<K extends OperationKind> = OperationFor<K> extends { do: (input: infer I, context: infer C) => Promise<infer R> } ? I : never;

// Operation output type for a specific operation kind
export type OperationOutputFor<K extends OperationKind> = OperationFor<K> extends { do: (input: infer I, context: infer C) => Promise<infer R> } ? R : never;

// Operation input structure
export type OperationInput<K extends OperationKind> = {
  // The operation type.
  type: K;
  // The operation input.
  input: OperationInputFor<K>;
};
