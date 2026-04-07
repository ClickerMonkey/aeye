# Weather Tool Agent

An AI assistant that checks the weather and gives clothing advice.

```typescript
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import z from 'zod';

const openai = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });
const ai = AI.with().providers({ openai }).create();

// Weather tool
const getWeather = ai.tool({
  name: 'getWeather',
  description: 'Get current weather for a city',
  instructions: 'Use this tool to fetch current weather data for {{location}}.',
  schema: z.object({
    location: z.string().describe('City name, e.g. "San Francisco"'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  call: async ({ location, units }) => {
    // In production, call a real weather API
    const temps: Record<string, number> = {
      'Paris': 18, 'Tokyo': 22, 'New York': 15, 'London': 12,
    };
    return {
      temperature: temps[location] ?? 20,
      condition: 'partly cloudy',
      units,
      location,
    };
  },
});

// Prompt that uses the tool and returns structured output
const weatherAdvisor = ai.prompt({
  name: 'weatherAdvisor',
  description: 'Gives travel clothing advice based on weather',
  content: `You are a helpful travel advisor.
The user is visiting {{destination}}.
Check the weather and suggest what to wear.`,
  input: (input: { destination: string }) => ({ destination: input.destination }),
  tools: [getWeather],
  schema: z.object({
    suggestion: z.string().describe('Clothing and packing suggestion'),
    temperature: z.number().describe('Current temperature'),
    condition: z.string().describe('Weather condition'),
  }),
});

// Run it
const advice = await weatherAdvisor.get('result', { destination: 'Paris' });
console.log(`Temperature: ${advice?.temperature}°`);
console.log(`Condition: ${advice?.condition}`);
console.log(`Advice: ${advice?.suggestion}`);
```
