import { any, z } from 'zod';
import { AUTONOMOUS } from './constants';

// ============================================================================
// User Schema
// ============================================================================

export const UserMemorySchema = z.object({
  text: z.string(),
  created: z.number(),
});

export const UserSchema = z.object({
  name: z.string(),
  pronouns: z.string().optional(),
  memory: z.array(UserMemorySchema).default([]),
  debug: z.boolean().default(true),
  globalPrompt: z.string().optional(),
  promptFiles: z.array(z.string()).default(['cletus.md', 'agents.md', 'claude.md']),
  models: z.object({
    chat: z.string().optional(),
    imageGenerate: z.string().optional(),
    imageEdit: z.string().optional(),
    imageAnalyze: z.string().optional(),
    imageEmbed: z.string().optional(),
    transcription: z.string().optional(),
    speech: z.string().optional(),
    summary: z.string().optional(),
    describe: z.string().optional(),
    transcribe: z.string().optional(),
    edit: z.string().optional(),
  }).optional(),
  autonomous: z.object({
    maxIterations: z.number().min(AUTONOMOUS.MIN_ITERATIONS).default(AUTONOMOUS.DEFAULT_MAX_ITERATIONS),
    timeout: z.number().min(AUTONOMOUS.MIN_TIMEOUT_MS).default(AUTONOMOUS.DEFAULT_TIMEOUT_MS),
  }).optional(),
  showInput: z.boolean().default(false),
  showOutput: z.boolean().default(false),
  showSystemMessages: z.boolean().default(true),
});

// ============================================================================
// Provider Schemas
// ============================================================================

export const OpenAIConfigSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string().optional(),
  organization: z.string().optional(),
  project: z.string().optional(),
  retry: z.object({
    maxRetries: z.number().optional(),
    initialDelay: z.number().optional(),
    maxDelay: z.number().optional(),
    backoffMultiplier: z.number().optional(),
    jitter: z.boolean().optional(),
    retryableStatuses: z.array(z.number()).optional(),
    timeout: z.number().optional(),
  }).optional(),
  defaultModels: z.object({
    chat: z.string().optional(),
    imageGenerate: z.string().optional(),
    imageEdit: z.string().optional(),
    imageAnalyze: z.string().optional(),
    transcription: z.string().optional(),
    speech: z.string().optional(),
    embedding: z.string().optional(),
    edit: z.string().optional(),
  }).optional(),
});

export const OpenRouterConfigSchema = OpenAIConfigSchema.extend({
  defaultParams: z.object({
    siteUrl: z.string().optional(),
    appName: z.string().optional(),
    providers: z.object({
      order: z.array(z.string()).optional(),
      allowFallbacks: z.boolean().optional(),
      requireParameters: z.boolean().optional(),
      dataCollection: z.enum(['deny', 'allow']).optional(),
      zdr: z.boolean().optional(),
      only: z.array(z.string()).optional(),
      ignore: z.array(z.string()).optional(),
      quantizations: z.array(z.enum(['int4', 'int8', 'fp4', 'fp6', 'fp8', 'fp16', 'bf16', 'fp32', 'unknown'])).optional(),
      sort: z.enum(['price', 'throughput', 'latency']).optional(),
      maxPrice: z.object({
        prompt: z.number().optional(), // dollars per million tokens
        completion: z.number().optional(), // dollars per million tokens
        image: z.number().optional(), // dollars per image
      }).optional(),
    }).optional(), 
    transforms: z.array(z.string()).optional(),
  }).optional(),
});

export const ReplicateConfigSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string().optional(),
});

export const AWSBedrockConfigSchema = z.object({
  region: z.string().optional(),
  credentials: z.object({
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    sessionToken: z.string().optional(),
  }).optional(),
  modelPrefix: z.string().optional(),
  modelFamilies: z.record(z.string(), z.object({
    enabled: z.boolean().optional(),
    modelIdMap: z.record(z.string(), z.string()).optional(),
  })).optional(),
  defaultModels: z.object({
    chat: z.string().optional(),
    imageGenerate: z.string().optional(),
    embedding: z.string().optional(),
  }).optional(),
});

export const TavilyConfigSchema = z.object({
  apiKey: z.string(),
});

