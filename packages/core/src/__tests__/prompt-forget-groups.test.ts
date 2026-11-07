/**
 * `forget` removes whole groups — a message with the `role: 'tool'` replies
 * that follow it — so an assistant's `tool_calls` never lose their replies,
 * and it can trim an agent's tool loop after the last user message.
 */
import { Prompt } from '../prompt';
import { Context, Message, Request } from '../types';

/** A prompt whose `forget` a test can call. */
class Forgetful extends Prompt<{}, {}, 'forgetful', {}, string> {
  constructor() {
    super({ name: 'forgetful', description: 'Forgetful', content: 'Test' });
  }
  trim(messages: Message[], contextWindow: number): Message[] {
    const ctx: Context<{}, {}> = { messages: [], contextWindow, maxOutputTokens: 0 };
    const request: Request = { messages };
    return this.forget(request, ctx);
  }
}

const sys = (content: string): Message => ({ role: 'system', content, tokens: 10 });
const user = (content: string): Message => ({ role: 'user', content, tokens: 100 });
const assistant = (content: string, ...ids: string[]): Message => ({
  role: 'assistant',
  content,
  tokens: 100,
  ...(ids.length ? { toolCalls: ids.map(id => ({ id, name: 'echo', arguments: '{}' })) } : {}),
});
const reply = (id: string): Message => ({ role: 'tool', content: `result ${id}`, toolCallId: id, tokens: 100 });

/** Every assistant tool call has its reply, and every reply follows its call. */
function paired(messages: Message[]): boolean {
  const open = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!message.toolCallId || !open.delete(message.toolCallId)) return false;
    } else {
      if (open.size > 0) return false;
      for (const call of message.toolCalls ?? []) open.add(call.id);
    }
  }
  return open.size === 0;
}

describe('forget trims whole groups', () => {
  const prompt = new Forgetful();

  it('removes a tool-calling assistant together with its replies', () => {
    const history = [sys('s'), user('u1'), assistant('a1', 'c1', 'c2'), reply('c1'), reply('c2'), assistant('a2'), user('u2')];
    // 610 tokens in a 460 window: removing u1 (100) is not enough, so the whole a1 group goes too.
    const trimmed = prompt.trim(history, 460);
    expect(trimmed.map(m => m.content)).toEqual(['s', 'a2', 'u2']);
    expect(paired(trimmed)).toBe(true);
  });

  it('never stops between a tool call and its replies', () => {
    const history = [sys('s'), assistant('a1', 'c1', 'c2', 'c3'), reply('c1'), reply('c2'), reply('c3'), user('u')];
    // 510 tokens in a 450 window: removing the assistant alone (100) would be enough, but its replies go with it.
    const trimmed = prompt.trim(history, 450);
    expect(trimmed.map(m => m.content)).toEqual(['s', 'u']);
    expect(paired(trimmed)).toBe(true);
  });

  it('trims a tool loop after the last user message, keeping that message and the latest group', () => {
    const history = [
      sys('s'), user('task'),
      assistant('a1', 'c1'), reply('c1'),
      assistant('a2', 'c2'), reply('c2'),
      assistant('a3', 'c3'), reply('c3'),
    ];
    // 710 tokens in a 450 window: the a1 and a2 groups go, the task and the a3 group stay.
    const trimmed = prompt.trim(history, 450);
    expect(trimmed.map(m => m.content)).toEqual(['s', 'task', 'a3', 'result c3']);
    expect(paired(trimmed)).toBe(true);
  });

  it('keeps system messages, the last user message and the latest group even when still over', () => {
    const history = [sys('s'), user('task'), assistant('a1', 'c1'), reply('c1')];
    expect(prompt.trim(history, 50).map(m => m.content)).toEqual(['s', 'task', 'a1', 'result c1']);
  });

  it('leaves history that fits alone', () => {
    const history = [sys('s'), user('u'), assistant('a')];
    expect(prompt.trim(history, 10_000)).toBe(history);
  });
});
