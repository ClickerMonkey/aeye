/**
 * Credentials on the wire: a Bedrock API key goes as a bearer token, an access key pair signs the request (SigV4).
 * A fake HTTP handler records each request and answers with a recorded Converse response, so no AWS call is made.
 */
import { Readable } from 'node:stream';
import { AWSBedrockProvider, type AWSBedrockConfig } from '../aws';

/** A recorded Converse response. */
const CONVERSE_REPLY = {
  output: { message: { role: 'assistant', content: [{ text: 'Hello there.' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, cacheReadInputTokens: 8 },
  metrics: { latencyMs: 120 },
};

interface SeenRequest {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** An HTTP handler that records requests and answers every one with `reply`. */
function fakeHandler(reply: unknown): { handler: NonNullable<AWSBedrockConfig['requestHandler']>; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const handler = {
    metadata: { handlerProtocol: 'h1' },
    async handle(request: { path: string; headers: Record<string, string>; body?: unknown }) {
      seen.push({ path: request.path, headers: Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v])), body: typeof request.body === 'string' ? JSON.parse(request.body) : request.body });
      const body = Buffer.from(JSON.stringify(reply));
      return { response: { statusCode: 200, reason: 'OK', headers: { 'content-type': 'application/json', 'content-length': String(body.length) }, body: Readable.from([body]) } };
    },
    updateHttpClientConfig() {},
    httpHandlerConfigs() { return {}; },
  };
  return { handler, seen };
}

const MODEL = 'anthropic.claude-3-haiku-20240307-v1:0';

async function converse(config: AWSBedrockConfig) {
  const provider = new AWSBedrockProvider(config);
  const executor = provider.createExecutor();
  return executor({ messages: [{ role: 'user', content: 'Hi' }] }, {}, { model: MODEL });
}

describe('AWSBedrockProvider credentials', () => {
  it('sends a Bedrock API key as a bearer token, unsigned', async () => {
    const { handler, seen } = fakeHandler(CONVERSE_REPLY);
    const response = await converse({ region: 'us-east-1', apiKey: 'bedrock-api-key-123', requestHandler: handler });
    expect(response.content).toBe('Hello there.');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toContain('/converse');
    expect(seen[0]?.headers['authorization']).toBe('Bearer bedrock-api-key-123');
    expect(seen[0]?.headers['x-amz-date']).toBeUndefined();
  });

  it('prefers the API key over an access key pair', async () => {
    const { handler, seen } = fakeHandler(CONVERSE_REPLY);
    await converse({ region: 'us-east-1', apiKey: 'k', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }, requestHandler: handler });
    expect(seen[0]?.headers['authorization']).toBe('Bearer k');
  });

  it('signs with an access key pair and session token', async () => {
    const { handler, seen } = fakeHandler(CONVERSE_REPLY);
    await converse({ region: 'eu-west-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session' }, requestHandler: handler });
    const auth = seen[0]?.headers['authorization'] ?? '';
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/bedrock\/aws4_request/);
    expect(seen[0]?.headers['x-amz-security-token']).toBe('session');
  });

  it('reads usage, including cache reads, from the recorded reply', async () => {
    const { handler } = fakeHandler(CONVERSE_REPLY);
    const response = await converse({ region: 'us-east-1', apiKey: 'k', requestHandler: handler });
    expect(response.usage?.text?.input).toBeGreaterThan(0);
    expect(response.usage?.text?.cached).toBe(8);
  });
});
