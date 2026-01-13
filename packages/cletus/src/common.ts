import fs from "fs";
import path from "path";
import { CONSTS } from "./constants";
import { Message, MessageContent, Operation } from "./schemas";
import { Message as AIMessage, MessageContent as AIMessageContent, Reasoning, ToolCall } from "@aeye/core";
import { detectMimeType } from "./helpers/files";
import { OperationDefinition, Operations } from "./operations/types";
import { OperationManager } from "./operations/manager";

// Re-export browser-safe functions from shared.ts
export {
  formatTime,
  formatSize,
  formatName,
  abbreviate,
  deleteUndefined,
  pluralize,
  cosineSimilarity,
  chunkArray,
  chunk,
  groupMap,
  group,
  gate,
  detectNewlineType,
  normalizeNewlines,
  convertNewlines,
  paginateText,
  deepMerge,
  isObject,
  type NewlineType,
} from './shared';

/**
 * Returns the appropriate label for the Alt/Option key based on the platform.
 *
 * @returns "Opt" on macOS, "Alt" on other platforms
 */
export function getAltKeyLabel(): string {
  return process.platform === 'darwin' ? 'Opt' : 'Alt';
}

/**
 * Format a value for text display (high-level representation without JSON escaping)
 * - Arrays: items on separate lines with hyphens
 * - Non-objects (primitives): String(x)
 * - Objects: bullet list with hyphens, property values without JSON escaping
 * 
 * @param value - value to format
 * @param alreadyIndented - whether content should be indented/hyphenated
 * @returns formatted string
 */
export function formatValue(value: any, alreadyIndented: boolean = false): string {
  // Handle null/undefined
  if (value === null) {
    return `null`;
  }
  if (value === undefined) {
    return `undefined`;
  }

  const hyphenPrefix = alreadyIndented ? '' : '- ';
  
  // Arrays: list items with hyphens
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `[]`;
    }
    return value.map((item, i) => `${hyphenPrefix}${formatValue(item, true).split('\n').join('\n  ')}`).join('\n');
  }
  
  // Non-objects (primitives): use String(x)
  if (typeof value !== 'object') {
    const x = String(value);
    return !alreadyIndented && x.includes('\n') ? `\n  ${x.split('\n').join('\n  ')}` : x;
  }
  
  // Objects: bullet list with hyphens
  const entries = Object.entries(value).filter(([_, val]) => val !== undefined);
  if (entries.length === 0) {
    return '{}';
  }
  
  return entries.map(([key, val]) => {
    const prefix = `${hyphenPrefix}${key}:`;
    if (typeof val === 'object' && val !== null) {
      return `${prefix}\n  ${formatValue(val).split('\n').join('\n  ')}`;
    } else {
      return `${prefix} ${formatValue(val).split('\n').join('\n  ')}`;
    }
  }).join('\n');
}

/**
 * Format a value for display based on format type.
 *
 * @param value - value to format
 * @param format - format type ('json' or 'yaml', defaults to 'yaml')
 * @param alreadyIndented - whether content should be indented/hyphenated (only for yaml)
 * @returns formatted string
 */
export function formatValueWithFormat(value: any, format: 'json' | 'yaml' = 'yaml', alreadyIndented: boolean = false): string {
  if (format === 'json') {
    return JSON.stringify(value, null, 2);
  }
  return formatValue(value, alreadyIndented);
}

/**
 * Converts a Message to a ChatMessage.
 * 
 * @param msg 
 * @returns 
 */
