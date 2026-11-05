/**
 * Mapping between @aeye chat shapes and the Bedrock Converse API.
 *
 * Output content blocks are mapped one at a time into core `Chunk`s, so a
 * complete response is just its blocks' chunks folded together, and a stream
 * reuses the same pieces as its deltas arrive.
 */

import { clampReasoningEffort } from '@aeye/ai';
import {
  type Chunk,
  type Citation,
  type FinishReason,
  type Message,
  type MessageContent,
  type Reason,
  type Reasoning,
  type ReasoningEffort,
  type ServiceTier,
  toBase64,
  toText,
  type ToolCall,
  type Usage,
} from '@aeye/core';
import {
  AudioFormat,
  type CachePointBlock,
  type CitationsDelta,
  type ContentBlock,
  type ConverseStreamOutput,
  DocumentFormat,
  ImageFormat,
  type InferenceConfiguration,
  type ServiceTier as BedrockServiceTier,
  type ServiceTierType,
  type S3Location,
  type SystemContentBlock,
  type TokenUsage,
  type ToolResultContentBlock,
  type ToolUseBlock,
  VideoFormat,
} from '@aws-sdk/client-bedrock-runtime';

/**
 * The `ReasoningDetail.format` of reasoning blocks from Converse, which
 * round-trip back to it in later turns.
 */
export const BEDROCK_REASONING_FORMAT = 'bedrock-converse-v1';

/**
 * The provider name, which marks the reasoning Bedrock produces so other
 * providers don't replay it.
 */
export const BEDROCK_PROVIDER = 'aws-bedrock';

/**
 * A JSON value as Converse takes tool schemas, tool inputs and model fields.
 */
export type Document = NonNullable<ToolUseBlock['input']>;

/**
 * Parse JSON text into a Converse document.
 */
export function toDocument(json: string): Document {
  return JSON.parse(json);
}

/**
 * The block that ends a cacheable prompt prefix.
 */
const CACHE_POINT: { cachePoint: CachePointBlock } = { cachePoint: { type: 'default' } };

// ============================================================================
// Request content
// ============================================================================

/**
 * Format names that differ from what Converse calls them, by MIME subtype or
 * file extension.
 */
const FORMAT_ALIASES: Record<string, string> = {
  jpg: 'jpeg',
  plain: 'txt',
  markdown: 'md',
  msword: 'doc',
  'vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'vnd.ms-excel': 'xls',
  'vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  quicktime: 'mov',
  '3gp': 'three_gp',
  '3gpp': 'three_gp',
  'x-matroska': 'mkv',
  'x-flv': 'flv',
  'x-ms-wmv': 'wmv',
  mpeg3: 'mp3',
  'x-wav': 'wav',
};

/**
 * The first candidate that names one of the formats Converse accepts.
 */
function pickFormat<T extends string>(formats: Record<string, T>, candidates: (string | undefined)[]): T | undefined {
  for (const candidate of candidates) {
    const name = candidate?.toLowerCase();
    const format = name && Object.values(formats).find(f => f === (FORMAT_ALIASES[name] ?? name));
    if (format) {
      return format;
    }
  }
  return undefined;
}

/**
 * The extension of a file name or path, if any.
 */
function extension(path: string | undefined): string | undefined {
  return path && /\.([a-z0-9]+)$/i.exec(path)?.[1];
}

/**
 * Media for a content block: an S3 object referenced in place, or the bytes,
 * with the names its format may go by.
 */
async function toMedia(part: MessageContent): Promise<{ source: { bytes: Uint8Array } | { s3Location: S3Location }; formats: (string | undefined)[] }> {
  const uri = part.content instanceof URL ? part.content.href : typeof part.content === 'string' ? part.content : undefined;
  if (uri?.startsWith('s3://')) {
    return { source: { s3Location: { uri } }, formats: [part.format, extension(part.name), extension(uri)] };
  }
  const [, mimeType, data = ''] = /^data:([^;]+);base64,(.*)$/s.exec(await toBase64(part.content, part.format)) ?? [];
  return { source: { bytes: Buffer.from(data, 'base64') }, formats: [part.format, mimeType?.split('/')[1], extension(part.name), extension(uri)] };
}

