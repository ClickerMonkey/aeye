import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { configExists } from '../file-manager';
import { ConfigFile } from '../config';
import { ChatFile } from '../chat';
import type { Message, ChatMeta, MessageContent, OperationStatus } from '../schemas';
import type { ClientMessage, ServerMessage } from './websocket-types';
import { OperationManager } from '../operations/manager';
import { CletusAI, createCletusAI } from '../ai';
import { CletusChatAgent, createChatAgent, initTools } from '../agents/chat-agent';
import { OrchestratorEvent, runChatOrchestrator } from '../agents/chat-orchestrator';
import { ChatOperationManager } from './chat-operation-manager';
import { ConnectionRegistry } from './connection-registry';
import { BroadcastManager } from './broadcast-manager';
import { send } from 'process';

const __serverFilename = fileURLToPath(import.meta.url);
const __serverDirname = path.dirname(__serverFilename);

// Chat file cache with automatic cleanup
interface ChatCacheEntry {
  chatFile: ChatFile;
  lastAccessed: number;
}

const chatCache = new Map<string, ChatCacheEntry>();
const CACHE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

async function getChat(chatId: string): Promise<ChatFile> {
  const now = Date.now();

  // Check cache
  const cached = chatCache.get(chatId);
  if (cached) {
    cached.lastAccessed = now;
    return cached.chatFile;
  }

  // Create and load new chat file
  const chatFile = new ChatFile(chatId);
  await chatFile.load();

  chatCache.set(chatId, {
    chatFile,
    lastAccessed: now,
  });

  return chatFile;
}

function cleanupExpiredChats(): void {
  const now = Date.now();
  for (const [chatId, entry] of chatCache.entries()) {
    if (now - entry.lastAccessed > CACHE_EXPIRY_MS) {
      chatCache.delete(chatId);
    }
  }
}

function removeChat(chatId: string): void {
  chatCache.delete(chatId);
}

// Run cleanup every 15 minutes
setInterval(cleanupExpiredChats, 15 * 60 * 1000);

// Server-level state (shared across all connections)
const connectionRegistry = new ConnectionRegistry();
const chatOperationManager = new ChatOperationManager();
const broadcastManager = new BroadcastManager(connectionRegistry, chatOperationManager);

// Periodic cleanup of old completed operations
setInterval(() => chatOperationManager.cleanup(), 5 * 60 * 1000);

export async function startBrowserServer(port: number = 3000): Promise<void> {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';

    try {
      // Handle file serving route
      if (url.startsWith('/file?')) {
        await serveLocalFile(url, res);
        return;
      }

      // Serve static files only
      await serveStaticFile(url, res);
    } catch (error) {
      console.error('Server error:', error);
      res.writeHead(500);
      res.end('Internal server error');
    }
  });

  // WebSocket server for all communication
  const wss = new WebSocketServer({ server });
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => {
      clients.delete(ws);
    });
    handleWebSocketConnection(ws).catch(error => {
      console.error('WebSocket connection error:', error);
      ws.close();
    });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║   Cletus Browser Mode                  ║');
    console.log('╚════════════════════════════════════════╝\n');
    console.log(`  🌐 Server: http://localhost:${port}`);
    console.log('  ⌨️  Press Ctrl+C to exit\n');
  });

  // Handle & log these to avoid silent crashes
  process.on('uncaughtException', (err => {
    console.error('Uncaught exception:', err);
  }));

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled promise rejection:', reason);
  });

  process.on('warning', (warning) => {
    console.warn('Process warning:', warning);
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');

    // Abort all ongoing operations
    chatOperationManager.abortAll();

    // Broadcast shutdown message to all clients
    for (const connection of connectionRegistry.getAllConnections()) {
      if (connection.activeChatId && connection.ws.readyState === 1) {
        connection.ws.send(JSON.stringify({
          type: 'error',
          data: {
            chatId: connection.activeChatId,
            message: 'Server shutting down - operation cancelled'
          }
        } as ServerMessage));
      }
    }

    // Force close all WebSocket connections
    clients.forEach((ws) => {
      ws.close();
    });

    wss.close();
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });

    // Force exit after 1 second if server hasn't closed
    setTimeout(() => {
      console.log('Forcing shutdown...');
      process.exit(0);
    }, 1000);
  });
}