export async function convertMessage(msg: Message): Promise<AIMessage[]> {
  /**
   * Example flows from a single assistant message:
   *
   * messageContent = { text, reasoning, op1-auto, op2-approved, op3-rejected, op4-pending, reasoning, text }
   *
   * Assistant: text
   * Assistant: toolCalls (ops input), reasoning
   * Tool: op1 output & instructions
   * Assistant: "Approve tools"
   * User: "Approves op2, Rejects op3"
   * Tool: op2 output & instructions
   * Tool: op3 analysis & rejected message
   * Tool: op4 analysis & pending approval message
   * Assistant: text, reasoning
   *
   * Rules:
   * - Assistant follows tools
   * - User follows assistant - approvals and rejections reference tool call Ids
   *
   * Non-assistant messages are simple - just convert content items directly like commented out below.
   */

  // For non-assistant messages, convert content directly
  if (msg.role !== 'assistant') {
    const content = await Promise.all(
      msg.content.map(mc => convertMessageContent(mc, msg.created))
    );
    return [{
      role: msg.role,
      name: msg.name,
      tokens: msg.tokens,
      content,
    }];
  }

  /** Algorithm: 
   * Iterate through message content
   * - If we hit reasoning, remember it
   * - If we hit a non-operation message, send it and any reasoning collected so far (and clear it out)
   * - If we hit an operation message, collect the next few contents that all have an operation index defined.
   *  - Create a toolCalls message with all operation inputs and any reasoning collected so far (and clear it out)
   *  - For each operation message:
   *    - If auto-executed (no analysis), output operation.output/error & operation.instructions if defined as tool result
   *    - If has analysis output operation.analysis. Add operation to list
   *  - If any operations needed approval, insert approval flow messages:
   *    - Assistant message asking for approval. Look at next 2 content after operation contents. It might be text content or reasoning followed by text. If not there just add a default message.
   *    - User message with approvals/rejections. Use the tool call IDs explicitly when listing `Approved: ${approvedIds}` and `Rejected: ${rejectedIds}`
   *    - For each approved/rejected/pending operation, output their respective content as tool results. Same logic as no-analysis operations
   * If we hit the end with any pending reasoning, add the message with empty content
   */

  // For assistant messages, reconstruct the conversation flow
  const messages: AIMessage[] = [];
  let currentReasoning: Reasoning | undefined = undefined;

  let i = 0;
  while (i < msg.content.length) {
    const messageContent = msg.content[i];

    // If we hit reasoning, remember it
    if (messageContent.type === 'reasoning') {
      currentReasoning = messageContent.reasoning;
      i++;
      continue;
    }

    // If we hit an operation message, collect all consecutive operation contents
    if (messageContent.operationIndex !== undefined) {
      const operationIndices: number[] = [];

      // Collect all consecutive operation contents
      while (i < msg.content.length && msg.content[i].operationIndex !== undefined) {
        operationIndices.push(msg.content[i].operationIndex!);
        i++;
      }

      // Get the operations from msg.operations
      const operations = operationIndices.map(index => ({
        index, 
        operation: msg.operations?.[index]!,
        toolCallId: `${msg.created}-${index}-${msg.operations?.[index]!.type}`,
      }));

      // Create a toolCalls message with all operation inputs and any reasoning collected so far
      messages.push({
        role: 'assistant',
        name: msg.name,
        reasoning: currentReasoning,
        content: [],
        toolCalls: operations.map(({ toolCallId, operation }) => ({
          id: toolCallId,
          name: operation.type,
          arguments: JSON.stringify(operation.input),
        })),
      });
      currentReasoning = undefined;

      // Separate operations into auto-executed and needing approval
      const approvalOperations = operations.filter(({ operation }) => operation.analysis);

      // Add output/analysis for operations
      for (const { operation, toolCallId } of operations) {
        const content = OperationManager.getContent(operation, true);
        messages.push({
          role: 'tool',
          content,
          toolCallId,
        });
      }

      // METHOD #1
      /*
      // If any operations needed approval, insert approval flow messages
      if (approvalOperations.length > 0) {
        // Assistant message asking for approval
        // Look at next 2 content after operation contents - might be text or reasoning followed by text
        let approvalText = 'Please approve or reject the proposed operations.';

        if (i < msg.content.length) {
          const nextContent = msg.content[i];
          if (nextContent.type === 'reasoning') {
            currentReasoning = nextContent.reasoning;
            i++;
            if (i < msg.content.length && msg.content[i].type === 'text') {
              approvalText = msg.content[i].content;
              i++;
            }
          } else if (nextContent.type === 'text') {
            approvalText = nextContent.content;
            i++;
          }
        }

        messages.push({
          role: 'assistant',
          name: msg.name,
          content: approvalText,
          reasoning: currentReasoning,
        });
        currentReasoning = undefined;

        // Separate operations by status
        const approvedOps = operations.filter(({ operation }) => operation.status === 'done' || operation.status === 'doneError');
        const rejectedOps = operations.filter(({ operation }) => operation.status === 'rejected');
        
        // User message with approvals/rejections
        const approvedIds = approvedOps.map(({ toolCallId }) => toolCallId).join(', ');
        const rejectedIds = rejectedOps.map(({ toolCallId }) => toolCallId).join(', ');

        let userContent = '';
        if (approvedIds) {
          userContent += `Approved: ${approvedIds}`;
        }
        if (rejectedIds) {
          if (userContent) userContent += '\n';
          userContent += `Rejected: ${rejectedIds}`;
        }

        if (userContent) {
          messages.push({
            // name: ?
            role: 'user',
            content: userContent,
          });
        }

        // Output tool results for approved operations
        if (approvedOps.length > 0) {
          messages.push({
            role: 'assistant',
            name: msg.name,
            content: '',
            toolCalls: approvedOps.map(({ operation, toolCallId }) => ({
              id: toolCallId,
              name: operation.type,
              arguments: JSON.stringify(operation.input),
            })),
          });
          for (const { operation, toolCallId } of approvedOps) {
            const content = OperationManager.getContent(operation);
            messages.push({
              role: 'tool',
              content,
              toolCallId,
            });
          }
        }
      }
      */

      // METHOD #2
      // If any operations got approval/rejection, put them as one big user message
      if (approvalOperations.length > 0) {
        // Assistant message asking for approval
        // Look at next 2 content after operation contents - might be text or reasoning followed by text
        let approvalText = 'Please approve or reject the proposed operations.';

        if (i < msg.content.length) {
          const nextContent = msg.content[i];
          if (nextContent.type === 'reasoning') {
            currentReasoning = nextContent.reasoning;
            i++;
            if (i < msg.content.length && msg.content[i].type === 'text') {
              approvalText = msg.content[i].content;
              i++;
            }
          } else if (nextContent.type === 'text') {
            approvalText = nextContent.content;
            i++;
          }
        }

        messages.push({
          role: 'assistant',
          name: msg.name,
          content: approvalText,
          reasoning: currentReasoning,
        });
        currentReasoning = undefined;

        messages.push({
          role: 'user',
          content: approvalOperations.map(({ operation, toolCallId}) => ({
            type: 'text',
            content: operation.status === 'rejected' 
              ? `<rejected-operation id=${toolCallId} />`
              : `<approved-operation id=${toolCallId}>\n${OperationManager.getContent(operation)}\n</approved-operation>`,
          })),
        });
      }

      continue;
    }

    // Non-operation message: send it with any reasoning collected so far
    const content = await convertMessageContent(messageContent, msg.created);
    messages.push({
      role: msg.role,
      name: msg.name,
      tokens: msg.tokens,
      content: [content],
      reasoning: currentReasoning,
    });
    currentReasoning = undefined;
    i++;
  }

  // If we hit the end with any pending reasoning, add the message with empty content
  if (currentReasoning) {
    messages.push({
      role: msg.role,
      name: msg.name,
      tokens: msg.tokens,
      content: [],
      reasoning: currentReasoning,
    });
  }

  return messages;
}

