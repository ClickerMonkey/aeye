/**
 * Mapping between @aeye chat shapes and the OpenAI Responses API.
 *
 * Output is mapped one item at a time into core `Chunk`s, so a complete
 * response is just its items' chunks folded together, and a stream reuses the
 * same mapping when each item finishes.
 */

import type { Chunk, HostedTool, Reasoning, ToolCall } from '@aeye/core';
import OpenAI from 'openai';
import { responsesUsage, toCitation, toModeration, toServiceTier } from './convert';
import { ProviderError } from './types';

/**
 * The `ReasoningDetail.format` reasoning items round-trip through. OpenRouter
 * uses the same name for OpenAI reasoning it relays.
 */
export const RESPONSES_REASONING_FORMAT = 'openai-responses-v1';

/**
 * Models served only by the Responses API.
 */
const RESPONSES_ONLY_MODELS = /codex|deep-research|computer-use|^o[13]-pro|^gpt-5(\.[1-5])?-pro/;

/**
 * A free-text tool call's input as tool call arguments: the text as `input`,
 * matching the tool's `{ input: string }` schema.
 */
export function textArguments(input: string): string {
  return JSON.stringify({ input });
}

/**
 * The text input of a free-text tool call, from its arguments.
 */
export function textInput(args: string): string {
  const parsed: { input?: string } = JSON.parse(args);
  return parsed.input ?? '';
}

/**
 * Whether a model can only be reached through the Responses API.
 */
export function isResponsesOnly(modelId: string): boolean {
  return RESPONSES_ONLY_MODELS.test(modelId);
}

/**
 * A Chat Completions content part as Responses input content. Responses
 * takes no audio input, so audio becomes a note in its place.
 */
export function toInputContent(part: OpenAI.Chat.ChatCompletionContentPart): OpenAI.Responses.ResponseInputContent {
  const prompt_cache_breakpoint = part.prompt_cache_breakpoint;
  switch (part.type) {
    case 'text':
      return { type: 'input_text', text: part.text, prompt_cache_breakpoint };
    case 'image_url':
      return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail ?? 'auto', prompt_cache_breakpoint };
    case 'file':
      return { type: 'input_file', file_data: part.file.file_data, file_id: part.file.file_id, filename: part.file.filename, prompt_cache_breakpoint };
    case 'input_audio':
      return { type: 'input_text', text: 'Audio input is not supported here and was left out.', prompt_cache_breakpoint };
  }
}

/**
 * Reasoning from an earlier assistant turn that came from the Responses API,
 * as input items. Encrypted content lets the model resume its reasoning
 * without the response being stored.
 */
export function toReasoningItems(reasoning: Reasoning | undefined): OpenAI.Responses.ResponseReasoningItem[] {
  return (reasoning?.details ?? []).flatMap((detail): OpenAI.Responses.ResponseReasoningItem[] =>
    detail.format === RESPONSES_REASONING_FORMAT && detail.id
      ? [{
          type: 'reasoning',
          id: detail.id,
          summary: detail.summary ? [{ type: 'summary_text', text: detail.summary }] : [],
          encrypted_content: detail.data,
        }]
      : []
  );
}

/**
 * A provider-run tool as a Responses tool.
 *
 * @param provider - Provider name for the error when a tool has no equivalent.
 */
export function toHostedTool(tool: HostedTool, provider: string): OpenAI.Responses.Tool {
  switch (tool.type) {
    case 'web_search':
      if (tool.blockedDomains?.length) {
        throw new ProviderError(provider, 'OpenAI web search can only allow domains, not block them');
      }
      return { type: 'web_search', filters: tool.allowedDomains && { allowed_domains: tool.allowedDomains } };
    case 'file_search':
      return { type: 'file_search', vector_store_ids: tool.vectorStoreIds, max_num_results: tool.maxResults };
    case 'code_interpreter':
      return { type: 'code_interpreter', container: { type: 'auto' } };
    case 'image_generation':
      return { type: 'image_generation' };
    case 'mcp':
      return { type: 'mcp', server_label: tool.label, server_url: tool.url, headers: tool.headers, allowed_tools: tool.allowedTools, require_approval: 'never' };
    case 'web_fetch':
      throw new ProviderError(provider, 'The web_fetch hosted tool is not available; web_search fetches pages itself');
  }
}

/**
 * Hosted tool calls, by the output item type that records them.
 */
const HOSTED_CALLS: Partial<Record<OpenAI.Responses.ResponseOutputItem['type'], HostedTool['type']>> = {
  web_search_call: 'web_search',
  file_search_call: 'file_search',
  code_interpreter_call: 'code_interpreter',
  image_generation_call: 'image_generation',
  mcp_call: 'mcp',
};