/**
 * A document name Converse accepts: letters, digits, single spaces, hyphens,
 * parentheses and square brackets.
 */
function documentName(name: string | undefined): string {
  return (name ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9\s\-()[\]]+/g, ' ').replace(/\s+/g, ' ').trim() || 'document';
}

/**
 * Convert one message part to Converse content blocks. Media Converse can't
 * take becomes a note in its place.
 */
async function toPartBlocks(part: MessageContent): Promise<ContentBlock[]> {
  if (part.type === 'text') {
    const text = await toText(part.content);
    return text.trim() ? [{ text }] : [];
  }
  const note = (why: string): ContentBlock[] => [{ text: `${part.type[0].toUpperCase()}${part.type.slice(1)} content ${why} was left out.` }];
  const media = await toMedia(part).catch(() => undefined);
  if (!media) {
    return note('that could not be read');
  }
  const { source, formats } = media;
  switch (part.type) {
    case 'image': {
      const format = pickFormat(ImageFormat, formats);
      return format ? [{ image: { format, source } }] : note('in an unsupported format');
    }
    case 'video': {
      const format = pickFormat(VideoFormat, formats);
      return format ? [{ video: { format, source } }] : note('in an unsupported format');
    }
    case 'audio': {
      const format = pickFormat(AudioFormat, formats);
      return format ? [{ audio: { format, source } }] : note('in an unsupported format');
    }
    case 'file': {
      const format = pickFormat(DocumentFormat, formats);
      return format ? [{ document: { format, name: documentName(part.name), source } }] : note('in an unsupported format');
    }
  }
}

/**
 * Convert message content to Converse content blocks, with a cache point
 * after each part marked as a cache breakpoint.
 */
export async function toContentBlocks(content: string | MessageContent[]): Promise<ContentBlock[]> {
  if (typeof content === 'string') {
    return content.trim() ? [{ text: content }] : [];
  }
  const blocks = await Promise.all(content.map(async part => [
    ...await toPartBlocks(part),
    ...(part.cacheBreakpoint ? [CACHE_POINT] : []),
  ]));
  return blocks.flat();
}

/**
 * Convert system messages to Converse system blocks: their text and cache
 * points.
 */
export async function toSystemBlocks(messages: Message[]): Promise<SystemContentBlock[] | undefined> {
  const blocks = await Promise.all(messages.filter(m => m.role === 'system').map(m => toContentBlocks(m.content)));
  const system = blocks.flat().flatMap((block): SystemContentBlock[] =>
    block.text !== undefined ? [{ text: block.text }] : block.cachePoint ? [{ cachePoint: block.cachePoint }] : []
  );
  return system.length ? system : undefined;
}

/**
 * A tool message as a Converse tool result, which can carry text, images,
 * documents and video, followed by a cache point when one was asked for.
 */
export async function toToolResultBlocks(message: Message): Promise<ContentBlock[]> {
  const blocks = await toContentBlocks(message.content);
  const content = blocks.flatMap((block): ToolResultContentBlock[] =>
    block.text !== undefined ? [{ text: block.text }]
    : block.image ? [{ image: block.image }]
    : block.document ? [{ document: block.document }]
    : block.video ? [{ video: block.video }]
    : []
  );
  return [
    { toolResult: { toolUseId: message.toolCallId, content: content.length ? content : [{ text: '' }] } },
    ...(blocks.some(block => block.cachePoint) ? [CACHE_POINT] : []),
  ];
}

/**
 * An assistant message as Converse blocks: its reasoning first (unless it was
 * already replayed for an earlier part of the same turn), then its text, then
 * its tool calls.
 */