export const ProvidersSchema = z.object({
  openai: OpenAIConfigSchema.nullable(),
  openrouter: OpenRouterConfigSchema.nullable(),
  replicate: ReplicateConfigSchema.nullable(),
  aws: AWSBedrockConfigSchema.nullable(),
});

// ============================================================================
// Assistant Schema
// ============================================================================

export const AssistantSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  created: z.number(),
});

// ============================================================================
// Chat Schema
// ============================================================================

export const TodoItemSchema = z.object({
  name: z.string(),
  done: z.boolean(),
  id: z.string(),
});

export const ChatModeSchema = z.enum(['none', 'read', 'create', 'update', 'delete']);

export const OperationModeSchema = z.enum(['local', 'none', 'read', 'create', 'update', 'delete']);

export const AgentModeSchema = z.enum(['plan', 'default']);

export const AgentNameSchema = z.enum(['planner', 'librarian', 'clerk', 'secretary', 'architect', 'dba', 'artist', 'internet']).or(z.string());

export const ChatMetaSchema = z.object({
  id: z.string(),
  title: z.string(),
  assistant: z.string().optional(),
  prompt: z.string().optional(),
  mode: ChatModeSchema.default('none'),
  agentMode: AgentModeSchema.default('default'),
  model: z.string().optional(),
  /** 
   * Current toolset name. When undefined, adaptive tool selection is used 
   * based on embedding similarity. When set, only tools from that toolset are available.
   */
  toolset: z.string().optional(),
  created: z.number(),
  updated: z.number(),
  todos: z.array(TodoItemSchema).default([]),
});

// ============================================================================
// Type Definition Schema
// ============================================================================

export const FieldTypeSchema = z.union([z.enum(['string', 'number', 'boolean', 'date', 'enum']), z.string()]);

export const TypeFieldSchema = z.object({
  name: z.string(),
  friendlyName: z.string(),
  type: FieldTypeSchema,
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().optional(),
  enumOptions: z.array(z.string()).optional(),
  onDelete: z.enum(['restrict', 'cascade', 'setNull']).optional(),
});

export const TypeDefinitionSchema = z.object({
  name: z.string(),
  friendlyName: z.string(),
  description: z.string().optional(),
  knowledgeTemplate: z.string(),
  fields: z.array(TypeFieldSchema),
});

// ============================================================================
// Config Schema
// ============================================================================

export const ConfigSchema = z.object({
  updated: z.number(),
  user: UserSchema,
  providers: ProvidersSchema,
  tavily: TavilyConfigSchema.nullable(),
  assistants: z.array(AssistantSchema),
  chats: z.array(ChatMetaSchema),
  types: z.array(TypeDefinitionSchema),
});

// ============================================================================
// Knowledge Schema
// ============================================================================

export const KnowledgeEntrySchema = z.object({
  source: z.string(),
  text: z.string(),
  vector: z.array(z.number()),
  created: z.number(),
  updated: z.number().optional(),
});

export const KnowledgeSchema = z.object({
  updated: z.number(),
  knowledge: z.array(KnowledgeEntrySchema),
});

// ============================================================================
// Operation Schema
// ============================================================================

export const OperationStatusSchema = z.enum(['created', 'analyzed', 'analyzeError', 'analyzedBlocked', 'analyzing', 'doing', 'done', 'doneError', 'rejected']);

export const OperationKindSchema = z.enum([
  // architect
  'type_info',
  'type_list',
  'type_create',
  'type_update',
  'type_delete',
  'type_import',
  // artist
  'image_generate',
  'image_edit',
  'image_analyze',
  'image_describe',
  'image_find',
  'image_attach',
  // clerk
  'file_search',
  'file_summary',
  'file_index',
  'file_create',
  'file_copy',
  'file_move',
  'file_stats',
  'file_delete',
  'file_read',
  'file_edit',
  'text_search',
  'dir_create',
  'file_attach',
  // dba
  'data_create',
  'data_update',
  'data_delete',
  'data_select',
  'data_update_many',
  'data_delete_many',
  'data_count',
  'data_aggregate',
  'data_index',
  'data_import',
  'data_search',
  // librarian
  'knowledge_search',
  'knowledge_sources',
  'knowledge_add',
  'knowledge_delete',
  // planner
  'todos_clear',
  'todos_list',
  'todos_add',
  'todos_done',
  'todos_get',
  'todos_remove',
  'todos_replace',
  // secretary
  'assistant_switch',
  'assistant_update',
  'assistant_add',
  'memory_list',
  'memory_update',
  // internet
  'web_search',
  'web_get_page',
  'web_api_call',
]);