/**
 * What one output item contributes to the response.
 *
 * @param streamed - Whether text and reasoning already arrived as deltas, in
 *   which case only what deltas don't carry is included.
 */
export function outputItemChunk(item: OpenAI.Responses.ResponseOutputItem, streamed: boolean): Chunk {
  const hosted = HOSTED_CALLS[item.type];
  const chunk: Chunk = hosted ? { usage: { tools: { [hosted]: 1 } } } : {};

  switch (item.type) {
    case 'message': {
      const texts = item.content.flatMap(part => part.type === 'output_text' ? [part] : []);
      const citations = texts.flatMap(part => part.annotations.flatMap(note => note.type === 'url_citation' ? [toCitation(note)] : []));
      if (!streamed) {
        chunk.content = texts.map(part => part.text).join('');
        chunk.refusal = item.content.flatMap(part => part.type === 'refusal' ? [part.refusal] : []).join('') || undefined;
      }
      chunk.citations = citations.length ? citations : undefined;
      break;
    }
    case 'reasoning': {
      const summary = item.summary.map(part => part.text).join('\n\n') || undefined;
      chunk.reasoning = {
        content: streamed ? undefined : summary,
        details: [{ id: item.id, type: 'reasoning.encrypted', format: RESPONSES_REASONING_FORMAT, summary, data: item.encrypted_content ?? undefined }],
      };
      break;
    }
    case 'function_call':
      chunk.toolCall = { id: item.call_id, name: item.name, arguments: item.arguments };
      break;
    case 'custom_tool_call':
      chunk.toolCall = { id: item.call_id, name: item.name, arguments: textArguments(item.input) };
      break;
    case 'image_generation_call':
      chunk.images = item.result ? [{ b64_json: item.result, revisedPrompt: item.revised_prompt ?? undefined }] : undefined;
      break;
  }
  return chunk;
}

/**
 * What a finished response contributes beyond its items: why it stopped,
 * usage, tier, and moderation.
 */
export function responseEndChunk(response: OpenAI.Responses.Response): Chunk {
  const incomplete = response.incomplete_details?.reason;
  return {
    finishReason: response.output.some(item => item.type === 'function_call') ? 'tool_calls'
      : incomplete === 'max_output_tokens' ? 'length'
      : incomplete === 'content_filter' ? 'content_filter'
      : 'stop',
    usage: response.usage && responsesUsage(response.usage),
    serviceTier: toServiceTier(response.service_tier),
    moderation: response.moderation ? toModeration(response.moderation) : undefined,
  };
}

/**
 * Turns a Responses event stream into chunks: text, refusal, reasoning, and
 * tool arguments as deltas, everything else as each item finishes.
 *
 * @param provider - Provider name for errors the stream reports.
 */
export async function* responseChunks(events: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>, provider: string): AsyncGenerator<Chunk> {
  const calls = new Map<string, ToolCall>();
  // The raw text streamed so far for each free-text tool call
  const texts = new Map<string, string>();

  for await (const event of events) {
    switch (event.type) {
      case 'response.output_text.delta':
        yield { content: event.delta };
        break;
      case 'response.refusal.delta':
        yield { refusal: event.delta };
        break;
      case 'response.reasoning_summary_part.added':
        // Parts stream back to back; join them as the finished item does
        if (event.summary_index > 0) {
          yield { reasoning: { content: '\n\n' } };
        }
        break;
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta':
        yield { reasoning: { content: event.delta } };
        break;
      case 'response.output_item.added':
        if (event.item.type === 'function_call' || event.item.type === 'custom_tool_call') {
          const call = { id: event.item.call_id, name: event.item.name, arguments: '' };
          calls.set(event.item.id ?? event.item.call_id, call);
          yield { toolCallNamed: call };
        }
        break;
      case 'response.function_call_arguments.delta': {
        const call = calls.get(event.item_id);
        if (call) {
          call.arguments += event.delta;
          yield { toolCallArguments: call };
        }
        break;
      }
      case 'response.custom_tool_call_input.delta': {
        const call = calls.get(event.item_id);
        if (call) {
          const text = (texts.get(event.item_id) ?? '') + event.delta;
          texts.set(event.item_id, text);
          call.arguments = textArguments(text);
          yield { toolCallArguments: call };
        }
        break;
      }
      case 'response.output_item.done':
        yield outputItemChunk(event.item, true);
        break;
      case 'response.completed':
      case 'response.incomplete':
        yield responseEndChunk(event.response);
        break;
      case 'response.failed':
        throw new ProviderError(provider, event.response.error?.message ?? 'Response failed');
      case 'error':
        throw new ProviderError(provider, event.message);
    }
  }
}
