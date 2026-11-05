# @aeye/test-integration

Integration tests for @aeye multi-provider functionality. These tests make **real API calls** to verify that multiple providers work together correctly.

## Setup

1. Copy the root `.env.example` to `.env.test`:
   ```bash
   cp ../../.env.example ../../.env.test
   ```

2. Add your API keys to `.env.test`:
   ```bash
   OPENAI_API_KEY=sk-...
   OPENROUTER_API_KEY=sk-or-v1-...
   XAI_API_KEY=xai-...
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

## Running Tests

### Run all integration tests:
```bash
npm test
```

### Run specific test suites:
```bash
# Multi-provider tests only
npm test -- multi-provider

# With verbose output
npm test -- --verbose
```

### Watch mode:
```bash
npm run test:watch
```

## What These Tests Do

### Multi-Provider Tests (`multi-provider.test.ts`)

Tests that verify multiple AI providers work together:

- ✅ **Model Discovery**: Lists models from all configured providers
- ✅ **Model Selection**: Selects best model across providers based on criteria (cost, accuracy, etc.)
- ✅ **Cross-Provider Chat**: Executes chat completions on all available providers
- ✅ **Streaming**: Tests streaming responses from all providers
- ✅ **Cost Comparison**: Compares pricing across providers
- ✅ **Provider Health**: Checks health status of all providers
- ✅ **Allowlist/Denylist**: Tests provider filtering

## Test Behavior

- Tests automatically **skip** if API keys are not provided
- Multi-provider tests require both OpenAI and OpenRouter API keys
- Tests use **free/cheap models** when possible to minimize costs
- Default timeout is **60 seconds** per test (API calls can be slow)

## Live Cases

Suites built on `liveCase` (`src/live.ts`) only call an API when something they depend on changed. A case records its pass in `.live-cache/` (gitignored) under a fingerprint of its inputs and the source of the packages it exercises. The next run skips it, reported as `(passed, unchanged)`, until that source or input changes.

- `LIVE=force npx jest` reruns every case.
- Delete a file under `.live-cache/`, or the folder, to rerun those cases.
- `firstChunk` cancels a stream at the model's first token, so checks that a request is accepted (no 400) cost a few output tokens at most.

## Cost Considerations

Integration tests make real API calls, which cost money. Live cases stay cheap: they use the smallest model of each class, stop at the first token where they can, and don't run again while they still pass.

## Example Output

```
Multi-Provider Integration
  Testing with providers: openai, openrouter

  Model Discovery
    ✓ should have models from all configured providers (1234ms)
      openai: 45 models
      openrouter: 127 models
    ✓ should list models with chat capability (156ms)
      Found 172 chat models across all providers

  Model Selection
    ✓ should select cheapest model across all providers (89ms)
      Cheapest: meta-llama/llama-3.2-3b-instruct:free from openrouter
      Cost: $0/M input, $0/M output

  Cross-Provider Chat Execution
    ✓ should execute chat on all available providers (3421ms)
      openai: Test successful
      openrouter: Test successful
```

## Troubleshooting

### Tests are skipped
- Make sure `.env.test` exists in the project root
- Verify your API keys are valid and have sufficient credits
- Check that OpenAI and OpenRouter both have API keys for multi-provider tests

### Tests timeout
- Increase timeout in `jest.config.js` (default is 60s)
- Check your internet connection
- Verify provider API status pages

### API errors
- Check API key validity and permissions
- Ensure sufficient credits/quota on provider accounts
- Review provider-specific rate limits

## CI/CD

In CI environments:
- Set API keys as secrets/environment variables
- Use `if: env.OPENAI_API_KEY` conditions to skip when keys aren't available
- Consider running integration tests only on specific branches or schedules

## Contributing

When adding new integration tests:
1. Use `skipIfNoAPIKey()` to make tests optional
2. Use cheap/free models when possible
3. Add console.log() for helpful output
4. Set appropriate timeouts (30-60s for API calls)
5. Test both success and error scenarios
