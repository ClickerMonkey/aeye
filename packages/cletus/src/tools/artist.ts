import { a } from '@aeye/schema';
import { globalToolProperties, type CletusAI } from '../ai';
import { getOperationInput } from '../operations/types';
import { ChartConfigSchema } from '../helpers/artist';

/**
 * Create artist tools for image operations
 * Images are stored in .cletus/images/ and referenced via [filename](filepath) syntax
*/
export function createArtistTools(ai: CletusAI) {
  const imageGenerate = ai.tool({
    name: 'image_generate',
    description: 'Generate one or more images from a text prompt',
    instructions: `Use this to create new images. Generated images are saved to .cletus/images/ and returned as file paths.

Example: Generate a landscape image:
{ "prompt": "A serene mountain landscape at sunset with a lake in the foreground", "n": 1 }
 
{{modeInstructions}}`,
    schema: a.object({
      prompt: a.string().describe('Text description of the image to generate'),
      n: a.number().default(1).describe('Number of images to generate (default: 1)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('image_generate'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'image_generate', input }, ctx),
  });

  const imageEdit = ai.tool({
    name: 'image_edit',
    description: 'Edit an existing image based on a text prompt',
    instructions: `Use this to modify an existing image. Provide a file path (relative or absolute path or[filename](filepath)) and a description of the edit. The edited image will be saved as a new file.

Example: Add a sunset effect to an image:
{ "prompt": "Add warm sunset colors and lighting", "path": "images/photo.jpg" }
 
{{modeInstructions}}`,
    schema: a.object({
      prompt: a.string().describe('Description of how to edit the image'),
      path: a.string().describe('Path to the image to edit (relative path or absolute path or [filename](filepath) URL)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('image_edit'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'image_edit', input }, ctx),
  });

  const imageAnalyze = ai.tool({
    name: 'image_analyze',
    description: 'Analyze one or more images with AI and answer questions',
    instructions: `Use this to understand what's in images or answer specific questions about them. Can analyze multiple images together for comparison.

Example: Compare two designs:
{ "prompt": "What are the main differences between these two UI designs?", "paths": ["designs/v1.png", "designs/v2.png"] }
 
{{modeInstructions}}`,
    schema: a.object({
      prompt: a.string().describe('Question or analysis request about the images'),
      paths: a.array(a.string()).describe('Paths to images to analyze (relative paths or absolute file or [filename](filepath))'),
      maxCharacters: a.number().default(2084).describe('Maximum response length (maxCharacters/4 = maxTokens, default: 2084)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('image_analyze'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'image_analyze', input }, ctx),
  });

  const imageDescribe = ai.tool({
    name: 'image_describe',
    description: 'Get a detailed description of what\'s in an image',
    instructions: `Use this to generate a comprehensive description of an image's contents without a specific question.

Example: Describe a screenshot:
{ "path": "screenshots/dashboard.png" }
 
{{modeInstructions}}`,
    schema: a.object({
      path: a.string().describe('Path to the image to describe (relative path or absolute path or [filename](filepath))'),
      ...globalToolProperties,
    }),
    input: getOperationInput('image_describe'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'image_describe', input }, ctx),
  });

  const imageFind = ai.tool({
    name: 'image_find',
    description: 'Find images matching a description using semantic search',
    instructions: `Use this to search for images in a directory that match a text description. Each image is analyzed and embedded, then compared to the prompt embedding for similarity scoring. This operation can be slow for large numbers of images.

Example: Find images of people in photos:
{ "query": "photos containing people smiling", "glob": "photos/**/*.jpg", "n": 5 }
 
{{modeInstructions}}`,
    schema: a.object({
      query: a.string().describe('Description of what to find in images'),
      glob: a.string().describe('Glob pattern for image files to search (e.g., "**/*.png", "photos/*.jpg")'),
      maxImages: a.number().default(100).describe('Maximum number of images to analyze (default: 100)'),
      n: a.number().default(5).describe('Number of top results to return (default: 5)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('image_find'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'image_find', input }, ctx),
  });

  const imageAttach = ai.tool({
    name: 'image_attach',
    description: 'Attach an image to the chat for the user & AI assistant to see',
    instructions: `Use this to attach an image file to the chat conversation. The image will be added as a user message and displayed in the chat. Accepts both absolute and relative paths.

Example: Attach an image file:
{ "path": "images/diagram.png" }
 
{{modeInstructions}}`,
    schema: a.object({
      path: a.string().describe('Path to the image file to attach (absolute or relative)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('image_attach'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'image_attach', input }, ctx),
  });

  // Chart display schemas - moved outside function and exported above
  
  const chartDisplay = ai.tool({
    name: 'chart_display',
    description: 'Display data as an interactive chart in the browser UI',
    instructions: `Use this to visualize data as a chart. This is browser-only and will display an interactive chart with variant switching capabilities.

Chart groups and their available variants:
- partToWhole: pie, donut, treemap, sunburst (for showing parts of a whole)
- categoryComparison: bar, horizontalBar, pictorialBar (for comparing categories)
- timeSeries: line, area, step, smoothLine (for data over time)
- distribution: histogram, boxplot (for data distribution)
- correlation: scatter, effectScatter, heatmap (for showing relationships)
- ranking: orderedBar, horizontalOrderedBar (for ranked data)
- hierarchical: treemap, sunburst, tree (for hierarchical data)
- flow: sankey, funnel (for flow/process data)
- geospatial: map (for geographic data)
- multivariateComparison: groupedBar, stackedBar, radar, parallel (for comparing multiple variables)

Data format: Provide an array of objects with 'name' and 'value' properties, e.g.:
[{ "name": "Apple", "value": 28 }, { "name": "Samsung", "value": 22 }]

The chart will be displayed in the browser with controls to switch between different variants of the same chart group.

Example: Display market share as a pie chart:
{ "chartGroup": "partToWhole", "title": "Market Share", "data": [{"name": "Apple", "value": 28}, {"name": "Samsung", "value": 22}], "defaultVariant": "pie" }
 
{{modeInstructions}}`,
    schema: a.object({
      chart: ChartConfigSchema,
      ...globalToolProperties,
    }),
    strict: false,
    metadata: { onlyClient: 'browser' },
    input: getOperationInput('chart_display'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'chart_display', input }, ctx),
  });

  const diagramShow = ai.tool({
    name: 'diagram_show',
    description: 'Display a Mermaid diagram in the chat (browser only)',
    instructions: `Use this to render and display Mermaid diagrams in the browser. This tool is browser-only and will render the diagram inline with a clickable preview for full-screen viewing.

Example: Show a flowchart:
{ "spec": "graph TD\\n  A[Start] --> B[Process]\\n  B --> C[End]" }
 
{{modeInstructions}}`,
    schema: a.object({
      spec: a.string().describe('Mermaid diagram specification string'),
      ...globalToolProperties,
    }),
    metadata: { onlyClient: 'browser' },
    input: getOperationInput('diagram_show'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'diagram_show', input }, ctx),
  });

  return [
    imageGenerate,
    imageEdit,
    imageAnalyze,
    imageDescribe,
    imageFind,
    imageAttach,
    chartDisplay,
    diagramShow,
  ] as [
    typeof imageGenerate,
    typeof imageEdit,
    typeof imageAnalyze,
    typeof imageDescribe,
    typeof imageFind,
    typeof imageAttach,
    typeof chartDisplay,
    typeof diagramShow,
  ];
}