/*
export const INPUT_START = '\n\n<input>\n';
export const INPUT_END = '\n</input>';
export const ANALYSIS_START = '\n\n<analysis>\n';
export const ANALYSIS_END = '\n</analysis>';
export const OUTPUT_START = '\n\n<output>\n';
export const OUTPUT_END = '\n</output>';
export const INSTRUCTIONS_START = '\n\n<instructions>\n';
export const INSTRUCTIONS_END = '\n</instructions>';
 */

export const INPUT_START = '';
export const INPUT_END = '';
export const ANALYSIS_START = 'Operation requires approval, this operation has NOT been performed yet. The analysis follows - you can ask for approval and talk about the results of the analysis but the user will approve the operation and respond back with the actual results.\n\nAnalysis:\n';
export const ANALYSIS_END = '';
export const OUTPUT_START = 'Operation completed successfully! The output follows and you can discuss the results.\n\nOutput:\n';
export const OUTPUT_END = '';
export const INSTRUCTIONS_START = '\n\n<instructions>\n';
export const INSTRUCTIONS_END = '\n</instructions>';
export const ERROR_START = 'Operation failed:';
export const ERROR_END = '';

/**
 * 
 * @param messageContent - The message content to convert
 * @param messageTimestamp - The timestamp of the message (for operation output storage)
 * @returns 
 */