export async function toAssistantBlocks(message: Message, replayed: Set<Reasoning>): Promise<ContentBlock[]> {
  const reasoning = message.reasoning && !replayed.has(message.reasoning) ? message.reasoning : undefined;
  if (reasoning) {
    replayed.add(reasoning);
  }
  const text = (await toContentBlocks(message.content)).filter(block => block.text !== undefined || block.cachePoint);
  const calls = (message.toolCalls ?? []).map((tc): ContentBlock => ({
    toolUse: { toolUseId: tc.id, name: tc.name, input: toToolInput(tc.arguments) },
  }));
  return [...toReasoningBlocks(reasoning), ...text, ...calls];
}

/**
 * Tool call arguments as a tool input, kept as raw text when they aren't JSON.
 */
function toToolInput(args: string): Document {
  try {
    return toDocument(args || '{}');
  } catch {
    return { _raw: args };
  }
}

/**
 * Reasoning from an earlier Converse response as reasoning blocks, which
 * Claude needs back unmodified, signature and all, while it uses tools.
 * Unsigned text can't be verified, so it isn't replayed.
 */
export function toReasoningBlocks(reasoning: Reasoning | undefined): ContentBlock[] {
  return (reasoning?.details ?? []).flatMap((detail): ContentBlock[] =>
    detail.format !== BEDROCK_REASONING_FORMAT ? []
    : detail.data ? [{ reasoningContent: { redactedContent: fromBase64(detail.data) } }]
    : detail.signature ? [{ reasoningContent: { reasoningText: { text: detail.text ?? '', signature: detail.signature } } }]
    : []
  );
}

/**
 * Bytes from base64 that may be several encodings joined, as streamed redacted
 * reasoning accumulates: each piece decodes up to its padding, where a plain
 * decode would stop.
 */
function fromBase64(data: string): Buffer {
  return Buffer.concat(data.split(/(?<==)(?!=)/).map(piece => Buffer.from(piece, 'base64')));
}

/**
 * Blocks without their cache points, for models that reject them.
 */
export function withoutCachePoints<T extends { cachePoint?: CachePointBlock }>(blocks: T[] | undefined): T[] | undefined {
  return blocks?.filter(block => !block.cachePoint);
}

// ============================================================================
// Request settings
// ============================================================================

/**
 * Claude models that think adaptively, steered by effort rather than a
 * token budget: Claude 4.6 and later.
 */
const ADAPTIVE_CLAUDE = /claude-(?:[a-z]+-)?(?:4-[6-9]|[5-9])/;

/**
 * Efforts Claude accepts with adaptive thinking.
 */
const CLAUDE_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Claude 4.6, which rejects `xhigh` (added with Opus 4.7).
 */
const CLAUDE_4_6 = /claude-[a-z]+-4-6/;

/**
 * Efforts Nova accepts.
 */
const NOVA_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high'];

/**
 * Thinking budgets for Claude models that take one, by effort.
 */
const THINKING_BUDGETS: Record<ReasoningEffort, number> = {
  none: 0,
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536,
};

/**
 * Sampling settings, cleared for reasoning that rejects them.
 */
const NO_SAMPLING: InferenceConfiguration = { temperature: undefined, topP: undefined };

/**
 * How a request's reasoning is sent, which differs by model family.
 */
export interface ReasoningRequest {
  /** Model-specific fields, sent as `additionalModelRequestFields` */
  fields?: Record<string, Document>;
  /** Converse's own effort setting, which Claude reads */
  effort?: string;
  /** Inference settings the reasoning can't run with, cleared */
  cleared?: InferenceConfiguration;
}

/**
 * Map `Request.reason` to Converse for the model:
 *
 * - Claude 4.6+ thinks adaptively, with `effort` and a summarized display
 *   (omitted with `exclude`); older Claude takes a thinking token budget,
 *   from `maxTokens` or the effort, kept under the output limit. Claude
 *   can't think on a turn that forces a tool, so that turn goes without.
 * - Nova takes `reasoningConfig`; its high effort rejects sampling and
 *   output limits.
 * - Other models with efforts (gpt-oss and open-weight models) take an
 *   OpenAI-style `reasoning_effort`.
 *
 * @param modelId - The model id, with or without an inference profile prefix.
 * @param reason - The reasoning asked for.
 * @param accepted - The efforts the model accepts, when known.
 * @param maxTokens - The output limit, which a thinking budget must stay under.
 * @param forcedTool - Whether the tool choice forces a tool call.
 */
