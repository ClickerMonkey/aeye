/**
 * Schema delivery and schema rejections in the Bedrock provider.
 */

import { z } from 'zod';
import { SchemaRejectedError, type Request } from '@aeye/core';
import { AWSBedrockProvider } from '../aws';

const model = 'anthropic.claude-3-haiku-20240307-v1:0';

function provider(send: jest.Mock) {
  const bedrock = new AWSBedrockProvider({ region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  return Object.assign(bedrock, { bedrockRuntimeClient: { send } });
}

describe('Bedrock schema delivery', () => {
  it('puts an output schema in the prompt when the model has no strict structured output', async () => {
    const send = jest.fn().mockResolvedValue({ output: { message: { content: [{ text: '{"value":1}' }] } }, stopReason: 'end_turn' });
    const request: Request = {
      model,
      messages: [{ role: 'system', content: 'Answer.' }, { role: 'user', content: 'Go' }],
      responseFormat: { type: z.object({ value: z.number() }), strict: 1 },
    };

    await provider(send).createExecutor()(request, {});

    expect(JSON.stringify(send.mock.calls[0][0].input.system)).toContain('conforming to this schema');
  });

  it('classifies a rejected tool schema', async () => {
    const rejected = Object.assign(new Error('tools.0.custom.input_schema: JSON schema is invalid'), { name: 'ValidationException' });
    const send = jest.fn().mockRejectedValue(rejected);
    const request: Request = {
      model,
      messages: [{ role: 'user', content: 'Go' }],
      tools: [{ name: 'lookup', parameters: z.object({ q: z.string() }) }],
    };

    const error = await provider(send).createExecutor()(request, {}).then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(SchemaRejectedError);
    expect(error).toMatchObject({ target: { kind: 'tool', name: 'lookup' } });
  });
});