async function convertMessageContent(messageContent: MessageContent, messageTimestamp: number): Promise<AIMessageContent> {
  const { type, content, operationIndex } = messageContent;
  
  // Handle text content
  if (type === 'text') {
    // Check if this is an operation message that needs truncation
    if (operationIndex !== undefined && content.length > CONSTS.OPERATION_MESSAGE_TRUNCATE_LIMIT) {
      // Generate the truncation message
      const contentTruncated = content.slice(0, CONSTS.OPERATION_MESSAGE_TRUNCATE_LIMIT - CONSTS.OPERATION_MESSAGE_TRUNCATE_BUFFER);
      const truncatedAt = contentTruncated.indexOf(INPUT_START) >= 0 && contentTruncated.indexOf(INPUT_END) === -1
        ? 'input'
        : contentTruncated.indexOf(ANALYSIS_START) >= 0 && contentTruncated.indexOf(ANALYSIS_END) === -1
          ? 'analysis'
            : contentTruncated.indexOf(OUTPUT_START) >= 0 && contentTruncated.indexOf(OUTPUT_END) === -1
              ? 'output'
              : contentTruncated.indexOf(INSTRUCTIONS_START) >= 0 && contentTruncated.indexOf(INSTRUCTIONS_END) === -1
                ? 'instructions'
                : '';
      const sections = [
        ...(content.includes(INPUT_START) ? ['input'] : []),
        ...(content.includes(ANALYSIS_START) ? ['analysis'] : []),
        ...(content.includes(OUTPUT_START) ? ['output'] : []),
        ...(content.includes(INSTRUCTIONS_START) ? ['instructions'] : []),
      ];
      const truncatedSections = sections.slice(sections.indexOf(truncatedAt));

      const truncatedLength = content.length - contentTruncated.length;
      let truncatedContent = contentTruncated;
      if (truncatedAt) {
        truncatedContent += `...\n</${truncatedAt}>`;
      }
      truncatedContent += `\n\nThe operation summary has had <${truncatedSections.join('>, <')}> truncated for length (${truncatedLength} characters not shown). To get the full summary call 'getOperationOutput(${messageTimestamp}, ${operationIndex})'`;

      return { type, content: truncatedContent };
    }
    
    return { type, content };
  }

  // Handle reasoning
  if (type === 'reasoning') {
    return { 
      type: 'text', 
      content: `<reasoning-history>${content}</reasoning-history>`
    };
  }
  
  // Handle image content
  if (content.startsWith('http://') || content.startsWith('https://')) {
    return { type, content: new URL(content) };
  }

  // Handle file content
  const file = unlinkFile(content);
  if (file) {
    const fileBuffer = await fs.promises.readFile(file.filepath);
    const fileBase64 = fileBuffer.toString("base64");
    const fileMimeType = await detectMimeType(file.filepath, file.filename);

    return { type, content: `data:${fileMimeType};base64,${fileBase64}` };
  }

  return { type, content };
}

/**
 * Converts a file link into a file filepath & filename.
 * 
 * @param link 
 * @returns 
 */
export function unlinkFile(link: string): { filename: string; filepath: string} | null {
  const [_, filename, filepath] = link.match(/^\[([^\]]+)\]\(([^)]+)\)$/) || [];
  return filename && filepath ? { filename, filepath } : null;
}

/**
 * Converts a filepath into a markdown-style file link.
 * 
 * @param filepath - The full path to the file.
 * @param filename - The name of the file to display (defaults to the base name of the filepath).
 * @returns 
 */
export function linkFile(filepath: string, filename: string = path.basename(filepath)): string {
  return `[${filename}](${fileProtocol(filepath)})`;
}

/**
 * Ensures a path is in file protocol format.
 * 
 * @param path 
 * @returns 
 */
export function fileProtocol(path: string): string {
  path = path.replace(/\\/g, '/');
  if (!path.startsWith('file:///')) {
    if (path.startsWith('/')) {
      path = `file://${path}`;
    } else {
      path = `file:///${path}`;
    }
  }
  return path;
}

