import { adaptiveColor, isLightTerminal, adjustHexForLightMode } from './theme';

/**
 * Get color constants for the Cletus UI based on terminal theme
 */
function getColors() {
  const isLight = isLightTerminal();
  
  return {
    // User colors
    USER: isLight ? adjustHexForLightMode('#9d4edd', 0.5) : '#9d4edd',
    USER_INPUT_BORDER: isLight ? adjustHexForLightMode('#9d4edd', 0.5) : '#9d4edd',
    USER_INPUT_PROMPT: isLight ? adjustHexForLightMode('#9d4edd', 0.5) : '#9d4edd',

    // Assistant colors
    ASSISTANT: adaptiveColor('green', 'green'), // Green works on both

    // System colors
    SYSTEM: adaptiveColor('yellow', '#b8860b'), // Darker yellow for light mode

    // Status indicator colors
    STATUS_USER: isLight ? adjustHexForLightMode('#9d4edd', 0.5) : '#9d4edd',
    STATUS_NO_OPS: adaptiveColor('gray', '#666666'), // Darker gray for light mode
    STATUS_DONE: adaptiveColor('green', 'green'), // Green works on both
    STATUS_ANALYZED: adaptiveColor('yellow', '#b8860b'), // Darker yellow for light mode
    STATUS_IN_PROGRESS: adaptiveColor('rgb(255,165,0)', 'rgb(180,120,0)'), // Darker orange for light mode

    // Menu Gradient
    MENU_GRADIENT: isLight 
      ? [
          adjustHexForLightMode('#9d4edd', 0.5),
          'rgb(0,90,180)',
          'rgb(180,120,0)',
        ]
      : [
          '#9d4edd',
          'rgb(0,128,255)',
          'rgb(255,165,0)',
        ],

    // Operation approval menu colors
    APPROVAL_BORDER: adaptiveColor('yellow', '#b8860b'),
    APPROVAL_SELECTED: adaptiveColor('cyan', 'rgb(0,139,139)'), // Dark cyan for light mode
    APPROVAL_UNSELECTED: adaptiveColor('white', 'black'),

    // Processing states
    PROCESSING_BORDER: adaptiveColor('cyan', 'rgb(0,139,139)'), // Dark cyan for light mode
    PROCESSING_TEXT: adaptiveColor('cyan', 'rgb(0,139,139)'), // Dark cyan for light mode

    // Completion states
    SUCCESS_BORDER: adaptiveColor('green', 'green'),
    SUCCESS_TEXT: adaptiveColor('green', 'green'),
    ERROR_BORDER: adaptiveColor('red', 'red'),
    ERROR_TEXT: adaptiveColor('red', 'red'),

    // Input states
    INPUT_TRANSCRIBING: adaptiveColor('blue', 'rgb(0,0,180)'), // Darker blue for light mode
    INPUT_WAITING: adaptiveColor('gray', '#666666'),
    INPUT_APPROVAL_MENU: adaptiveColor('gray', '#666666'),

    // Markdown colors
    MAKRDOWN_HEADINGS: isLight 
      ? [
          { color: 'rgb(0,139,139)', bold: true }, // Dark cyan
          { color: 'rgb(0,120,120)', bold: true },
          { color: 'rgb(0,100,100)', bold: true },
          { color: 'rgb(0,80,80)', bold: true },
          { color: 'rgb(0,60,60)', bold: true },
          { color: 'rgb(0,40,40)', bold: false },
        ]
      : [
          { color: 'rgb(0,255,255)', bold: true },
          { color: 'rgb(0,210,210)', bold: true },
          { color: 'rgb(0,165,165)', bold: true },
          { color: 'rgb(0,130,130)', bold: true },
          { color: 'rgb(0,95,95)', bold: true },
          { color: 'rgb(0,60,60)', bold: false },
        ],
    MARKDOWN_CODE_BACKGROUND: adaptiveColor('rgb(25,25,25)', 'rgb(240,240,240)'), // Light gray for light mode
    MARKDOWN_LINK: adaptiveColor('rgb(15,101,187)', 'rgb(10,70,130)'), // Darker blue for light mode
    MARKDOWN_BLOCKQUOTE: adaptiveColor('rgb(30,30,30)', 'rgb(235,235,235)'), // Light gray for light mode

    // Other UI elements
    DIM_TEXT: adaptiveColor('gray', '#666666'),
  };
}

/**
 * Color constants for the Cletus UI
 */
export const COLORS = getColors();

/**
 * Type for color values
 */
export type ColorValue = typeof COLORS[keyof typeof COLORS];

/**
 * General constants for Cletus operations
 */
export const CONSTS = {
  SUB_AGENT_CONTEXT_MESSAGES: 10, // Number of recent messages to pass to toolsets
  MAX_CHARACTERS: 64_000,
  MAX_LINES: 1_000,
  MAX_EXTRACTION_CHUNK_SIZE: 64_000, // Maximum size for data extraction to minimize LLM calls
  OPERATION_MESSAGE_TRUNCATE_LIMIT: 1000, // Maximum size for operation messages before truncation
  OPERATION_MESSAGE_TRUNCATE_BUFFER: 200, // Buffer to ensure we don't exceed the truncate limit
} as const;

/**
 * Adaptive tooling constants
 */
export const ADAPTIVE_TOOLING = {
  /** Number of recent user messages to use for embedding-based tool selection */
  USER_MESSAGES_FOR_EMBEDDING: 5,
  /** Number of highest-scoring tools to select in adaptive mode */
  TOP_TOOLS_TO_SELECT: 10,
} as const;

/**
 * Autonomous operation constants
 */
export const AUTONOMOUS = {
  /** Default maximum number of autonomous loop iterations */
  DEFAULT_MAX_ITERATIONS: 10,
  /** Default timeout for autonomous operations in milliseconds (5 minutes) */
  DEFAULT_TIMEOUT_MS: 5 * 60 * 1000,
  /** Minimum allowed iterations */
  MIN_ITERATIONS: 1,
  /** Minimum allowed timeout in milliseconds (1 second) */
  MIN_TIMEOUT_MS: 1000,
  /** Milliseconds per minute for time conversions */
  MS_PER_MINUTE: 60 * 1000,
} as const;

/**
 * Default prompt file names (in order of precedence)
 */
export const DEFAULT_PROMPT_FILES = ['cletus.md', 'agents.md', 'claude.md'] as const;
