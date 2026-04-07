# Basic Chat Bot

A simple interactive chat bot with streaming responses.

```typescript
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import { Message } from '@aeye/core';
import * as readline from 'readline';

const openai = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });
const ai = AI.with().providers({ openai }).create();

const messages: Message[] = [
  { role: 'system', content: 'You are a helpful, friendly assistant.' },
];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function chat() {
  while (true) {
    const input = await new Promise<string>((resolve) => {
      rl.question('\nYou: ', resolve);
    });

    if (input === 'quit') break;

    messages.push({ role: 'user', content: input });

    process.stdout.write('Assistant: ');
    let fullResponse = '';

    for await (const chunk of ai.chat.stream({ messages })) {
      if (chunk.content) {
        process.stdout.write(chunk.content);
        fullResponse += chunk.content;
      }
    }

    messages.push({ role: 'assistant', content: fullResponse });
    console.log();
  }

  rl.close();
}

chat();
```
