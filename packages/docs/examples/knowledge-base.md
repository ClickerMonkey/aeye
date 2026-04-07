# Knowledge Base with Semantic Search

A Q&A system that searches a knowledge base using embeddings before answering.

```typescript
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import z from 'zod';

const openai = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });
const ai = AI.with().providers({ openai }).create();

// Simple in-memory vector store
const knowledgeBase: Array<{ text: string; embedding: number[] }> = [];

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Index documents
async function indexDocuments(texts: string[]) {
  const response = await ai.embed.get({ texts });
  for (let i = 0; i < texts.length; i++) {
    knowledgeBase.push({
      text: texts[i],
      embedding: response.embeddings[i].embedding,
    });
  }
}

// Search tool
const searchKnowledge = ai.tool({
  name: 'searchKnowledge',
  description: 'Search the knowledge base for relevant information',
  schema: z.object({
    query: z.string().describe('Search query'),
    limit: z.number().default(3).describe('Max results'),
  }),
  call: async ({ query, limit }) => {
    const queryEmbedding = await ai.embed.get({ texts: [query] });
    const qVec = queryEmbedding.embeddings[0].embedding;

    const scored = knowledgeBase
      .map((doc) => ({
        text: doc.text,
        score: cosineSimilarity(qVec, doc.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return { results: scored };
  },
});

// Q&A prompt
const qaAssistant = ai.prompt({
  name: 'qaAssistant',
  description: 'Answers questions using the knowledge base',
  content: `You are a helpful assistant. Use the searchKnowledge tool to find
relevant information before answering. Base your answers on the search results.

Question: {{question}}`,
  input: (input: { question: string }) => ({ question: input.question }),
  tools: [searchKnowledge],
});

// Usage
await indexDocuments([
  'The API timeout can be configured via the retry.timeout option in provider config.',
  'Rate limiting is handled automatically with exponential backoff.',
  'To enable streaming, use ai.chat.stream() instead of ai.chat.get().',
  'Custom providers must implement the Provider interface.',
]);

const answer = await qaAssistant.get('result', {
  question: 'How do I configure the API timeout?',
});
console.log(answer);
```
