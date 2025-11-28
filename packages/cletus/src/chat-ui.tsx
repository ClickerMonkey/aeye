import { Box, Static, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import path from 'path';
import events from 'events'
import React, { useEffect, useRef, useState } from 'react';
import { createCletusAI } from './ai';
import { ChatFile } from './chat';
import { InkAnimatedText } from './components/InkAnimatedText';
import { MessageDisplay } from './components/MessageDisplay';
import { ModelSelector } from './components/ModelSelector';
import { CompletionResult, OperationApprovalMenu } from './components/OperationApprovalMenu';
import { ConfigFile } from './config';
import type { AgentMode, ChatMeta, ChatMode, Message } from './schemas';
import { getTotalTokens } from '@aeye/core';
// @ts-ignore
import mic from 'mic';
import { Writer } from 'wav';
import { createChatAgent } from './agents/chat-agent';
import { runChatOrchestrator } from './agents/chat-orchestrator';
import { COLORS } from './constants';
import { getAltKeyLabel } from './common';
import { fileIsDirectory } from './helpers/files';
import { useAdaptiveDebounce, useSyncedState } from './hooks';
import { logger } from './logger';


interface ChatUIProps {
  chat: ChatMeta;
  config: ConfigFile;
  messages: Message[];
  onExit: () => void;
  onChatUpdate: (updates: Partial<ChatMeta>) => Promise<void>;
}

type CommandType =
  | '/quit'
  | '/help'
  | '/assistant'
  | '/mode'
  | '/model'
  | '/prompt'
  | '/title'
  | '/todos'
  | '/reset'
  | '/done'
  | '/do'
  | '/transcribe'
  | '/cd'
  | '/debug';


interface Command {
  name: CommandType;
  description: string;
  takesInput: boolean;
  optionalInput?: boolean;
  placeholder?: string;
}

const COMMANDS: Command[] = [
  { name: '/help', description: 'Show help information', takesInput: false },
  { name: '/quit', description: 'Exit chat', takesInput: false },
  { name: '/assistant', description: 'Change assistant', takesInput: true, placeholder: 'assistant name' },
  { name: '/mode', description: 'Change mode', takesInput: true, placeholder: 'none|read|create|update|delete' },
  { name: '/model', description: 'Select chat model', takesInput: false },
  { name: '/prompt', description: 'Set custom prompt', takesInput: true, placeholder: 'your prompt' },
  { name: '/title', description: 'Change chat title', takesInput: true, placeholder: 'new title' },
  { name: '/todos', description: 'View todos', takesInput: false },
  { name: '/do', description: 'Add a todo', takesInput: true, placeholder: 'todo description' },
  { name: '/done', description: 'Mark a todo as done', takesInput: true, placeholder: 'todo number' },
  { name: '/reset', description: 'Clear all todos', takesInput: false },
  { name: '/transcribe', description: 'Voice input - requires SoX (ESC or silence to stop)', takesInput: false },
  { name: '/cd', description: 'Change current working directory', takesInput: true, optionalInput: true, placeholder: 'directory path' },
  { name: '/debug', description: 'Toggle debug logging', takesInput: false },
];

const MODETEXT: Record<ChatMode, string> = {
  none: 'local allowed',
  read: 'read allowed',
  create: 'create allowed',
  update: 'update allowed',
  delete: 'delete allowed',
};

const AGENTMODETEXT: Record<AgentMode, string> = {
  default: 'run mode',
  plan: 'plan mode',
};


export const ChatUI: React.FC<ChatUIProps> = ({ chat, config, messages, onExit, onChatUpdate }) => {
  const altKeyLabel = getAltKeyLabel();
  const [inputValue, setInputValue] = useState('');
  const [chatMessages, setChatMessages, getChatMessages] = useSyncedState<Message[]>(messages);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<Message | null>(null);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [showApprovalMenu, setShowApprovalMenu] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [chatMeta, setChatMeta] = useState<ChatMeta>(chat);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [tokenCount, setTokenCount] = useState(0);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [showExitPrompt, setShowExitPrompt] = useState(false);
  const [exitOptionIndex, setExitOptionIndex] = useState(0);
  const [currentStatus, setCurrentStatus] = useState<string>('');
  const [showHelpMenu, setShowHelpMenu] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedInput, setSavedInput] = useState('');
  const [showInput, setShowInput] = useState(config.getData().user.showInput ?? false);
  const [showOutput, setShowOutput] = useState(config.getData().user.showOutput ?? false);
  const [showSystemMessages, setShowSystemMessages] = useState(config.getData().user.showSystemMessages ?? true);
  const [renderKey, setRenderKey] = useState(0);
  const [accumulatedUsage, setAccumulatedUsage] = useState<any>({});
  const [accumulatedCost, setAccumulatedCost] = useState(0);
  const interceptingRef = useRef<boolean>(false);
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const requestStartTimeRef = useRef<number>(0);
  const chatFileRef = useRef<ChatFile>(new ChatFile(chat.id));
  const transcriptionAbortRef = useRef<AbortController | undefined>(undefined);
  const firstMessageRef = useRef<number>(Math.max(0, chatMessages.length - 20));
  const [ai, _] = useState(() => createCletusAI(config));
  const [chatAgent, __] = useState(() => createChatAgent(ai));
  
  // Convenience function to add message
  const addMessage = (message: Message) => {
    // Sets react state value and global value
    setChatMessages((prev) => [...prev, message]);
    // Queue up the save
    saveMessages();
  };

  // Convenience function to update message
  const updateMessage = (message: Message) => {
    // Sets react state value and global value
    setChatMessages((prev) => prev.map((msg) => msg.created === message.created ? message : msg));
    // Queue up the save
    saveMessages();
  };

  // Debounced state
  const [setElapsedTimeDebounced] = useAdaptiveDebounce(setElapsedTime);
  const [setTokenCountDebounced] = useAdaptiveDebounce(setTokenCount);
  const [setCurrentStatusDebounced] = useAdaptiveDebounce(setCurrentStatus);
  const [setAccumulatedUsageDebounced] = useAdaptiveDebounce(setAccumulatedUsage);
  const [setAccumulatedCostDebounced] = useAdaptiveDebounce(setAccumulatedCost);

  // Cached state for rendering & other logic.
  const showPendingMessage = !!(pendingMessage && (pendingMessage.content[0]?.content?.length || pendingMessage.operations?.length));
  const lastAssistantMessage = chatMessages.findLast((msg) => msg.role === 'assistant');
  const operationApprovalPending = showApprovalMenu && !pendingMessage && !!lastAssistantMessage?.operations?.some((op) => op.status === 'analyzed');
  
  // Function to save messages to chat file
  const saveMessages = () => {
    chatFileRef.current.save((chat) => {
      // Use current value to avoid race conditions
      chat.messages = getChatMessages();
    });
  };

  // Clear accumulated usage in AI context
  const clearUsage = () => {
    const defaultContext = ai.config.defaultContext;
    if (defaultContext && defaultContext.usage) {
      defaultContext.usage.accumulated = {};
      defaultContext.usage.accumulatedCost = 0;
    }
    setAccumulatedUsage({});
    setAccumulatedCost(0);
  };

  // Get current accumulated usage from AI context
  const getUsage = () => {
    const defaultContext = ai.config.defaultContext;
    if (defaultContext && defaultContext.usage) {
      return {
        accumulated: defaultContext.usage.accumulated,
        accumulatedCost: defaultContext.usage.accumulatedCost,
      };
    }
    return { accumulated: {}, accumulatedCost: 0 };
  };

  // Convenience function to add system message
  const addSystemMessage = (content: string) => {
    addMessage({ role: 'system', content: [{ type: 'text', content }], created: performance.now() });
  };

  // Load messages from file on mount
  useEffect(() => {
    const loadMessages = async () => {
      const chatFile = chatFileRef.current;
      try {
        await chatFile.load();
        setChatMessages(chatFile.getMessages());
      } catch (error) {
        // File doesn't exist yet or is empty, that's ok
        logger.log('No existing messages to load');
      }
    };

    loadMessages();
  }, []); // Only run on mount

  // Set terminal title
  useEffect(() => {
    process.stdout.write(`\x1b]0;${chatMeta.title}\x07`);
    return () => {
      // Reset title on unmount
      process.stdout.write('\x1b]0;Cletus\x07');
    };
  }, [chatMeta.title]);

  // A handy function to briefly intercept input
  const interceptInput = () => {
    interceptingRef.current = true;
  };
  const interceptingInput = () => {
    const intercepted = interceptingRef.current;
    interceptingRef.current = false;
    return intercepted;
  };

  // Handle keyboard shortcuts
  useInput((input, key) => {
    // Don't handle input when approval menu is showing
    if (operationApprovalPending) {
      return interceptInput();
    }

    if (key.ctrl && input === 'c') {
      if (showExitPrompt) {
        // Cancel the exit prompt if they press Ctrl+C again
        setShowExitPrompt(false);
        setExitOptionIndex(0);
      } else {
        // Show exit prompt
        setShowExitPrompt(true);
        setExitOptionIndex(0);
      }
      return interceptInput();
    }

    // Shift+Enter to add newline
    if (key.shift && key.return) {
      setInputValue(inputValue + '\n');
      return;
    }

    // Alt+T to start/stop transcription
    if (key.meta && input === 't') {
      if (isTranscribing && transcriptionAbortRef.current) {
        // Stop transcription
        transcriptionAbortRef.current.abort();
        setIsTranscribing(false);
      } else if (!isWaitingForResponse && !isTranscribing) {
        // Start transcription
        startTranscription();
      }
      if (inputValue === '') {
        setInputValue('');
      }
      return;
    }

    // Alt+C to cycle through chat modes
    if (key.meta && input === 'c' && !isWaitingForResponse) {
      const modes: ChatMode[] = ['none', 'read', 'create', 'update', 'delete'];
      const currentIndex = modes.indexOf(chatMeta.mode);
      const nextIndex = (currentIndex + 1) % modes.length;
      const newMode = modes[nextIndex];
      onChatUpdate({ mode: newMode });
      setChatMeta({ ...chatMeta, mode: newMode });
      return interceptInput();
    }

    // Alt+M to toggle agent mode
    if (key.meta && input === 'm' && !isWaitingForResponse) {
      const newAgentMode = chatMeta.agentMode === 'plan' ? 'default' : 'plan';
      onChatUpdate({ agentMode: newAgentMode });
      setChatMeta({ ...chatMeta, agentMode: newAgentMode });
      return interceptInput();
    }

    // Alt+I to toggle operation input details
    if (key.meta && input === 'i') {
      const newShowInput = !showInput;
      setShowInput(newShowInput);
      setRenderKey(k => k + 1); // Force re-render of Static content
      config.save((cfg) => {
        cfg.user.showInput = newShowInput;
      });
      return interceptInput();
    }

    // Alt+O to toggle operation output details
    if (key.meta && input === 'o') {
      const newShowOutput = !showOutput;
      setShowOutput(newShowOutput);
      setRenderKey(k => k + 1); // Force re-render of Static content
      config.save((cfg) => {
        cfg.user.showOutput = newShowOutput;
      });
      return interceptInput();
    }

    // Alt+S to toggle system messages visibility
    if (key.meta && input === 's') {
      const newShowSystemMessages = !showSystemMessages;
      setShowSystemMessages(newShowSystemMessages);
      setRenderKey(k => k + 1); // Force re-render of Static content
      config.save((cfg) => {
        cfg.user.showSystemMessages = newShowSystemMessages;
      });
      return interceptInput();
    }

    // Alt+Up to navigate backwards through message history
    if (key.meta && key.upArrow && !isWaitingForResponse && !showCommandMenu && !showHelpMenu && !showExitPrompt) {
      // Extract user messages with text content
      const userMessages = getChatMessages()
        .filter(msg => msg.role === 'user')
        .map(msg => {
          const textContent = msg.content.find(c => c.type === 'text');
          return textContent?.content || '';
        })
        .filter(content => content.length > 0);

      if (userMessages.length === 0) return;

      // Save current input if we're at the bottom of history
      if (historyIndex === -1) {
        setSavedInput(inputValue);
      }

      // Navigate backwards
      const newIndex = historyIndex === -1 ? userMessages.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(newIndex);
      setInputValue(userMessages[newIndex]);
      return;
    }

    // Alt+Down to navigate forwards through message history
    if (key.meta && key.downArrow && !isWaitingForResponse && !showCommandMenu && !showHelpMenu && !showExitPrompt) {
      if (historyIndex === -1) return; // Already at bottom

      // Extract user messages with text content
      const userMessages = getChatMessages()
        .filter(msg => msg.role === 'user')
        .map(msg => {
          const textContent = msg.content.find(c => c.type === 'text');
          return textContent?.content || '';
        })
        .filter(content => content.length > 0);

      // Navigate forwards
      const newIndex = historyIndex + 1;

      if (newIndex >= userMessages.length) {
        // Restore saved input and reset to bottom
        setInputValue(savedInput);
        setHistoryIndex(-1);
        setSavedInput('');
      } else {
        setHistoryIndex(newIndex);
        setInputValue(userMessages[newIndex]);
      }
      return;
    }

    // ESC to interrupt AI or transcription or close help menu
    if (key.escape) {
      if (showHelpMenu) {
        setShowHelpMenu(false);
        setInputValue('');
      } else if (isWaitingForResponse && abortControllerRef.current) {
        abortControllerRef.current.abort();
        setIsWaitingForResponse(false);
        addSystemMessage('⚠️ Response interrupted by user');
        setCurrentStatus('');
        setShowApprovalMenu(false);
      } else if (isTranscribing && transcriptionAbortRef.current) {
        transcriptionAbortRef.current.abort();
        setIsTranscribing(false);
        addSystemMessage('⚠️ Transcription aborted');
        setCurrentStatus('');
        setShowApprovalMenu(false);
      }
    }

    // Handle exit prompt navigation
    if (showExitPrompt) {
      if (key.upArrow) {
        setExitOptionIndex((prev) => (prev > 0 ? prev - 1 : 2));
      } else if (key.downArrow) {
        setExitOptionIndex((prev) => (prev < 2 ? prev + 1 : 0));
      } else if (key.return) {
        setShowExitPrompt(false);
        setExitOptionIndex(0);
        if (exitOptionIndex === 0) {
          // Exit to main menu
          onExit();
        } else if (exitOptionIndex === 1) {
          // Quit application
          process.exit(0);
        }
        // else: Cancel (index 2) - just close the prompt
      } else if (key.escape) {
        // ESC also cancels
        setShowExitPrompt(false);
        setExitOptionIndex(0);
      }
      return;
    }

    // Arrow keys to navigate command menu
    if (showCommandMenu && !isWaitingForResponse) {
      const filteredCommands = inputValue.startsWith('/')
        ? COMMANDS.filter((cmd) => cmd.name.startsWith(inputValue.split(' ')[0]))
        : COMMANDS;

      if (key.upArrow) {
        setSelectedCommandIndex((prev) =>
          prev > 0 ? prev - 1 : filteredCommands.length - 1
        );
      } else if (key.downArrow) {
        setSelectedCommandIndex((prev) =>
          prev < filteredCommands.length - 1 ? prev + 1 : 0
        );
      } else if (key.tab && filteredCommands.length > 0) {
        // Tab to autocomplete the selected command
        const selectedCmd = filteredCommands[selectedCommandIndex];

        if (selectedCmd.takesInput) {
          // Command takes input - autocomplete with space
          const newValue = selectedCmd.name + ' ';
          setInputValue(newValue);
          setShowCommandMenu(false);
          setSelectedCommandIndex(0);
        } else {
          // Command doesn't take input - run it immediately
          handleCommand(selectedCmd.name);
          setInputValue('');
          setShowCommandMenu(false);
          setSelectedCommandIndex(0);
        }
      }
    }
  });

  const handleCommand = async (command: string) => {
    const [cmd, args] = command.split(' ', 2);

    switch (cmd) {
      case '/quit':
        onExit();
        break;

      case '/help':
        addSystemMessage(`🤖 Cletus Chat Help

CHATTING WITH AI:
Simply type your message and press Enter to chat with the AI. The AI can help you with:
• Perform file operations and analysis
• Create and manage custom data types
• Semantically search through data and indexed files
• Generate, edit, and analyze images
• Plan and execute requested work with todos
• Work with assistants & memory

The AI has access to tools and can perform operations based on the chat mode.

CHAT MODES:
• none   - All AI operations require approval (safest)
• read   - Auto-approve read operations
• create - Auto-approve read & create operations
• update - Auto-approve read, create & update operations
• delete - Auto-approve all operations (least safe)

AGENT MODES:
• default - All toolsets available (planner, librarian, clerk, secretary, architect, artist, dba)
• plan    - Only planning related tools available (for focused task management)

AVAILABLE COMMANDS:
/help       - Show this help message
/quit       - Exit the chat
/assistant  - View or change the assistant persona
/mode       - View or change the chat mode
/model      - Select a different AI model for this chat
/prompt     - View or set a custom system prompt
/title      - Change the chat title
/transcribe - Voice input (press ESC or wait for silence to stop)
/todos      - View all todos
/do         - Add a new todo
/done       - Mark a todo as complete
/reset      - Clear all todos
/cd         - Change or view current working directory

KEYBOARD SHORTCUTS:
• Enter       - Send message
• Ctrl+C      - Exit chat
• ESC         - Interrupt AI response or stop transcription
• ${altKeyLabel}+C       - Cycle through chat modes
• ${altKeyLabel}+T       - Start/stop voice transcription
• ${altKeyLabel}+M       - Toggle agent mode (default/plan)
• ${altKeyLabel}+I       - Toggle operation input details
• ${altKeyLabel}+O       - Toggle operation output details
• ${altKeyLabel}+S       - Toggle system messages visibility
• ${altKeyLabel}+↑↓      - Navigate through message history
• Tab         - Autocomplete command (when / menu is open)
• ↑↓          - Navigate command menu (when / menu is open)

TIP: Type '/' to see all available commands with descriptions!`,
        );
        break;

      case '/assistant':
        if (args) {
          const assistant = config.getData().assistants.find((a) => a.name === args);
          if (!assistant) {
            addSystemMessage(`❌ Assistant not found: ${args}`);
            return;
          }
          await onChatUpdate({ assistant: args });
          setChatMeta({ ...chatMeta, assistant: args });
          addSystemMessage(`✓ Assistant changed to: ${args}`);
        } else {
          addSystemMessage(`Current assistant: ${chatMeta.assistant || '(none)'}`);
        }
        break;

      case '/mode':
        if (args && ['none', 'read', 'create', 'update', 'delete'].includes(args)) {
          await onChatUpdate({ mode: args as 'none' | 'read' | 'create' | 'update' | 'delete' });
          setChatMeta({ ...chatMeta, mode: args as 'none' | 'read' | 'create' | 'update' | 'delete' });
          addSystemMessage(`✓ Mode changed to: ${args}`);
        } else {
          addSystemMessage(`Current mode: ${chatMeta.mode}. Valid modes: none, read, create, update, delete`);
        }
        break;

      case '/model':
        setShowModelSelector(true);
        break;

      case '/prompt':
        if (args) {
          await onChatUpdate({ prompt: args });
          setChatMeta({ ...chatMeta, prompt: args });
          addSystemMessage('✓ Custom prompt updated');
        } else {
          addSystemMessage(`Current prompt: ${chatMeta.prompt || '(none)'}`);
        }
        break;

      case '/title':
        if (args) {
          await onChatUpdate({ title: args });
          setChatMeta({ ...chatMeta, title: args });
          addSystemMessage(`✓ Title changed to: ${args}`);
        } else {
          addSystemMessage(`Current title: ${chatMeta.title}`);
        }
        break;

      case '/todos':
        if (chatMeta.todos.length === 0) {
          addSystemMessage('No todos yet');
        } else {
          const todoList = chatMeta.todos
            .map((todo, i) => `${i + 1}. [${todo.done ? '✓' : ' '}] ${todo.name}`)
            .join('\n');
          addSystemMessage(`Todos:\n${todoList}`);
        }
        break;

      case '/do':
        if (args) {
          const newTodo = {
            id: Math.random().toString(36).substring(7),
            name: args,
            done: false,
          };
          const updatedTodos = [...chatMeta.todos, newTodo];
          await onChatUpdate({ todos: updatedTodos });
          setChatMeta({ ...chatMeta, todos: updatedTodos });
          addSystemMessage(`✓ Added todo: ${args}`);
        } else {
          addSystemMessage('❌ Missing todo description. Usage: /do <todo description>');
        }
        break;

      case '/reset':
        await onChatUpdate({ todos: [] });
        setChatMeta({ ...chatMeta, todos: [] });
        addSystemMessage('✓ All todos cleared');
        break;

      case '/done':
        const todoIndex = parseInt(args) - 1;
        if (isNaN(todoIndex) || todoIndex < 0 || todoIndex >= chatMeta.todos.length) {
          addSystemMessage(`Usage: /done <number>. You have ${chatMeta.todos.length} todos.`);
        } else {
          const updatedTodos = [...chatMeta.todos];
          updatedTodos[todoIndex].done = true;
          await onChatUpdate({ todos: updatedTodos });
          setChatMeta({ ...chatMeta, todos: updatedTodos });
          addSystemMessage(`✓ Marked todo as done: ${updatedTodos[todoIndex].name}`);
        }
        break;

      case '/transcribe':
        await startTranscription();
        break;

      case '/cd':
        const cwd = ai.config.defaultContext!.cwd!;
        if (args.trim()) {
          try {
            const resolvedPath = path.resolve(cwd, args);

            const dir = await fileIsDirectory(resolvedPath);

            if (!dir.exists || !dir.isDirectory) {
              addSystemMessage(`❌ Directory does not exist: ${resolvedPath}`);
              return;
            }

            // Change directory
            ai.config.defaultContext!.cwd = resolvedPath;
            addSystemMessage(`✓ Changed directory to: ${resolvedPath}`);
          } catch (error: any) {
            addSystemMessage(`❌ Failed to change directory: ${error.message}`);
          }
        } else {
          addSystemMessage(`Current directory: ${cwd}`);
        }
        break;

      case '/debug':
        await config.save((cfg) => {
          cfg.user.debug = !cfg.user.debug;
        });
        const debugEnabled = config.getData().user.debug;
        logger.setDebug(debugEnabled);
        addSystemMessage(`✓ Debug logging ${debugEnabled ? 'enabled' : 'disabled'}`);
        break;

      default:
        addSystemMessage(`❌ Unknown command: ${cmd}`);
    }
  };

  const startTranscription = async () => {
    if (isTranscribing) {
      addSystemMessage(`⚠️ Already transcribing. Press ESC or ${altKeyLabel}+T to stop.`);
      return;
    }

    setInputValue('');

    // Check if SoX is installed
    try {
      const { execSync } = await import('child_process');
      execSync('sox --version', { stdio: 'pipe' });
    } catch (error) {
      addSystemMessage(`❌ SoX is required for audio transcription but is not installed.

Please install SoX to use voice input:
• Windows: Download from https://sourceforge.net/projects/sox/files/sox/
• Mac: brew install sox
• Linux: sudo apt-get install sox alsa-utils

After installation and the SoX executable is in the path, restart Cletus and try /transcribe again.`
      );
      return;
    }

    try {
      setIsTranscribing(true);
      
      // Create abort controller for this transcription
      const controller = new AbortController();
      transcriptionAbortRef.current = controller;

      addSystemMessage('🎤 Recording... Press ESC to stop or wait for silence.');

      // Get microphone audio stream
      // @ts-ignore
      const micInstance = mic({
        rate: '16000',
        channels: '1',
        bitwidth: '16',
        exitOnSilence: 10, // Stop after 3 seconds of silence
        fileType: 'wav',
      });

      const micInputStream = micInstance.getAudioStream();

      // Collect audio data in memory
      const audioChunks: Buffer[] = [];

      micInputStream.on('data', function(data: Buffer) {
        if (!controller.signal.aborted) {
          audioChunks.push(data);
          logger.log(`Received audio chunk: ${data.length} bytes`);
        }
      });

      micInputStream.on('error', function(err: any) {
        logger.log(`Microphone error: ${err}`);
      });

      micInputStream.on('silence', function() {
        logger.log('Silence detected - stopping recording');
        micInstance.stop();
      });

      // Wait for recording to complete (either ESC or silence)
      const recordingComplete = new Promise<void>((resolve) => {
        micInputStream.on('stopComplete', function() {
          logger.log('Recording stopped');
          resolve();
        });

        controller.signal.addEventListener('abort', () => {
          logger.log('Recording aborted by user');
          micInstance.stop();
        });
      });

      // Start the microphone
      micInstance.start();

      // Wait for recording to finish
      await recordingComplete;

      // if (controller.signal.aborted) {
      //   addSystemMessage('⚠️  Recording cancelled');
      //   return;
      // }

      if (audioChunks.length === 0) {
        addSystemMessage('❌ No audio recorded');
        return;
      }

      // Combine all audio chunks
      const audioBuffer = Buffer.concat(audioChunks);
      logger.log(`Total audio data: ${audioBuffer.length} bytes`);

      // Create WAV file in memory
      const wavWriter = new Writer({
        sampleRate: 16000,
        channels: 1,
        bitDepth: 16
      });

      const wavChunks: Buffer[] = [];
      wavWriter.on('data', (chunk: Buffer) => {
        wavChunks.push(chunk);
      });

      const wavComplete = new Promise<Buffer>((resolve) => {
        wavWriter.on('end', () => {
          resolve(Buffer.concat(wavChunks));
        });
      });

      // Write audio data to WAV encoder
      const wavWriterPromise = new Promise((resolve, reject) => {
        wavWriter.on('error', (e) => e ? reject(e) : resolve(null));
      });
      wavWriter.write(audioBuffer);
      wavWriter.end();
      await wavWriterPromise;

      const wavBuffer = await wavComplete;
      logger.log(`WAV buffer size: ${wavBuffer.length} bytes`);

      addSystemMessage('🔄 Transcribing audio...');

      // Stream transcription from buffer
      const stream = ai.transcribe.stream({
        audio: new File([wavBuffer], 'audio.wav', { type: 'audio/wav' }),
      });

      let transcribedText = '';

      for await (const chunk of stream) {
        logger.log(chunk);

        if (chunk.text) {
          transcribedText += chunk.text;
          setInputValue(transcribedText);
        }
      }

      addSystemMessage('✓ Transcription complete');
      logger.log(`Final transcription: ${transcribedText}`);

    } catch (error: any) {
      addSystemMessage(`❌ Transcription error: ${error.message}`);
      logger.log(`Transcription error: ${error.message} ${error.stack}`);
    } finally {
      setIsTranscribing(false);
      transcriptionAbortRef.current = undefined;
    }
  };

  const handleOperationStart = () => {
    setIsWaitingForResponse(true);
    setElapsedTime(0);
    setCurrentStatus('');
    requestStartTimeRef.current = Date.now();

    // Create abort controller for this request
    const controller = new AbortController();
    events.setMaxListeners(Number.POSITIVE_INFINITY, controller.signal);
    abortControllerRef.current = controller;

    return controller.signal;
  };

  const handleOperation = async (result: CompletionResult | null) => {
    setIsWaitingForResponse(false);
    setShowApprovalMenu(false);
    setCurrentStatus('');
    abortControllerRef.current = undefined;

    logger.log(`operation result: ${JSON.stringify(result)}`);

    if (result && (result.success + result.failed) > 0) {
      handleExecution();
    }
  };

  const handleExecution = async () => {
    setIsWaitingForResponse(true);
    setElapsedTime(0);
    setTokenCount(0);
    setCurrentStatus('');
    setShowApprovalMenu(false);
    requestStartTimeRef.current = Date.now();

    // Create abort controller for this request
    const controller = new AbortController();
    events.setMaxListeners(Number.POSITIVE_INFINITY, controller.signal);
    abortControllerRef.current = controller;

    try {
      logger.log('request starting');

      await runChatOrchestrator(
        {
          chatAgent,
          messages: getChatMessages(),
          chatMeta,
          config,
          chatData: chatFileRef.current,
          signal: controller.signal,
          clearUsage,
          getUsage,
        },
        (event) => {
          if (event.type !== 'elapsed' && event.type !== 'usage' && event.type !== 'pendingUpdate' && event.type !== 'status') {
            logger.log(event);
          }

          switch (event.type) {
            case 'pendingUpdate':
              setPendingMessage({ ...event.pending })
              break;
              
            case 'update':
              updateMessage(event.message);
              break;

            case 'usage':
              setAccumulatedUsageDebounced(event.accumulated);
              setAccumulatedCostDebounced(event.accumulatedCost);
              setTokenCountDebounced(getTotalTokens(event.current));
              break;

            case 'elapsed':
              setElapsedTimeDebounced(event.ms);
              break;

            case 'status':
              setCurrentStatusDebounced(event.status);
              break;

            case 'complete':
              if (event.message.content.length > 0) {
                addMessage(event.message);
              }
              setPendingMessage(null);
              setShowApprovalMenu(true);
              setCurrentStatus('');
              break;

            case 'error':
              addSystemMessage(`❌ Error: ${event.error}`);
              setCurrentStatusDebounced('');
              break;
          }
        }
      );

      logger.log('response complete');

    } catch (error: any) {
      if (error.message !== 'Aborted') {
        addSystemMessage(`❌ Error: ${error.message}`);
      }

      logger.log(`error: ${error.message} ${error.stack}`);
    } finally {
      setIsWaitingForResponse(false);
      setPendingMessage(null);
      setCurrentStatus('');

      abortControllerRef.current = undefined;
    }
  };

  const handleSubmit = async () => {
    if (!inputValue.trim() || isWaitingForResponse) return;

    // Don't submit if help menu is showing
    if (showHelpMenu) {
      setShowHelpMenu(false);
      setInputValue('');
      return;
    }

    // Check if it's a command
    if (inputValue.startsWith('/')) {
      const parts = inputValue.split(' ');
      const cmdName = parts[0];
      const matchingCmd = COMMANDS.find((cmd) => cmd.name === cmdName);

      // If command not found or incomplete, don't execute
      if (!matchingCmd) {
        addSystemMessage(`❌ Unknown command: ${cmdName}. Type / to see available commands.`);
        setInputValue('');
        setShowCommandMenu(false);
        return;
      }

      // If command requires input but none provided, don't execute
      if (matchingCmd.takesInput && parts.length < 2 && !matchingCmd.optionalInput) {
        addSystemMessage(`❌ ${cmdName} requires input: ${matchingCmd.placeholder || 'value'}`);
        return; // Don't clear input, let them continue typing
      }

      // Execute the command
      await handleCommand(inputValue);
      setInputValue('');
      setShowCommandMenu(false);
      return;
    }

    // Add user message
    addMessage({
      role: 'user',
      name: config.getData().user.name,
      content: [{ type: 'text', content: inputValue }],
      created: performance.now(),
    });

    // Reset history navigation
    setHistoryIndex(-1);
    setSavedInput('');
    setInputValue('');

    await handleExecution();
  };

  // Handle input changes and command menu
  const handleInputChange = (value: string) => {
    if (interceptingInput()) {
      return
    }

    setInputValue(value);

    // Show help menu when typing ?
    if (value === '?') {
      setShowHelpMenu(true);
      setShowCommandMenu(false);
      return;
    } else {
      setShowHelpMenu(false);
    }

    // Show command menu when typing /
    if (value === '/' || (value.startsWith('/') && !value.includes(' ', 1))) {
      setShowCommandMenu(true);
      setSelectedCommandIndex(0);
    } else if (!value.startsWith('/')) {
      setShowCommandMenu(false);
      setSelectedCommandIndex(0);
    }
  };

  // Calculate visible area (show last N messages to fit screen)
  const visibleMessages = chatMessages
    .slice(firstMessageRef.current)
    .filter(msg => showSystemMessages || msg.role !== 'system');

  // Render all messages except pending normally
  const lastMessage = visibleMessages.length > 0 
      && visibleMessages[visibleMessages.length - 1].role === 'assistant' 
      && visibleMessages[visibleMessages.length - 1].operations?.some((op) => op.status === 'analyzed')
    ? visibleMessages.pop()
    : null;
  
  // Filter commands based on input
  const filteredCommands = inputValue.startsWith('/')
    ? COMMANDS.filter((cmd) => cmd.name.startsWith(inputValue))
    : COMMANDS;

  // Show model selector if requested
  if (showModelSelector) {
    const currentModelId = chatMeta.model || config.getData().user.models?.chat;

    return (
      <ModelSelector
        ai={ai}
        baseMetadata={{ required: ['chat', 'tools'] }}
        current={currentModelId}
        onSelect={async (model) => {
          if (model) {
            await onChatUpdate({ model: model.id });
            setChatMeta({ ...chatMeta, model: model.id });
            addSystemMessage(`✓ Chat model set to: ${model.name} (${model.id})`);
          }
          setShowModelSelector(false);
        }}
        onCancel={() => {
          setShowModelSelector(false);
        }}
      />
    );
  }

  return (
    <Box flexDirection="column" height="100%" flexGrow={1}>
      
      {/* Messages Area */}
      <Box flexDirection="column" flexGrow={1} marginBottom={1}>
        {visibleMessages.length === 0 && !pendingMessage ? (
          <Box justifyContent="center" alignItems="center" flexGrow={1}>
            <Text dimColor>No messages yet. Type / for commands or start chatting!</Text>
          </Box>
        ) : (
          <>
            <Static key={renderKey} items={visibleMessages}>
              {(msg: Message, i: number) => (
                <MessageDisplay key={i} message={msg} ai={ai} showInput={showInput} showOutput={showOutput}/>
              )}
            </Static>
            {lastMessage && (
              <MessageDisplay message={lastMessage} ai={ai} showInput={showInput} showOutput={showOutput} />
            )}
            {showPendingMessage && (
              <MessageDisplay message={pendingMessage} ai={ai} showInput={showInput} showOutput={showOutput} />
            )}
          </>
        )}
      </Box>

      {/* Exit Prompt */}
      {showExitPrompt && (
        <Box
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          marginBottom={1}
          flexDirection="column"
        >
          <Text bold color="yellow">
            Exit Options (↑↓ to navigate, Enter to select):
          </Text>
          <Box>
            <Text color={exitOptionIndex === 0 ? 'cyan' : 'white'}>
              {exitOptionIndex === 0 ? '▶ ' : '  '}Exit to main menu
            </Text>
          </Box>
          <Box>
            <Text color={exitOptionIndex === 1 ? 'cyan' : 'white'}>
              {exitOptionIndex === 1 ? '▶ ' : '  '}Quit application
            </Text>
          </Box>
          <Box>
            <Text color={exitOptionIndex === 2 ? 'cyan' : 'white'}>
              {exitOptionIndex === 2 ? '▶ ' : '  '}Cancel
            </Text>
          </Box>
        </Box>
      )}

      {/* Command Menu */}
      {showCommandMenu && filteredCommands.length > 0 && (
        <Box
          borderStyle="round"
          borderColor="magenta"
          paddingX={1}
          marginBottom={1}
          flexDirection="column"
        >
          <Text bold color="magenta">
            Commands (↑↓ to navigate, Tab to autocomplete):
          </Text>
          {filteredCommands.slice(0, 8).map((cmd, index) => (
            <Box key={cmd.name}>
              <Text color={index === selectedCommandIndex ? 'cyan' : 'magenta'}>
                {index === selectedCommandIndex ? '▶ ' : '  '}
                {cmd.name}
                {cmd.placeholder && <Text dimColor> &lt;{cmd.placeholder}&gt;</Text>}
              </Text>
              <Text dimColor> - {cmd.description}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Help Menu */}
      {showHelpMenu && (
        <Box
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          marginBottom={1}
          flexDirection="column"
        >
          <Text bold color="cyan">
            Quick Help (ESC to close):
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="cyan">Shortcuts:</Text>
            <Box flexDirection="row" gap={2}>
              <Box flexDirection="column">
                <Text dimColor>Enter: send</Text>
                <Text dimColor>Shift+Enter: newline</Text>
                <Text dimColor>Ctrl+C: exit</Text>
                <Text dimColor>ESC: interrupt</Text>
              </Box>
              <Box flexDirection="column" marginLeft={2}>
                <Text dimColor>{altKeyLabel}+C: cycle chat mode</Text>
                <Text dimColor>{altKeyLabel}+T: transcribe</Text>
                <Text dimColor>{altKeyLabel}+M: toggle agent mode</Text>
                <Text dimColor>{altKeyLabel}+I: toggle inputs</Text>
                <Text dimColor>{altKeyLabel}+O: toggle outputs</Text>
                <Text dimColor>{altKeyLabel}+S: toggle system msgs</Text>
                <Text dimColor>{altKeyLabel}+↑↓: message history</Text>
                <Text dimColor>/: commands  ?: help</Text>
              </Box>
            </Box>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="cyan">Chat Modes:</Text>
            <Box flexDirection="row" gap={2}>
              <Box flexDirection="column">
                <Text dimColor>none: local only</Text>
                <Text dimColor>read: +read ops</Text>
                <Text dimColor>create: +create ops</Text>
              </Box>
              <Box flexDirection="column" marginLeft={2}>
                <Text dimColor>update: +update ops</Text>
                <Text dimColor>delete: +all ops</Text>
                <Text dimColor>(use /mode to change)</Text>
              </Box>
            </Box>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="cyan">Agent Modes:</Text>
            <Box flexDirection="row" gap={2}>
              <Box flexDirection="column">
                <Text dimColor>default: run mode</Text>
                <Text dimColor>plan: plan mode</Text>
              </Box>
              <Box flexDirection="column" marginLeft={2}>
                <Text dimColor>({altKeyLabel}+M to toggle)</Text>
              </Box>
            </Box>
          </Box>
        </Box>
      )}

      {/* Status Display */}
      {currentStatus && (
        <Box>
          <InkAnimatedText text={currentStatus} />
        </Box>
      )}

      {/* Operation Approval Menu */}
      {lastAssistantMessage && showApprovalMenu && (
        <OperationApprovalMenu
          message={lastAssistantMessage}
          ai={ai}
          chatData={chatFileRef.current}
          chatMeta={chat}
          signal={abortControllerRef.current?.signal}
          onMessageUpdate={updateMessage}
          onStart={handleOperationStart}
          onComplete={handleOperation}
          onChatStatus={setCurrentStatusDebounced}
          onUsageUpdate={(accumulated, cost) => {
            setAccumulatedUsage(accumulated);
            setAccumulatedCost(cost);
          }}
        />
      )}

      {/* Input Area */}
      <Box
        borderStyle="round"
        borderColor={isTranscribing 
          ? COLORS.INPUT_TRANSCRIBING 
          : isWaitingForResponse 
            ? COLORS.INPUT_WAITING 
            : operationApprovalPending 
              ? COLORS.INPUT_APPROVAL_MENU 
              : COLORS.USER_INPUT_BORDER}
        paddingX={1}
      >
        <Box width="100%">
          {isTranscribing ? (
            <Text color={COLORS.INPUT_TRANSCRIBING}>🎤 </Text>
          ) : isWaitingForResponse ? (
            <Text color={COLORS.INPUT_WAITING}>{'> '}</Text>
          ) : (
            <Text color={COLORS.USER_INPUT_PROMPT}>{'> '}</Text>
          )}
          <TextInput
            value={inputValue}
            onChange={handleInputChange}
            onSubmit={handleSubmit}
            placeholder={
              isWaitingForResponse
                ? 'Press ESC to interrupt...'
                : 'Type / for commands or your message...'
            }
            showCursor={!isWaitingForResponse && !operationApprovalPending}
            focus={!showExitPrompt && !operationApprovalPending}
          />
        </Box>
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          {chatMeta.assistant ? `${chatMeta.assistant} │ ` : ''}
          {chatMeta.model && chatMeta.model !== config.getData().user.models?.chat ? ` ${chatMeta.model} │ ` : ''}
          {MODETEXT[chatMeta.mode]} │ {AGENTMODETEXT[chatMeta.agentMode || 'default']} │ {chatMeta.toolset ? `${chatMeta.toolset} toolset` : 'adaptive tools'} │ {chatMessages.length} message{chatMessages.length !== 1 ? 's' : ''} │{' '}
          {chatMeta.todos.length ? `${chatMeta.todos.length} todo${chatMeta.todos.length !== 1 ? 's' : ''}` : 'no todos'}
          {accumulatedCost > 0 && (
            <>
              {' │ '}
              <Text color="yellow">
                ${accumulatedCost.toFixed(4)}
              </Text>
            </>
          )}
          {isWaitingForResponse ? (
            <>
              {' │ '}
              <Text color="cyan">
                {(elapsedTime / 1000).toFixed(1)}s
              </Text>
              {' │ '}
              <Text color="green">
                ~{tokenCount >= 1000 ? (tokenCount/1000).toFixed(1) + 'k' : tokenCount.toFixed(0)} tokens
              </Text>
              {' | ESC: interrupt '}
            </>
          ): (
            <>
              {' | Ctrl+C: exit │ ESC: interrupt'}
            </>
          )}
        </Text>
      </Box>
    </Box>
  );
};
