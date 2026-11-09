/**
 * Live Bedrock check: one short Converse call with whichever credentials the environment has (a Bedrock API key in
 * `AWS_BEARER_TOKEN_BEDROCK`, or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`). Skipped without either.
 * `AWS_REGION` picks the region (default us-east-1); `AWS_BEDROCK_LIVE_MODEL` the model.
 */
import { AWSBedrockProvider, type AWSBedrockConfig } from '../aws';

const env = process.env;
const apiKey = env['AWS_BEARER_TOKEN_BEDROCK'];
const accessKeyId = env['AWS_ACCESS_KEY_ID'];
const secretAccessKey = env['AWS_SECRET_ACCESS_KEY'];
const configured = apiKey !== undefined || (accessKeyId !== undefined && secretAccessKey !== undefined);
const live = configured ? describe : describe.skip;

live('AWSBedrockProvider (live)', () => {
  it('answers a short prompt', async () => {
    const config: AWSBedrockConfig = {
      region: env['AWS_REGION'] ?? 'us-east-1',
      ...(apiKey !== undefined ? { apiKey } : { credentials: { accessKeyId, secretAccessKey, sessionToken: env['AWS_SESSION_TOKEN'] } }),
    };
    const executor = new AWSBedrockProvider(config).createExecutor();
    const response = await executor(
      { messages: [{ role: 'user', content: 'Reply with the word ok.' }], maxTokens: 16 },
      {},
      { model: env['AWS_BEDROCK_LIVE_MODEL'] ?? 'anthropic.claude-3-haiku-20240307-v1:0' },
    );
    expect(response.content.toLowerCase()).toContain('ok');
  }, 60_000);
});