export function toReasoningRequest(modelId: string, reason: Reason | undefined, accepted: ReasoningEffort[] | undefined, maxTokens: number | undefined, forcedTool: boolean): ReasoningRequest {
  if (!reason) {
    return {};
  }
  const off = reason.effort === 'none';
  if (modelId.includes('anthropic.claude')) {
    if (off || forcedTool) {
      return { fields: { thinking: { type: 'disabled' } } };
    }
    if (ADAPTIVE_CLAUDE.test(modelId)) {
      return {
        fields: { thinking: { type: 'adaptive', display: reason.exclude ? 'omitted' : 'summarized' } },
        effort: reason.effort && clampReasoningEffort(reason.effort, accepted ?? CLAUDE_EFFORTS.filter(e => e !== 'xhigh' || !CLAUDE_4_6.test(modelId))),
        cleared: NO_SAMPLING,
      };
    }
    const budget = reason.maxTokens ?? THINKING_BUDGETS[reason.effort ?? 'medium'];
    return {
      fields: { thinking: { type: 'enabled', budget_tokens: maxTokens ? Math.min(budget, maxTokens - 1) : budget } },
      cleared: NO_SAMPLING,
    };
  }
  if (modelId.includes('amazon.nova')) {
    if (off) {
      return { fields: { reasoningConfig: { type: 'disabled' } } };
    }
    const effort = clampReasoningEffort(reason.effort ?? 'medium', accepted ?? NOVA_EFFORTS);
    return {
      fields: { reasoningConfig: { type: 'enabled', maxReasoningEffort: effort } },
      cleared: effort === 'high' ? { ...NO_SAMPLING, maxTokens: undefined } : undefined,
    };
  }
  const openWeight = accepted?.length || modelId.includes('openai.');
  return reason.effort && openWeight
    ? { fields: { reasoning_effort: clampReasoningEffort(reason.effort, accepted) } }
    : {};
}

/**
 * Library service tiers and the Converse tiers they map to.
 */
const SERVICE_TIERS: [ServiceTier, ServiceTierType][] = [
  ['default', 'default'],
  ['flex', 'flex'],
  ['fast', 'priority'],
  ['scale', 'reserved'],
];

/**
 * The Converse service tier for a request's tier; `auto` leaves it to Bedrock.
 */
export function toBedrockServiceTier(tier: ServiceTier | undefined): BedrockServiceTier | undefined {
  const type = SERVICE_TIERS.find(([ours]) => ours === tier)?.[1];
  return type && { type };
}

// ============================================================================
// Response
// ============================================================================

/**
 * Map a Converse stop reason. A guardrail stepping in counts as a content
 * filter; malformed output ends the response like a normal stop.
 */
