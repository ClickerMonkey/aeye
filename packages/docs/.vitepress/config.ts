import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '@aeye',
  description: 'Multi-provider AI library for TypeScript',
  base: '/aeye/',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/aeye/logo.svg' }],
  ],
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Guide', link: '/getting-started/installation' },
      { text: 'Components', link: '/components/tools' },
      { text: 'Providers', link: '/providers/openai' },
      { text: 'API Reference', link: '/reference/core/types' },
      { text: 'Examples', link: '/examples/basic-chat' },
    ],
    sidebar: {
      '/getting-started/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Installation', link: '/getting-started/installation' },
            { text: 'Quick Start', link: '/getting-started/quick-start' },
            { text: 'Multi-Provider Setup', link: '/getting-started/multi-provider' },
          ],
        },
      ],
      '/concepts/': [
        {
          text: 'Core Concepts',
          items: [
            { text: 'AI Instance', link: '/concepts/ai-instance' },
            { text: 'Providers', link: '/concepts/providers' },
            { text: 'Models & Selection', link: '/concepts/models' },
            { text: 'Context & Metadata', link: '/concepts/context' },
            { text: 'Cost Tracking', link: '/concepts/cost-tracking' },
            { text: 'Hooks & Lifecycle', link: '/concepts/hooks' },
          ],
        },
      ],
      '/components/': [
        {
          text: 'Components',
          items: [
            { text: 'Tools', link: '/components/tools' },
            { text: 'Prompts', link: '/components/prompts' },
            { text: 'Agents', link: '/components/agents' },
            { text: 'Composition Patterns', link: '/components/composition' },
          ],
        },
      ],
      '/guides/': [
        {
          text: 'Guides',
          items: [
            { text: 'Chat Completions', link: '/guides/chat' },
            { text: 'Streaming', link: '/guides/streaming' },
            { text: 'Tool Calling', link: '/guides/tool-calling' },
            { text: 'Structured Output', link: '/guides/structured-output' },
            { text: 'Image Generation', link: '/guides/image-generation' },
            { text: 'Image Analysis (Vision)', link: '/guides/vision' },
            { text: 'Speech Synthesis', link: '/guides/speech' },
            { text: 'Audio Transcription', link: '/guides/transcription' },
            { text: 'Embeddings', link: '/guides/embeddings' },
            { text: 'Reasoning Models', link: '/guides/reasoning' },
            { text: 'Model Selection', link: '/guides/model-selection' },
            { text: 'Budget & Cost Control', link: '/guides/budget' },
            { text: 'Context Management', link: '/guides/context-management' },
            { text: 'Error Handling', link: '/guides/error-handling' },
            { text: 'Custom Providers', link: '/guides/custom-providers' },
          ],
        },
      ],
      '/providers/': [
        {
          text: 'Providers',
          items: [
            { text: 'OpenAI', link: '/providers/openai' },
            { text: 'OpenRouter', link: '/providers/openrouter' },
            { text: 'Replicate', link: '/providers/replicate' },
            { text: 'AWS Bedrock', link: '/providers/aws' },
            { text: 'Custom Provider', link: '/providers/custom' },
          ],
        },
      ],
      '/reference/': [
        {
          text: '@aeye/core',
          items: [
            { text: 'Types', link: '/reference/core/types' },
            { text: 'Tool', link: '/reference/core/tool' },
            { text: 'Prompt', link: '/reference/core/prompt' },
            { text: 'Agent', link: '/reference/core/agent' },
            { text: 'Utilities', link: '/reference/core/utilities' },
            { text: 'Schema Utilities', link: '/reference/core/schema' },
          ],
        },
        {
          text: '@aeye/ai',
          items: [
            { text: 'AI Class', link: '/reference/ai/ai-class' },
            { text: 'ChatAPI', link: '/reference/ai/chat-api' },
            { text: 'ImageAPI', link: '/reference/ai/image-api' },
            { text: 'SpeechAPI', link: '/reference/ai/speech-api' },
            { text: 'TranscribeAPI', link: '/reference/ai/transcribe-api' },
            { text: 'EmbedAPI', link: '/reference/ai/embed-api' },
            { text: 'ModelsAPI', link: '/reference/ai/models-api' },
            { text: 'Model Registry', link: '/reference/ai/registry' },
            { text: 'Types', link: '/reference/ai/types' },
          ],
        },
        {
          text: 'Providers',
          items: [
            { text: '@aeye/openai', link: '/reference/providers/openai' },
            { text: '@aeye/openrouter', link: '/reference/providers/openrouter' },
            { text: '@aeye/replicate', link: '/reference/providers/replicate' },
            { text: '@aeye/aws', link: '/reference/providers/aws' },
          ],
        },
      ],
      '/examples/': [
        {
          text: 'Examples',
          items: [
            { text: 'Basic Chat Bot', link: '/examples/basic-chat' },
            { text: 'Weather Tool Agent', link: '/examples/weather-agent' },
            { text: 'Code Reviewer', link: '/examples/code-reviewer' },
            { text: 'Todo Manager', link: '/examples/todo-manager' },
            { text: 'Knowledge Base', link: '/examples/knowledge-base' },
            { text: 'Budget Control', link: '/examples/budget-control' },
            { text: 'Multi-Provider Fallback', link: '/examples/multi-provider' },
            { text: 'Cletus — Full CLI Agent', link: '/examples/cletus' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/ClickerMonkey/aeye' },
      { icon: 'npm', link: 'https://www.npmjs.com/org/aeye' },
    ],
    search: {
      provider: 'local',
    },
    editLink: {
      pattern: 'https://github.com/ClickerMonkey/aeye/edit/main/packages/docs/:path',
    },
    footer: {
      message: 'Released under the GPL-3.0 License.',
      copyright: 'Copyright 2024-present ClickerMonkey',
    },
  },
})
