import { a } from '@aeye/schema';
import { globalToolProperties, type CletusAI } from '../ai';
import { getOperationInput } from '../operations/types';

/**
 * Create clerk tools for file operations
 * All operations are relative to CWD
 */
export function createClerkTools(ai: CletusAI) {
  const fileSearch = ai.tool({
    name: 'file_search',
    description: 'Search for files using glob patterns',
    instructions: `Use this to find files by pattern. Supports glob syntax like "**/*.ts", "src/**/*.json". Returns up to the specified limit with optional offset for pagination.
This ONLY lists files, it does NOT read their content.

Example: Find all TypeScript files in src directory:
{ "glob": "src/**/*.ts", "limit": 10 }
 
{{modeInstructions}}`,
    schema: a.object({
      glob: a.string().describe('Glob pattern (e.g., "**/*.ts", "src/**/*.json")'),
      limit: a.number().optional().describe('Maximum results (default: 50)'),
      offset: a.number().optional().describe('Starting position for results (default: 0)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('file_search'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'file_search', input }, ctx),
  });

  const fileSummary = ai.tool({
    name: 'file_summary',
    description: 'Generate AI summary of a file',
    instructions: `Use this to get a high-level summary of a file without reading the full content. Supports text files, PDFs, Office docs, and images (with description/transcription).

Example: Summarize a PDF document:
{ "path": "docs/report.pdf", "characterLimit": 32000 }
 
{{modeInstructions}}`,
    schema: a.object({
      path: a.string().describe('Relative file path'),
      limit: a.number().optional().describe('Maximum summary length in characters/lines (default: 64,000 chars or 1000 lines - whatever is smaller)'),
      offset: a.number().optional().describe('Character offset to start summary from (default: 0). This can be a negative number meaning it will start from the end of the file.'),
      limitOffsetMode: a.enum(['characters', 'lines']).optional().describe('Whether limit & offset are in characters or lines (default: "characters")'),
      describeImages: a.boolean().optional().describe('Generate descriptions for images (default: false)'),
      extractImages: a.boolean().optional().describe('Extract images from documents (default: false)'),
      transcribeImages: a.boolean().optional().describe('OCR text from images (default: false)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('file_summary'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'file_summary', input }, ctx),
  });

  const fileIndex = ai.tool({
    name: 'file_index',
    description: 'Index files for semantic search by content or summary',
    instructions: `IMPORTANT: This tool is for BULK INDEXING files to make them semantically searchable in the future. This is NOT for reading or understanding file contents.

⚠️ WARNING - EXPENSIVE OPERATION:
This operation can take a LONG TIME and consume significant resources (API calls, embeddings, storage).
NEVER run this without EXPLICIT USER APPROVAL after showing them:
1. How many files will be indexed
2. The total size of files to be indexed
3. The types of files that will be indexed
4. Estimated time/cost if possible

WORKFLOW REQUIRED:
1. First use file_search to find matching files
2. Show the user the count, types, and sizes
3. Ask for explicit confirmation before proceeding
4. Only then execute the indexing operation

When to use:
- User explicitly asks to "index" files for search
- Setting up semantic search over large collections of files
- Building a searchable knowledge base from multiple documents
- ONLY after user has confirmed they want to proceed

When NOT to use (use file_read instead):
- User asks "what can you tell me about [file]" - just read the file
- Understanding a specific file's content
- Analyzing or examining individual files
- Quick file inspection
- User hasn't explicitly requested indexing

Example 1: Index all markdown files by content:
{ "glob": "**/*.md", "index": "content" }

Example 2: Index images with descriptions:
{ "glob": "images/**/*.jpg", "index": "summary", "describeImages": true }

{{modeInstructions}}`,
    schema: a.object({
      glob: a.string().describe('Glob pattern for files to index'),
      index: a.enum(['content', 'summary']).describe('Index mode: "content" embeds full text in chunks, "summary" embeds AI summary'),
      describeImages: a.boolean().optional().describe('Generate descriptions for images (default: false)'),
      extractImages: a.boolean().optional().describe('Extract images from documents (default: false)'),
      transcribeImages: a.boolean().optional().describe('OCR text from images (default: false)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('file_index'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'file_index', input }, ctx),
  });

  const fileCreate = ai.tool({
    name: 'file_create',
    description: 'Create a new file with content',
    instructions: `Use this to create a new file. Fails if file already exists. Parent directories will be created automatically if needed.

Example: Create a new configuration file:
{ "path": "config/settings.json", "content": "{\\"theme\\": \\"dark\\", \\"fontSize\\": 14}" }
 
{{modeInstructions}}`,
    schema: a.object({
      path: a.string().describe('Relative file path'),
      content: a.string().describe('File content'),
      ...globalToolProperties,
    }),
    input: getOperationInput('file_create'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'file_create', input }, ctx),
  });

  const fileCopy = ai.tool({
    name: 'file_copy',
    description: 'Copy files matching glob pattern to target location',
    instructions: `Use this to duplicate one or more files. If copying multiple files, target must be a directory. Target directories will be created if needed.

Example: Copy all config files to backup directory:
{ "glob": "config/*.json", "target": "backup/config/" }
 
{{modeInstructions}}`,
    schema: a.object({
      glob: a.string().describe('Glob pattern for files to copy'),
      target: a.string().describe('Destination file path or directory'),
      ...globalToolProperties,
    }),
    input: getOperationInput('file_copy'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'file_copy', input }, ctx),
  });

  const fileMove = ai.tool({
    name: 'file_move',
    description: 'Move files matching glob pattern to target',
    instructions: `Use this to move one or more files. Can move to a directory or rename a single file. If moving multiple files, target must be a directory.

Example 1: Rename a single file:
{ "glob": "old-name.ts", "target": "new-name.ts" }

Example 2: Move multiple files into a directory:
{ "glob": "temp/*.log", "target": "archive/" }
 
{{modeInstructions}}`,
    schema: a.object({
      glob: a.string().describe('Glob pattern for files to move'),
      target: a.string().describe('Destination directory or file'),
      ...globalToolProperties,
    }),
    input: getOperationInput('file_move'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'file_move', input }, ctx),
  });

  const fileStats = ai.tool({
    name: 'file_stats',
    description: 'Get file statistics and metadata',
    instructions: `Use this to get metadata about a file (size, timestamps, type, line/character counts for text files).

IMPORTANT: Use this BEFORE reading, editing, or summarizing a file when you need to:
- Determine the appropriate tool based on file type (text, PDF, image, etc.)
- Check file size to decide between file_read vs file_summary
- See line count to know if you need pagination for editing
- Understand file characteristics before processing

For example, if a file is 100K+ characters, you might want to use file_summary instead of file_read, or use limit/offset parameters.

Example: Get stats for a source file:
{ "path": "src/index.ts" }

{{modeInstructions}}`,
    schema: a.object({
      path: a.string().describe('Relative file path'),
      ...globalToolProperties,
    }),
    metadata: { defaultVisible: true },
    input: getOperationInput('file_stats'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'file_stats', input }, ctx),
  });

  const fileDelete = ai.tool({
    name: 'file_delete',
    description: 'Delete a file',
    instructions: `Use this to permanently delete a file. This cannot be undone.

Example: Delete a temporary file:
{ "path": "temp/cache.tmp" }
 
{{modeInstructions}}`,
    schema: a.object({
      path: a.string().describe('Relative file path'),
      ...globalToolProperties,
    }),
    input: getOperationInput('file_delete'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'file_delete', input }, ctx),
  });

  const fileRead = ai.tool({
    name: 'file_read',
    description: 'Read file content',
    metadata: { defaultVisible: true },
    instructions: `Use this to read and understand file contents. This is the PRIMARY tool for examining files. Supports text files, PDFs, Office docs, and images (with description/transcription).

When to use:
- User asks about a specific file ("what can you tell me about X")
- Understanding file contents
- Analyzing code, configuration, or documentation
- Any time you need to see what's in a file

This is fast and efficient - always prefer this over file_index for understanding individual files.

Example: Read a source file:
{ "path": "src/main.ts" }

{{modeInstructions}}`,
    schema: a.object({
      path: a.string().describe('Relative file path'),
      limit: a.number().optional().describe('Maximum summary length in characters/lines (default: 64,000 chars or 1000 lines - whatever is smaller)'),
      offset: a.number().optional().describe('Character offset to start reading from (default: 0). This can be a negative number meaning it will start from the end of the file.'),
      limitOffsetMode: a.enum(['characters', 'lines']).default('characters').describe('Whether limit & offset are in characters or lines (default: "characters")'),
      showLines: a.boolean().optional().describe('Include line numbers in output (default: false)'),
      describeImages: a.boolean().optional().describe('Generate descriptions for images (default: false)'),
      extractImages: a.boolean().optional().describe('Extract images from documents (default: false)'),
      transcribeImages: a.boolean().optional().describe('OCR text from images (default: false)'),
      ...globalToolProperties,
    }),
    
    input: getOperationInput('file_read'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'file_read', input }, ctx),
  });

  const fileEdit = ai.tool({
    name: 'file_edit',
    description: 'Edit a text file using AI-powered content generation',
    instructions: `Use this to edit text files by providing a detailed request describing the changes. The AI will read the current content (with pagination support), generate new content based on your request, and create a unified diff showing exactly what will change.

Only works on text files. The request should be precise with specific rules and instructions. Do not leave out any details, be as explicit as possible. Do not mistranslate any specific user requests.

Example 1: Modify a configuration file:
{ "path": "config/settings.json", "request": "Add a new field 'maxRetries' with value 3, and change 'timeout' from 5000 to 10000" }

Example 2: Edit a specific section of a large file (by line numbers):
{ "path": "src/utils.ts", "request": "Refactor the parseDate function to handle ISO 8601 format", "offset": 100, "limit": 50 }
 
{{modeInstructions}}`,
    schema: a.object({
      path: a.string().describe('Relative file path to edit'),
      request: a.string().describe('Detailed request describing the changes to make. Be precise with rules and requirements.'),
      offset: a.number().optional().describe('Line offset to start editing from (default: 0). Negative numbers start from the end.'),
      limit: a.number().optional().describe('Maximum lines to edit (default: 1000 lines)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('file_edit'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'file_edit', input }, ctx),
  });

  const textSearch = ai.tool({
    name: 'text_search',
    description: 'Search for regex pattern in files',
    metadata: { defaultVisible: true },
    instructions: `Use this to find text patterns across multiple files. Returns matches with surrounding context lines. Supports OCR for images.

The output can be customized to return different formats:
- "file-count": Number of files with matches
- "files": List of files and match count per file
- "match-count": Total number of matches found
- "matches": Detailed match information with context per file

The output can also be paged using the offset parameter. 
That way if an initial file search determines too many files that match the glob, the text search can be called repeatedly with increasing offsets to get all matches. 
It may also be useful if the user doesn't want a comprehensive list of matches, but rather just a sample or to know any exist.
The offset & limit are at the file level assuming the files are sorted by name.

Example: Find all function declarations in TypeScript files:
{ "glob": "src/**/*.ts", "regex": "function \\w+\\(", "caseInsensitive": true, "output": "matches", "surrounding": 2 }
 
{{modeInstructions}}`,
    schema: a.object({
      glob: a.string().describe('Glob pattern for files to search'),
      regex: a.string().describe('Regular expression pattern, EMCA syntax'),
      caseInsensitive: a.boolean().optional().describe('Case insensitive search (default: true)'),
      output: a.enum(['file-count', 'files', 'match-count', 'matches']).optional().describe('Output format (default: "matches")'),
      surrounding: a.number().optional().describe('Lines of context around match (default: 0)'),
      transcribeImages: a.boolean().optional().describe('OCR text from images before searching (default: false). This may be slow and costly so the user should be prompted for permission if not done so yet.'),
      offset: a.number().optional().describe('Starting position for results (default: 0)'),
      limit: a.number().optional().describe('Maximum results (default: 0 = unlimited)'),
      ...globalToolProperties,
    }),
    validate: (input) => {
      try {
        new RegExp(input.regex);
      } catch (error: any) {
        throw new Error(`Invalid regular expression: ${input.regex}`, { cause: error });
      }
    },
    input: getOperationInput('text_search'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'text_search', input }, ctx),
  });

  const dirCreate = ai.tool({
    name: 'dir_create',
    description: 'Create a directory',
    instructions: `Use this to create a directory. Fails if directory already exists. Parent directories will be created automatically.

Example: Create a new feature directory:
{ "path": "src/features/auth" }
 
{{modeInstructions}}`,
    schema: a.object({
      path: a.string().describe('Relative directory path'),
      ...globalToolProperties,
    }),
    input: getOperationInput('dir_create'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'dir_create', input }, ctx),
  });

  const dirSummary = ai.tool({
    name: 'dir_summary',
    description: 'Get a summary of files in a directory to understand its structure',
    metadata: { defaultVisible: true },
    instructions: `Use this to understand the files in the current working directory or a subdirectory. Returns at most ~50 lines describing the directory structure including files, subdirectories, and file extensions.

Example 1: Get summary of current directory:
{ }

Example 2: Get summary of src directory showing all info:
{ "path": "src", "kind": "all", "depth": 5 }

Example 3: List only files in a directory:
{ "path": "lib", "kind": "files" }

Example 4: Get extension counts:
{ "path": ".", "kind": "ext" }
 
{{modeInstructions}}`,
    schema: a.object({
      path: a.string().optional().describe('Relative directory path (defaults to CWD)'),
      kind: a.enum(['files', 'dirs', 'ext', 'all']).optional().describe('Type of summary: files, dirs, ext (extensions), or all (default: all)'),
      depth: a.number().optional().describe('Maximum depth to traverse (default: 10)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('dir_summary'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'dir_summary', input }, ctx),
  });

  const fileAttach = ai.tool({
    name: 'file_attach',
    description: 'Attach a text, audio, or PDF file to the chat for the user & AI assistant to see',
    instructions: `Use this to attach a file to the chat conversation. The file will be added as a user message. Only text, audio, and PDF files are allowed. Path is relative to current working directory.

Example: Attach a document:
{ "path": "documents/report.pdf" }
 
{{modeInstructions}}`,
    schema: a.object({
      path: a.string().describe('Relative path to the text, audio, or PDF file to attach'),
      ...globalToolProperties,
    }),
    input: getOperationInput('file_attach'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'file_attach', input }, ctx),
  });

  const shell = ai.tool({
    name: 'shell',
    description: 'Execute shell commands',
    instructions: `IMPORTANT: This tool should ONLY be used when NO other available tools can accomplish the task. Always prefer using specialized tools (file operations, text search, etc.) over shell commands.

Use this to run shell commands on the system. The command will be executed in the current working directory.
You must only run commands that you know that can be executed safely and in a non-interactive way. Do not run run commands that cannot be run with the 'spawn' function from Node.js child_process module.

SYSTEM INFORMATION:
- Operating System: ${process.platform}
- Architecture: ${process.arch}
- Shell: ${process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')}

The command should be appropriate for the operating system and shell available.

${process.platform === 'win32' 
  ? `Example: List files in current directory:
{ "command": "dir" }

Example: Check disk space:
{ "command": "wmic logicaldisk get size,freespace,caption" }`
  : `Example: List files in current directory:
{ "command": "ls -la" }

Example: Check disk usage:
{ "command": "df -h" }`}

{{modeInstructions}}`,
    schema: a.object({
      command: a.string().describe('Shell command to execute'),
      ...globalToolProperties,
    }),
    input: getOperationInput('shell'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'shell', input }, ctx),
  });

  return [
    fileSearch,
    fileSummary,
    fileIndex,
    fileCreate,
    fileCopy,
    fileMove,
    fileStats,
    fileDelete,
    fileRead,
    fileEdit,
    textSearch,
    dirCreate,
    dirSummary,
    fileAttach,
    shell,
  ] as [
    typeof fileSearch,
    typeof fileSummary,
    typeof fileIndex,
    typeof fileCreate,
    typeof fileCopy,
    typeof fileMove,
    typeof fileStats,
    typeof fileDelete,
    typeof fileRead,
    typeof fileEdit,
    typeof textSearch,
    typeof dirCreate,
    typeof dirSummary,
    typeof fileAttach,
    typeof shell,
  ];
}