export const OperationSchema = z.object({
  type: OperationKindSchema,
  status: OperationStatusSchema,
  input: z.any(),
  output: z.any().optional(),
  analysis: z.string().optional(),
  start: z.number(),
  end: z.number().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  requestIndex: z.number().optional(),
});

// ============================================================================
// Message Content Schema
// ============================================================================

export const MessageContentSchema = z.object({
  type: z.enum(['text', 'image', 'file', 'audio']),
  content: z.string(),
  operationIndex: z.number().optional(),
});

// Usage schema matching @aeye/core Usage interface
export const UsageSchema = z.object({
  text: z.object({
    input: z.number().optional(),
    output: z.number().optional(),
    cached: z.number().optional(),
  }).optional(),
  audio: z.object({
    input: z.number().optional(),
    output: z.number().optional(),
    seconds: z.number().optional(),
  }).optional(),
  image: z.object({
    input: z.number().optional(),
    output: z.array(z.object({
      quality: z.string(),
      size: z.object({
        width: z.number(),
        height: z.number(),
      }),
      count: z.number(),
    })).optional(),
  }).optional(),
  reasoning: z.object({
    input: z.number().optional(),
    output: z.number().optional(),
    cached: z.number().optional(),
  }).optional(),
  embeddings: z.object({
    count: z.number().optional(),
    tokens: z.number().optional(),
  }).optional(),
  cost: z.number().optional(),
}).optional();

export const AgentRequest = z.object({
  agent: AgentNameSchema,
  request: z.string(),
  typeName: z.string().optional(),
  simulateMode: OperationModeSchema.optional(),
});

export const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  name: z.string().optional(),
  content: z.array(MessageContentSchema),
  created: z.number(),
  tokens: z.number().optional(),
  cost: z.number().optional(),
  usage: UsageSchema,
  todo: z.string().optional(),
  operations: z.array(OperationSchema).optional(),
  requests: z.array(AgentRequest).optional(),
});


export const ChatMessagesSchema = z.object({
  updated: z.number(),
  messages: z.array(MessageSchema),
});

// ============================================================================
// Data Schema
// ============================================================================

export const DataRecordSchema = z.object({
  id: z.string(),
  created: z.number(),
  updated: z.number(),
  fields: z.record(z.string(), z.any()),
});

export const DataFileSchema = z.object({
  updated: z.number(),
  data: z.array(DataRecordSchema),
});

// ============================================================================
// Type Exports
// ============================================================================

export type UserMemory = z.infer<typeof UserMemorySchema>;
export type User = z.infer<typeof UserSchema>;
export type OpenAIConfig = z.infer<typeof OpenAIConfigSchema>;
export type OpenRouterConfig = z.infer<typeof OpenRouterConfigSchema>;
export type ReplicateConfig = z.infer<typeof ReplicateConfigSchema>;
export type AWSBedrockConfig = z.infer<typeof AWSBedrockConfigSchema>;
export type Providers = z.infer<typeof ProvidersSchema>;
export type Assistant = z.infer<typeof AssistantSchema>;
export type TodoItem = z.infer<typeof TodoItemSchema>;
export type ChatMeta = z.infer<typeof ChatMetaSchema>;
export type ChatMode = z.infer<typeof ChatModeSchema>;
export type AgentMode = z.infer<typeof AgentModeSchema>;
export type FieldType = z.infer<typeof FieldTypeSchema>;
export type TypeField = z.infer<typeof TypeFieldSchema>;
export type TypeDefinition = z.infer<typeof TypeDefinitionSchema>;
export type Config = z.infer<typeof ConfigSchema>;
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;
export type Knowledge = z.infer<typeof KnowledgeSchema>;
export type OperationStatus = z.infer<typeof OperationStatusSchema>;
export type OperationKind = z.infer<typeof OperationKindSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type MessageContent = z.infer<typeof MessageContentSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ChatMessages = z.infer<typeof ChatMessagesSchema>;
export type DataRecord = z.infer<typeof DataRecordSchema>;
export type DataFile = z.infer<typeof DataFileSchema>;