export function toFinishReason(stopReason: string | undefined): FinishReason {
  switch (stopReason) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'content_filtered':
    case 'guardrail_intervened':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/**
 * Converse token usage, where input tokens exclude those read from or
 * written to the prompt cache.
 */
export function toUsage(usage: TokenUsage | undefined): Usage | undefined {
  return usage && {
    text: {
      input: usage.inputTokens,
      output: usage.outputTokens,
      cached: usage.cacheReadInputTokens || undefined,
      cacheWrite: usage.cacheWriteInputTokens || undefined,
    },
  };
}

/**
 * What the end of a response contributes: why it stopped, usage, and the tier
 * it ran on.
 */
export function endChunk(stopReason: string | undefined, usage: TokenUsage | undefined, tier: BedrockServiceTier | undefined): Chunk {
  return {
    finishReason: stopReason ? toFinishReason(stopReason) : undefined,
    usage: toUsage(usage),
    serviceTier: SERVICE_TIERS.find(([, theirs]) => theirs === tier?.type)?.[0],
  };
}

/**
 * Reasoning from a reasoning block or delta at a content index. Text and its
 * signature share a detail, and redacted reasoning keeps its bytes as base64,
 * so the blocks can be replayed.
 */
export function toReasoning(part: { text?: string; signature?: string; redactedContent?: Uint8Array }, index: number): Reasoning {
  const data = part.redactedContent && Buffer.from(part.redactedContent).toString('base64');
  return {
    content: part.text,
    provider: BEDROCK_PROVIDER,
    details: [{
      type: data ? 'reasoning.encrypted' : 'reasoning.text',
      format: BEDROCK_REASONING_FORMAT,
      index,
      text: part.text,
      signature: part.signature,
      data,
    }],
  };
}

/**
 * Web sources among Converse citations.
 */
export function toCitations(citations: CitationsDelta[] | undefined): Citation[] | undefined {
  const web = (citations ?? []).flatMap((c): Citation[] =>
    c.location?.web?.url ? [{ url: c.location.web.url, title: c.title ?? c.location.web.domain }] : []
  );
  return web.length ? web : undefined;
}

/**
 * What one output content block contributes to the response. Tools Bedrock
 * runs itself (server tool use and its results) aren't the caller's to run.
 */
export function contentBlockChunk(block: ContentBlock, index: number): Chunk {
  if (block.text !== undefined) {
    return { content: block.text };
  }
  if (block.toolUse && block.toolUse.type !== 'server_tool_use') {
    const { toolUseId = '', name = '', input } = block.toolUse;
    return { toolCall: { id: toolUseId, name, arguments: JSON.stringify(input ?? {}) } };
  }
  if (block.reasoningContent) {
    const { reasoningText, redactedContent } = block.reasoningContent;
    return { reasoning: toReasoning({ ...reasoningText, redactedContent }, index) };
  }
  if (block.citationsContent) {
    return {
      content: (block.citationsContent.content ?? []).map(part => part.text ?? '').join(''),
      citations: toCitations(block.citationsContent.citations),
    };
  }
  return {};
}

/**
 * What one ConverseStream event contributes: text, reasoning, citations and
 * tool arguments as deltas, a tool call once its block stops, and the end of
 * the response. Errors the stream reports are thrown.
 *
 * @param calls - Tool calls in progress by content block index, updated here.
 */
export function streamChunk(event: ConverseStreamOutput, calls: Map<number, ToolCall>): Chunk | undefined {
  const failure = event.internalServerException ?? event.modelStreamErrorException ?? event.validationException
    ?? event.throttlingException ?? event.serviceUnavailableException;
  if (failure) {
    throw failure;
  }
  if (event.contentBlockStart) {
    const { start, contentBlockIndex = 0 } = event.contentBlockStart;
    const tool = start?.toolUse;
    if (!tool || tool.type === 'server_tool_use') {
      return undefined;
    }
    const call = { id: tool.toolUseId ?? '', name: tool.name ?? '', arguments: '' };
    calls.set(contentBlockIndex, call);
    return { toolCallNamed: { ...call } };
  }
  if (event.contentBlockDelta) {
    const { delta, contentBlockIndex = 0 } = event.contentBlockDelta;
    const call = calls.get(contentBlockIndex);
    if (delta?.text !== undefined) {
      return { content: delta.text };
    }
    if (delta?.toolUse && call) {
      call.arguments += delta.toolUse.input ?? '';
      return { toolCallArguments: { ...call } };
    }
    if (delta?.reasoningContent) {
      return { reasoning: toReasoning(delta.reasoningContent, contentBlockIndex) };
    }
    if (delta?.citation) {
      return { citations: toCitations([delta.citation]) };
    }
    return undefined;
  }
  if (event.contentBlockStop) {
    const index = event.contentBlockStop.contentBlockIndex ?? 0;
    const call = calls.get(index);
    calls.delete(index);
    return call && { toolCall: call };
  }
  if (event.messageStop) {
    return endChunk(event.messageStop.stopReason, undefined, undefined);
  }
  if (event.metadata) {
    return endChunk(undefined, event.metadata.usage, event.metadata.serviceTier);
  }
  return undefined;
}