async function handleWebSocketConnection(ws: WebSocket): Promise<void> {
  // Register this connection
  const connectionId = connectionRegistry.registerConnection(ws);

  let config: ConfigFile | null = null;
  let configPromise: Promise<boolean> | null = null;
  let ai: CletusAI | null = null;
  let chatAgent: CletusChatAgent | null = null;
  let configUpdateQueue: Promise<void> = Promise.resolve();

  // Type-safe message sender for this connection
  const sendMessage = (message: ServerMessage) => {
    broadcastManager.sendToConnection(connectionId, message);
  };

  // Helper to send errors
  const sendError = (e: any, message: string = typeof e === 'string' ? e : e.message) => {
    sendMessage({
      type: 'error',
      data: { message },
    });

    console.error(e);
  };

  // Load config once at connection time
  const ensureConfig = async () => {
    if (!configPromise) {
      configPromise = (async () => {
        const exists = await configExists();
        if (!exists) {
          return false;
        }
        config = new ConfigFile();
        await config.load();
        return true;
      })();
    }
    return await configPromise;
  };

  // Lazy-load AI and chat agent once
  const ensureAI = async () => {
    if (!ai || !chatAgent) {
      await ensureConfig();
      if (!config) {
        throw new Error('Config not available');
      }
      ai = createCletusAI(config, 'browser');
      await initTools(ai);
      chatAgent = createChatAgent(ai);
    }
    return { ai, chatAgent };
  };

  const withConfig = async <T>(fn: (config: ConfigFile) => T) => {
    try {
      if (!await ensureConfig()) {
        sendMessage({
          type: 'config_not_found',
          data: {},
        });
        return;
      }
    } catch (e: any) {
      sendError(e);
      return;
    }

    // Ensure config is loaded
    if (config) {
      try {
        return await fn(config);
      } catch (e: any) {
        sendError(e);
      }
    } else {
      sendMessage({
        type: 'config_not_found',
        data: {},
      });
    }
  };

  // Helper to serialize config update operations
  const withConfigUpdate = async <T>(fn: (config: ConfigFile) => Promise<T>) => {
    // Queue this update to run after previous updates complete
    const previousQueue = configUpdateQueue;

    let resolveUpdate: () => void;
    configUpdateQueue = new Promise<void>(resolve => {
      resolveUpdate = resolve;
    });

    try {
      // Wait for previous updates to complete
      await previousQueue;

      // Reload config to get latest state
      if (config) {
        await config.load();
      }

      // Run the update
      return await withConfig(fn);
    } finally {
      // Mark this update as complete
      resolveUpdate!();
    }
  };

  const withChatFile = async <T>(chatId: string, fn: (chatFile: ChatFile, chat: ChatMeta, config: ConfigFile) => T) => {
    return await withConfig(async (config) => {
      let chatFile: ChatFile;
      try {
        chatFile = await getChat(chatId);
      } catch (e: any) {
        sendError(e, 'Failed to load chat file');
        return;
      }

      const chat = config.getChats().find(c => c.id === chatId);
      if (!chat) {
        sendError('Chat not found');

        return;
      }

      try {
        return await fn(chatFile, chat, config);
      } catch (e: any) {
        sendError(e, 'Failed to process chat file');
      }
    });
  };

  /**
   * Save or update a message in the chat file.
   * If message exists (by created timestamp), update it. Otherwise, add it.
   */
  const saveOrUpdateMessage = async (chatFile: ChatFile, message: Message) => {
    const messages = chatFile.getMessages();
    const existingMessage = messages.find(m => m.created === message.created);

    if (existingMessage) {
      await chatFile.updateMessage(message);
    } else {
      await chatFile.addMessage(message);
    }
  };

  const handleOrchestratorEvent = (chatId: string, event: OrchestratorEvent, chatFile: ChatFile) => {
    // Handle orchestrator events
    switch (event.type) {
      case 'pendingUpdate':
        // Save pending message immediately to chat file so it persists
        // This ensures messages are never lost due to errors or cancellations
        fireAndForget(async () => {
          await saveOrUpdateMessage(chatFile, event.pending);
        });
        break;
      case 'update':
        fireAndForget(chatFile.updateMessage(event.message));
        break;
      case 'complete':
        // Update the message if it exists (from pending), or add it if it doesn't
        fireAndForget(async () => {
          if (event.message.content.length > 0) {
            await saveOrUpdateMessage(chatFile, event.message);
          }
        });
        break;
      case 'error':
        // Try to save any pending message state before reporting error
        // This ensures partial progress isn't lost when errors occur
        fireAndForget(async () => {
          const messages = chatFile.getMessages();
          // Find the most recent assistant message that might be pending
          const lastAssistantMsg = messages.filter(m => m.role === 'assistant').pop();
          if (lastAssistantMsg) {
            if (event.error) {
              // Add the error info to the last message content
              let lastText = lastAssistantMsg.content[lastAssistantMsg.content.length - 1];
              if (!lastText || lastText.type !== 'text') {
                lastText = { type: 'text', content: '', created: Date.now() };
                lastAssistantMsg.content.push(lastText);
              }
              lastText.content += `\n\n**Error:** ${event.error}`;
            }
            
            // Update the message to persist any partial progress
            await chatFile.updateMessage(lastAssistantMsg);

            // Broadcast the updated message to all clients watching this chat
            broadcastManager.broadcastToChat(chatId, {
              type: 'message_updated',
              data: { chatId, message: lastAssistantMsg },
            });
          }
        });
        break;
    }

    // Broadcast event to all clients watching this chat
    broadcastManager.broadcastOperationEvent(chatId, event);
  };

  const runChat = async (chatFile: ChatFile, chatMeta: ChatMeta, config: ConfigFile) => {
    const chatId = chatMeta.id;

    // Ensure AI and chat agent are loaded
    const { ai: aiInstance, chatAgent: chatAgentInstance } = await ensureAI();

    // Clear usage before running orchestrator
    const clearUsage = () => {
      const defaultContext = aiInstance.config.defaultContext;
      if (defaultContext && defaultContext.usage) {
        defaultContext.usage.accumulated = {};
        defaultContext.usage.accumulatedCost = 0;
      }
    };

    // Get current usage
    const getUsage = () => {
      const defaultContext = aiInstance.config.defaultContext;
      if (defaultContext && defaultContext.usage) {
        return {
          accumulated: defaultContext.usage.accumulated,
          accumulatedCost: defaultContext.usage.accumulatedCost,
        };
      }
      return { accumulated: {}, accumulatedCost: 0 };
    };

    // Start operation for this chat (get chat-scoped abort controller)
    const abortController = chatOperationManager.startOperation(chatId);

    // Broadcast processing start to all clients watching this chat
    broadcastManager.broadcastToChat(chatId, {
      type: 'processing',
      data: { chatId, isProcessing: true },
    });

    try {
      // Run orchestrator with updated chat file
      await runChatOrchestrator({
        chatAgent: chatAgentInstance,
        messages: chatFile.getMessages(),
        chatMeta: { ...chatMeta, questions: [] },
        config,
        chatData: chatFile,
        signal: abortController.signal,
        clearUsage,
        getUsage,
      }, (event) => {
        handleOrchestratorEvent(chatId, event, chatFile);
      });

      // Mark operation as complete
      chatOperationManager.completeOperation(chatId);
    } catch (error: any) {
      // Mark operation as complete even on error
      chatOperationManager.completeOperation(chatId);

      // Broadcast error to all clients
      broadcastManager.broadcastToChat(chatId, {
        type: 'error',
        data: { chatId, message: error.message || 'Unknown error' },
      });
    } finally {
      // Broadcast processing end to all clients watching this chat
      broadcastManager.broadcastToChat(chatId, {
        type: 'processing',
        data: { chatId, isProcessing: false },
      });
    }
  };

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString()) as ClientMessage;

      switch (message.type) {
        case 'get_config':
          withConfig((config) => {
            sendMessage({
              type: 'config',
              data: config.getData(),
            });
          });
          break;

        case 'create_chat': {
          const { name } = message.data;
          await withConfigUpdate(async (config) => {

            // Generate chat ID and create new chat
            const now = Date.now();
            const chatId = new Date(now)
              .toISOString()
              .replace(/[-:]/g, '')
              .replace(/T/, '-')
              .slice(0, 15);
            const newChat: ChatMeta = {
              id: chatId,
              title: name,
              assistant: undefined,
              prompt: undefined,
              mode: 'none',
              agentMode: 'default',
              created: now,
              updated: now,
              todos: [],
              questions: [],
              toolset: undefined,
              model: undefined,
              reasoning: null,
            };

            await config.addChat(newChat);

            // Create the chat messages file
            const chatFile = new ChatFile(chatId);
            await chatFile.save(() => {
              // Initialize empty chat
            });

            sendMessage({
              type: 'chat_created',
              data: { chatId },
            });
          });
          break;
        }
        case 'get_messages': {
          const { chatId } = message.data;
          await withChatFile(chatId, async (chatFile) => {
            const messages = chatFile.getMessages();

            sendMessage({
              type: 'messages',
              data: { chatId, messages },
            });
          });
          break;
        }
        case 'send_message': {
          const { chatId, content } = message.data;
          await withChatFile(chatId, async (chatFile, chat, config) => {
              
            // Validate content is an array of MessageContent
            if (!Array.isArray(content)) {
              sendMessage({
                type: 'error',
                data: { message: 'Invalid message content: must be an array' },
              });
              return;
            }

            // Add user message with proper typing
            const userMessage: Message = {
              role: 'user',
              content: content as MessageContent[],
              created: Date.now(),
            };
            await chatFile.addMessage(userMessage);

            sendMessage({
              type: 'message_added',
              data: { chatId, message: userMessage },
            });

            // Run the chat
            await runChat(chatFile, chat, config);
          });
          break;
        }
        case 'cancel': {
          const { chatId } = message.data;
          chatOperationManager.cancelOperation(chatId);

          // Broadcast cancellation to all clients watching this chat
          broadcastManager.broadcastToChat(chatId, {
            type: 'processing',
            data: { chatId, isProcessing: false },
          });
          break;
        }

        case 'subscribe_chat': {
          const { chatId } = message.data;

          // Register this connection as watching this chat
          connectionRegistry.setActiveChat(connectionId, chatId);

          // Send confirmation
          sendMessage({
            type: 'chat_subscribed',
            data: { chatId },
          });

          // Send current operation state for this chat
          broadcastManager.sendOperationState(connectionId, chatId);
          break;
        }

        case 'unsubscribe_chat': {
          const { chatId } = message.data;

          // Unregister this connection from watching this chat
          const currentChatId = connectionRegistry.getActiveChat(connectionId);
          if (currentChatId === chatId) {
            connectionRegistry.setActiveChat(connectionId, null);
          }
          break;
        }

        case 'get_models':
          try {
            const { baseMetadata } = message.data || {};
            const { ai: aiInstance } = await ensureAI();
            const models = aiInstance.registry.searchModels(baseMetadata || {});

            sendMessage({
              type: 'models',
              data: { models },
            });
          } catch (error) {
            sendMessage({
              type: 'error',
              data: { message: 'Failed to fetch models' },
            });
          }
          break;

        case 'update_chat_meta': {
          const { chatId, updates, cwd } = message.data;
          withConfigUpdate(async (config) => {

            await config.updateChat(chatId, updates);
            const updatedChat = config.getChats().find(c => c.id === chatId);

            // Update AI cwd if provided
            if (cwd !== undefined && ai) {
              if (!ai.config.defaultContext) {
                ai.config.defaultContext = {};
              }
              ai.config.defaultContext.cwd = cwd;
            }

            sendMessage({
              type: 'chat_updated',
              data: {
                chatId,
                chat: updatedChat,
                cwd: ai?.config.defaultContext?.cwd
              },
            });
          });
          break;
        }
        case 'update_user': {
          const { updates } = message.data;
          withConfigUpdate(async (config) => {
            await config.updateUser(updates);
            sendMessage({
              type: 'config',
              data: config.getData(),
            });
          });
          break;
        }
        case 'add_todo': {
          const { chatId, todo } = message.data;
          withConfigUpdate(async (config) => {
            const chat = config.getChats().find(c => c.id === chatId);
            if (chat) {
              chat.todos.push({ id: Math.random().toString(36).substring(7), name: todo, done: false });
              await config.updateChat(chatId, { todos: chat.todos });
              const updatedChat = config.getChats().find(c => c.id === chatId);
              sendMessage({
                type: 'chat_updated',
                data: { chatId, chat: updatedChat },
              });
            }
          });
          break;
        }
        case 'toggle_todo': {
          const { chatId, index } = message.data;
          withConfigUpdate(async (config) => {
            const chat = config.getChats().find(c => c.id === chatId);
            if (chat && chat.todos[index]) {
              chat.todos[index].done = !chat.todos[index].done;
              await config.updateChat(chatId, { todos: chat.todos });
              const updatedChat = config.getChats().find(c => c.id === chatId);
              sendMessage({
                type: 'chat_updated',
                data: { chatId, chat: updatedChat },
              });
            }
          });
          break;
        }
        case 'remove_todo': {
          const { chatId, index } = message.data;
          withConfigUpdate(async (config) => {
            const chat = config.getChats().find(c => c.id === chatId);
            if (chat && chat.todos[index] !== undefined) {
              chat.todos.splice(index, 1);
              await config.updateChat(chatId, { todos: chat.todos });
              const updatedChat = config.getChats().find(c => c.id === chatId);
              sendMessage({
                type: 'chat_updated',
                data: { chatId, chat: updatedChat },
              });
            }
          });
          break;
        }
        case 'clear_todos': {
          const { chatId } = message.data;
          withConfigUpdate(async (config) => {
            await config.updateChat(chatId, { todos: [] });
            const updatedChat = config.getChats().find(c => c.id === chatId);
            sendMessage({
              type: 'chat_updated',
              data: { chatId, chat: updatedChat },
            });
          });
          break;
        }
        case 'clear_messages': {
          const { chatId } = message.data;
          withChatFile(chatId, async (chatFile) => {
            await chatFile.save((data) => {
              data.messages = [];
            });
            sendMessage({
              type: 'messages_updated',
              data: { chatId, messages: [] },
            });
          });
          break;
        }
        case 'delete_chat': {
          const { chatId } = message.data;

          // Abort any ongoing operation for this chat
          chatOperationManager.cancelOperation(chatId);

          withConfigUpdate(async (config) => {
            await config.deleteChat(chatId);
            removeChat(chatId); // Remove from cache

            // Broadcast deletion to all clients (not just those watching this chat)
            for (const connection of connectionRegistry.getAllConnections()) {
              broadcastManager.sendToConnection(connection.connectionId, {
                type: 'chat_deleted',
                data: { chatId },
              });
            }
          });
          break;
        }
        case 'handle_operations': {
          const { chatId, messageCreated, approved, rejected } = message.data;
          withChatFile(chatId, async (chatFile, chatMeta, config) => {
            const messages = chatFile.getMessages();
            const targetMessage = messages.find(m => m.created === messageCreated);

            if (!targetMessage || !targetMessage.operations) {
              sendMessage({
                type: 'error',
                data: { chatId, message: 'Message or operations not found' },
              });
              return;
            }

            const broadcastMessageUpdate = () => {
              broadcastManager.broadcastToChat(chatId, {
                type: 'message_updated',
                data: { chatId, message: targetMessage },
              });
            };

            const operations = targetMessage.operations;
            const manager = new OperationManager(
              'none',
              operations,
              () => {},
              (op, opIndex) => {
                // Update the message content when operation is executed.
                // Move to end of message content array to ensure visibility.
                const contentIndex = targetMessage.content.findIndex((c) => c.operationIndex === opIndex);
                if (contentIndex !== -1) {
                  // const content = targetMessage.content.splice(contentIndex, 1)[0];
                  // content.content = op.message || '';
                  // targetMessage.content.push(content);

                  targetMessage.content[contentIndex].content = op.message || '';

                  chatFile.updateMessage(targetMessage);
                  broadcastMessageUpdate();
                }
              },
            );

            // Mark rejected operations
            for (const idx of rejected) {
              if (operations[idx]) {
                operations[idx].status = 'rejected';
                manager.updateMessage(operations[idx]);
              }
            }
            
            // Emit fake doing for now
            const previousStatus: Record<number, OperationStatus> = {};
            for (const idx of approved) {
              if (operations[idx]) {
                previousStatus[idx] = operations[idx].status;
                operations[idx].status = 'doing';
              }
            }

            // Save and broadcast the updated operation statuses immediately
            chatFile.updateMessage(targetMessage);
            broadcastMessageUpdate();

            // Execute approved operations
            let hasExecutedOperations = false;
            if (approved.length > 0) {
              // Ensure AI and chat agent are loaded
              const { ai: aiInstance } = await ensureAI();

              // Start operation for this chat
              const abortController = chatOperationManager.startOperation(chatId);

              // Broadcast processing start
              broadcastManager.broadcastToChat(chatId, {
                type: 'processing',
                data: { chatId, isProcessing: true },
              });

              try {
                const ctx = await aiInstance.buildContext({
                  ops: manager,
                  chat: chatMeta,
                  chatData: chatFile,
                  chatMessage: targetMessage,
                  config,
                  signal: abortController.signal,
                  chatStatus: (status) => {
                    broadcastManager.broadcastToChat(chatId, {
                      type: 'status_update',
                      data: { chatId, status },
                    });
                  },
                });

                for (const idx of approved) {
                  if (operations[idx]) {
                    operations[idx].status = previousStatus[idx] || 'analyzed';
                    await manager.execute(operations[idx], true, ctx);
                    hasExecutedOperations = true;
                    if (abortController.signal.aborted) {
                      break;
                    }
                  }
                }

                chatOperationManager.completeOperation(chatId);
              } catch (error: any) {
                chatOperationManager.completeOperation(chatId);
                broadcastManager.broadcastToChat(chatId, {
                  type: 'error',
                  data: { chatId, message: error.message || 'Operation execution failed' },
                });
              } finally {
                // Broadcast processing end
                broadcastManager.broadcastToChat(chatId, {
                  type: 'processing',
                  data: { chatId, isProcessing: false },
                });
              }
            }

            // If operations were executed, continue with the orchestrator
            if (hasExecutedOperations) {
              // Run the chat
              await runChat(chatFile, chatMeta, config);
            }
          });
          break;
        }
        case 'submit_question_answers': {
          const { chatId, questionAnswers, questionCustomAnswers } = message.data;
          withChatFile(chatId, async (chatFile, chatMeta, config) => {
            if (!chatMeta.questions || chatMeta.questions.length === 0) {
              sendMessage({
                type: 'error',
                data: { message: 'No questions to answer' },
              });
              return;
            }

            // Format answers as markdown (matching CLI behavior)
            let questionText = '## Questions\n';
            let answerText = '## Answers\n';

            for (let i = 0; i < chatMeta.questions.length; i++) {
              const question = chatMeta.questions[i];
              const selections = new Set(questionAnswers[i] || []);
              const customAnswer = questionCustomAnswers[i];

              answerText += `**${question.name}:**\n`;
              questionText += `**${question.name}:** ${question.min === question.max ? `(choose ${question.min})` : `(choose ${question.min}-${question.max})`}\n`;

              for (const option of question.options) {
                questionText += `- ${option.label}?\n`;
              }

              if (selections.size > 0) {
                Array.from(selections).forEach((optionIndex) => {
                  if (optionIndex < question.options.length) {
                    answerText += `- ${question.options[optionIndex].label}\n`;
                  }
                });
              }

              if (customAnswer) {
                answerText += `- ${customAnswer}\n`;
              }

              if (selections.size === 0 && !customAnswer) {
                answerText += `- (no answer provided)\n`;
              }

              if (question.custom) {
                questionText += `- *${question.customLabel || 'Other'}?*\n`;
              }

              answerText += '\n';
              questionText += '\n';
            }

            // Clear questions from chat meta
            await withConfigUpdate(async (config) => {
              const chats = config.getChats();
              const chatIndex = chats.findIndex(c => c.id === chatId);
              if (chatIndex !== -1) {
                chats[chatIndex].questions = [];
                await config.updateChat(chatId, { questions: [] });
              }
            });

            // Add the formatted questions as an assistant message
            const questionMessage: Message = {
              role: 'assistant',
              name: chatMeta.assistant,
              content: [{ type: 'text', content: questionText.trim(), created: Date.now() }],
              created: Date.now(),
              operations: [],
            };

            await chatFile.addMessage(questionMessage);
            sendMessage({
              type: 'message_added',
              data: { chatId, message: questionMessage },
            });

            // Add the formatted answer as a user message
            const answerMessage: Message = {
              role: 'user',
              name: config.getData().user.name,
              content: [{ type: 'text', content: answerText.trim(), created: Date.now() }],
              created: Date.now(),
            };

            await chatFile.addMessage(answerMessage);
            sendMessage({
              type: 'message_added',
              data: { chatId, message: answerMessage },
            });

            // Send updated chat meta
            sendMessage({
              type: 'chat_updated',
              data: { chatId, chat: { ...chatMeta, questions: [] } },
            });

            // Run the chat
            await runChat(chatFile, chatMeta, config);
          });
          break;
        }
        default:
          sendMessage({
            type: 'error',
            data: { message: `Unknown message type: ${(message as any).type}` },
          });
      }
    } catch (error) {
      console.error('WebSocket error:', error);
      sendMessage({
        type: 'error',
        data: { message: error instanceof Error ? error.message : 'Unknown error' },
      });
    }
  });

  ws.on('close', () => {
    connectionRegistry.unregisterConnection(connectionId);
    // Note: Operations continue running even after client disconnects!
  });
}

