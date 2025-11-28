import { JsonFile, getConfigPath } from './file-manager';
import {
  ConfigSchema,
  type Config,
  type Assistant,
  type ChatMeta,
  type TypeDefinition,
} from './schemas';
import { AUTONOMOUS } from './constants';

/**
 * Default assistants created during initialization
 */
const DEFAULT_ASSISTANTS: Assistant[] = [
  {
    name: 'Gollum',
    prompt: 'You are Gollum from The Lord of the Rings. When interacting with the user you MUST ONLY talk like Gollum talks. Be helpful and just a tiny tricksy.',
    created: Date.now(),
  },
  {
    name: 'Harry Potter',
    prompt: 'You are Harry Potter. When interacting with the user add magic spell casting to all of your replies.',
    created: Date.now(),
  },
  {
    name: 'Sherlock Holmes',
    prompt: 'You are Sherlock Holmes, you know all about him, you speak just like him, and you think extra hard about things. Nothing gets passed you.',
    created: Date.now(),
  },
  {
    name: 'Comic',
    prompt: 'You are a Comic that helps the user but when it sees a joke it can make in the process it always makes it.',
    created: Date.now(),
  },
];

/**
 * Default data types created during initialization
 */
const DEFAULT_TYPES: TypeDefinition[] = [
  {
    name: 'task',
    friendlyName: 'Task',
    description: 'A task you would like to keep track of to complete',
    knowledgeTemplate: "Task {{name}}{{#if details}}\nDetails: {{details}}{{/if}}{{#if createdAt}}\nCreated At: {{createdAt}}{{/if}}{{#if dueAt}}\nDue At: {{dueAt}}{{/if}}{{#if doneAt}}\nDone At: {{doneAt}}{{/if}}{{#if cancelledAt}}\nCancelled At: {{cancelledAt}}{{/if}}",
    fields: [
      {
        name: 'name',
        friendlyName: 'Name',
        type: 'string',
        required: true,
      },
      {
        name: 'details',
        friendlyName: 'Details',
        type: 'string',
        default: '',
      },
      {
        name: 'createdAt',
        friendlyName: 'Created',
        type: 'date',
      },
      {
        name: 'dueAt',
        friendlyName: 'Due',
        type: 'date',
      },
      {
        name: 'doneAt',
        friendlyName: 'Done',
        type: 'date',
      },
      {
        name: 'cancelledAt',
        friendlyName: 'Cancelled',
        type: 'date',
      },
    ],
  },
];

/**
 * Type change event listener type
 */
export type TypeChangeListener = () => void | Promise<void>;

/**
 * Config file manager
 */
export class ConfigFile extends JsonFile<Config> {
  private typeChangeListeners: Map<string, TypeChangeListener> = new Map();

  constructor() {
    const initialData: Config = {
      updated: Date.now(),
      user: {
        name: '',
        pronouns: '',
        memory: [],
        debug: false,
        globalPrompt: '',
        promptFiles: ['cletus.md', 'agents.md', 'claude.md'],
        autonomous: {
          maxIterations: AUTONOMOUS.DEFAULT_MAX_ITERATIONS,
          timeout: AUTONOMOUS.DEFAULT_TIMEOUT_MS,
        },
        showInput: false,
        showOutput: false,
        showSystemMessages: true,
      },
      providers: {
        openai: null,
        openrouter: null,
        replicate: null,
        aws: null,
      },
      tavily: null,
      assistants: DEFAULT_ASSISTANTS,
      chats: [],
      types: DEFAULT_TYPES,
    };

    super(getConfigPath(), initialData);
  }

  /**
   * Register a listener for type changes by name.
   * Using the same name will replace any existing listener with that name.
   */
  onTypeChange(name: string, listener: TypeChangeListener): () => void {
    this.typeChangeListeners.set(name, listener);
    return () => this.typeChangeListeners.delete(name);
  }

  /**
   * Unregister a type change listener by name
   */
  offTypeChange(name: string): void {
    this.typeChangeListeners.delete(name);
  }

  /**
   * Notify all type change listeners
   */
  private async notifyTypeChange(): Promise<void> {
    for (const listener of this.typeChangeListeners.values()) {
      await listener();
    }
  }

  protected validate(parsed: any): Config {
    return ConfigSchema.parse(parsed);
  }

  protected getUpdatedTimestamp(data: any): number {
    return data.updated;
  }

  protected setUpdatedTimestamp(data: Config, timestamp: number): void {
    data.updated = timestamp;
  }

  /**
   * Get all chats sorted by most recent
   */
  getChats(): ChatMeta[] {
    return [...this.data.chats].sort((a, b) => b.updated - a.updated);
  }

  /**
   * Add a new chat
   */
  async addChat(chat: ChatMeta): Promise<void> {
    await this.save((config) => {
      config.chats.push(chat);
    });
  }

  /**
   * Update an existing chat
   */
  async updateChat(chatId: string, updates: Partial<ChatMeta>): Promise<void> {
    await this.save((config) => {
      const chat = config.chats.find((c) => c.id === chatId);
      if (!chat) {
        throw new Error(`Chat ${chatId} not found`);
      }
      Object.assign(chat, updates);
      chat.updated = Date.now();
    });
  }

  /**
   * Delete a chat
   */
  async deleteChat(chatId: string): Promise<void> {
    await this.save((config) => {
      config.chats = config.chats.filter((c) => c.id !== chatId);
    });
  }

  /**
   * Add user memory
   */
  async addMemory(text: string): Promise<void> {
    await this.save((config) => {
      config.user.memory.push({
        text,
        created: Date.now(),
      });
    });
  }

  /**
   * Add a custom assistant
   */
  async addAssistant(assistant: Omit<Assistant, 'created'>): Promise<void> {
    await this.save((config) => {
      config.assistants.push({
        ...assistant,
        created: Date.now(),
      });
    });
  }

  /**
   * Add a custom data type
   */
  async addType(type: TypeDefinition): Promise<void> {
    await this.save((config) => {
      if (config.types.some((t) => t.name === type.name)) {
        throw new Error(`Type ${type.name} already exists`);
      }
      config.types.push(type);
    });
    await this.notifyTypeChange();
  }

  /**
   * Save changes that may include type modifications
   * @param modifier - Function to modify config
   * @param mayModifyTypes - Whether this save may modify types (triggers listener notification)
   */
  async saveWithTypeCheck<R = void>(modifier: (current: Config) => R | Promise<R>): Promise<R> {
    const typesBefore = JSON.stringify(this.data.types);
    const result = await this.save(modifier);
    const typesAfter = JSON.stringify(this.data.types);
    
    if (typesBefore !== typesAfter) {
      await this.notifyTypeChange();
    }
    
    return result;
  }

  /**
   * Get default assistants
   */
  static getDefaultAssistants(): Assistant[] {
    return DEFAULT_ASSISTANTS;
  }

  /**
   * Get default types
   */
  static getDefaultTypes(): TypeDefinition[] {
    return DEFAULT_TYPES;
  }
}
