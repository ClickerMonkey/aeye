import { a } from '@aeye/schema';
import { globalToolProperties, type CletusAI } from '../ai';
import { getOperationInput } from '../operations/types';

/**
 * Create internet tools for web operations
 */
export function createInternetTools(ai: CletusAI) {
  const webSearch = ai.tool({
    name: 'web_search',
    description: 'Search the web using Tavily API',
    instructions: `Use this to search the web for information. Returns search results with titles, URLs, and content snippets.
Requires Tavily API key to be configured in settings.

Example: Search for recent AI developments:
{ "query": "recent developments in large language models", "maxResults": 5 }
 
{{modeInstructions}}`,
    schema: a.object({
      query: a.string().describe('Search query'),
      maxResults: a.number().default(5).describe('Maximum number of results to return (default: 5)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('web_search'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'web_search', input }, ctx),
  });

  const webGetPage = ai.tool({
    name: 'web_get_page',
    description: 'Get content from a web page using puppeteer',
    instructions: `Use this to fetch and extract content from a web page. Can return HTML or plain text, optionally filtered by regex, with line range selection.

Example 1: Get plain text from a page:
{ "url": "https://example.com", "type": "text" }

Example 2: Get HTML within specific lines:
{ "url": "https://example.com/docs", "type": "html", "lineStart": 50, "lineEnd": 100 }

Example 3: Search for specific content with regex:
{ "url": "https://example.com", "type": "text", "regex": "price.*\\$[0-9]+", "surrounding": 2 }
 
{{modeInstructions}}`,
    schema: a.object({
      url: a.string().describe('URL of the page to fetch'),
      type: a.enum(['html', 'text']).describe('Content type to return: "html" for raw HTML, "text" for plain text'),
      regex: a.string().optional().describe('Optional regex pattern to search for in content'),
      surrounding: a.number().optional().describe('Number of surrounding lines to include when using regex (default: 0)'),
      lineStart: a.number().optional().describe('Starting line number (1-indexed)'),
      lineEnd: a.number().optional().describe('Ending line number (1-indexed)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('web_get_page'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'web_get_page', input }, ctx),
  });

  const webApiCall = ai.tool({
    name: 'web_api_call',
    description: 'Make REST API calls to external services',
    instructions: `Use this to make HTTP requests to REST APIs. Supports all common HTTP methods, custom headers, and different content types.

Example 1: GET request:
{ "url": "https://api.example.com/data", "method": "GET" }

Example 2: POST request with JSON body:
{ "url": "https://api.example.com/items", "method": "POST", "requestType": "json", "body": "{\\"name\\": \\"Test\\"}" }

Example 3: Request with authentication expecting JSON response:
{ "url": "https://api.example.com/protected", "method": "GET", "headers": {"Authorization": "Bearer ..."}, "responseType": "json" }

Request/Response Types:
- json: Automatically sets/parses JSON content
- text: Plain text (default)
- binary: Base64-encoded binary data
 
{{modeInstructions}}`,
    schema: a.object({
      url: a.string().describe('API endpoint URL'),
      method: a.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).describe('HTTP method'),
      headers: a.record(a.string()).optional().describe('Request headers as key-value pairs'),
      body: a.string().optional().describe('Request body (for POST, PUT, PATCH)'),
      requestType: a.enum(['json', 'text', 'binary']).optional().describe('Request body type (default: text)'),
      responseType: a.enum(['json', 'text', 'binary']).optional().describe('Expected response type (default: text)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('web_api_call'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'web_api_call', input }, ctx),
  });

  const webDownload = ai.tool({
    name: 'web_download',
    description: 'Download a file from a URL to a local path',
    instructions: `Use this to download files from the internet and save them to the local filesystem.

Example 1: Download an image:
{ "url": "https://example.com/image.jpg", "target": "/tmp/downloaded_image.jpg" }

Example 2: Download a file without extension (extension will be auto-detected):
{ "url": "https://example.com/somefile", "target": "/tmp/myfile" }

Example 3: Download to relative path:
{ "url": "https://example.com/document.pdf", "target": "./downloads/document.pdf" }

The operation will:
- Validate the URL is accessible
- Download the file content
- Auto-detect the file extension if not present in the URL or target path
- Save the file to the specified target path
- Return the final path, size, and detected extension

{{modeInstructions}}`,
    schema: a.object({
      url: a.string().describe('URL of the file to download'),
      target: a.string().describe('Target file path where the file should be saved (can be relative or absolute)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('web_download'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'web_download', input }, ctx),
  });

  return [
    webSearch,
    webGetPage,
    webApiCall,
    webDownload,
  ] as [
    typeof webSearch,
    typeof webGetPage,
    typeof webApiCall,
    typeof webDownload,
  ];
}