async function serveLocalFile(url: string, res: http.ServerResponse): Promise<void> {
  try {
    // Parse query string to get path parameter
    const queryStart = url.indexOf('?');
    if (queryStart === -1) {
      res.writeHead(400);
      res.end('Bad request: missing query string');
      return;
    }

    const queryString = url.slice(queryStart + 1);
    const params = new URLSearchParams(queryString);
    const encodedPath = params.get('path');

    if (!encodedPath) {
      res.writeHead(400);
      res.end('Bad request: missing path parameter');
      return;
    }

    // Decode the path
    const filePath = decodeURIComponent(encodedPath);

    // Resolve to absolute path
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

    // Read the file
    const content = await fs.readFile(absolutePath);

    // Determine content type based on file extension
    const ext = path.extname(absolutePath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.htm': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.txt': 'text/plain; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
      // Images
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.bmp': 'image/bmp',
      // Other
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.writeHead(200);
    res.end(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.writeHead(404);
      res.end('File not found');
    } else if ((error as NodeJS.ErrnoException).code === 'EACCES') {
      res.writeHead(403);
      res.end('Access denied');
    } else {
      console.error('Error serving file:', error);
      res.writeHead(500);
      res.end('Internal server error');
    }
  }
}

async function serveStaticFile(url: string, res: http.ServerResponse): Promise<void> {
  // Default to index.html
  if (url === '/' || !url.includes('.')) {
    url = '/index.html';
  }

  // Security: prevent directory traversal
  const distDir = path.resolve(__serverDirname, '../dist-browser');
  const filePath = path.resolve(distDir, url.slice(1));

  // Ensure file is within dist directory
  if (!filePath.startsWith(distDir + path.sep) && filePath !== distDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(filePath);

    // Set content type
    const ext = path.extname(filePath);
    const contentTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };
    const contentType = contentTypes[ext] || 'text/plain';

    res.setHeader('Content-Type', contentType);
    res.writeHead(200);
    res.end(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.writeHead(404);
      res.end('Not found');
    } else {
      throw error;
    }
  }
}

function fireAndForget<T>(promise: Promise<T> | (() => Promise<T>)): void {
  if (typeof promise === 'function') {
    promise = promise();
  }
  promise.catch((error) => {
    console.error('Uncaught error:', error);
  });
}