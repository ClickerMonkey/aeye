import * as Diff from 'diff';
import fs from 'fs/promises';
import { glob } from 'glob';
import { Box, Text } from "ink";
import path from 'path';
import React from 'react';
import { CletusAI, describe, summarize, transcribe } from "../ai";
import { abbreviate, chunk, convertNewlines, detectNewlineType, fileProtocol, linkFile, NewlineType, normalizeNewlines, paginateText, pluralize, formatSize } from "../common";
import { Link } from "../components/Link";
import { CONSTS } from "../constants";
import { canEmbed, embed } from "../embed";
import { getAssetPath } from "../file-manager";
import { categorizeFile, fileExists, fileIsDirectory, fileIsReadable, fileIsWritable, isAudioFile, processFile, searchFiles } from "../helpers/files";
import { renderOperation } from "../helpers/render";
import { KnowledgeFile } from "../knowledge";
import { KnowledgeEntry } from "../schemas";
import { operationOf } from "./types";

// Constants for file_attach operation
const ALLOWED_FILE_TYPES = ['text', 'pdf'];

export const file_search = operationOf<
  { glob: string; limit?: number, offset?: number },
  { count: number; files: string[] }
>({
  mode: 'local',
  signature: 'file_search(glob: string, limit?: number, offset?: number)',
  status: (input) => `Searching files: ${input.glob}`,
  async analyze({ input }, { cwd }) { return { analysis: `N/A`, doable: true }; },
  async do({ input }, { cwd, signal }) {
    const limit = input.limit || 50;
    const offset = input.offset || 0;
    const files = await glob(input.glob, { cwd, signal });

    files.sort();

    return { count: files.length, files: files.slice(offset, offset + limit) };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `Files("${op.input.glob}")`,
    (op) => {
      if (op.output) {
        return `Found ${pluralize(op.output.count, 'file')}`;
      }
      return null;
    },
    showInput, showOutput
  ),
});

export const file_summary = operationOf<
  { 
    path: string, 
    limit?: number,
    offset?: number, 
    limitOffsetMode?: 'characters' | 'lines', 
    describeImages?: boolean, 
    extractImages?: boolean, 
    transcribeImages?: boolean,
  },
  { size: number; truncated: boolean; summary: string; fullPath: string }
>({
  mode: 'read',
  signature: 'file_summary(path: string, limit?: number, offset?: number, limitOffsetMode...)',
  status: (input) => `Summarizing: ${paginateText(input.path, 100, -100)}`,
  instructions: 'This is a summary of the file content. The original file content may have specific formatting and whitespace that is not preserved in the summary.',
  analyze: async ({ input }, { cwd }) => {
    const fullPath = path.resolve(cwd, input.path);
    const readable = await fileIsReadable(fullPath);

    if (!readable) {
      return {
        analysis: `This would fail - file ${linkFile(fullPath)} not found or not readable.`,
        doable: false,
      };
    }

    const fileType = await categorizeFile(fullPath, fullPath);
    if (fileType === 'unknown') {
      return {
        analysis: `This would fail - file ${linkFile(fullPath)} is of an unsupported type for summarization.`,
        doable: false,
      };
    }

    const limitOffsetMode = input.limitOffsetMode || 'characters';
    const limit = limitOffsetMode === 'characters'
      ? Math.min(CONSTS.MAX_CHARACTERS, input.limit || CONSTS.MAX_CHARACTERS)
      : Math.min(CONSTS.MAX_LINES, input.limit || CONSTS.MAX_LINES);

    return {
      analysis: `This will read and summarize the ${fileType} file at ${linkFile(fullPath)} (first ${limit.toLocaleString()} ${limitOffsetMode}).`,
      doable: true,
    };
  },
  do: async ({ input }, { cwd, ai, config, signal }) => {
    const fullPath = path.resolve(cwd, input.path);

    const summarized = await processFile(fullPath, input.path, {
      assetPath: await getAssetPath(true),
      sections: false,
      describeImages: input.describeImages ?? false,
      extractImages: input.extractImages ?? false,
      transcribeImages: input.transcribeImages ?? false,
      summarize: true,
      summarizer: (text) => summarize(ai, paginateText(text, input.limit, input.offset, input.limitOffsetMode), signal),
      describer: (image) => describe(ai, image, signal),
      transcriber: (image) => transcribe(ai, image, signal),
      signal,
    });

    const size = summarized.sections.reduce((acc, sec) => acc + (sec?.length || 0), 0);

    return {
      size,
      truncated: size > Math.min(CONSTS.MAX_CHARACTERS, input.limitOffsetMode === 'lines' ? CONSTS.MAX_CHARACTERS : input.limit || CONSTS.MAX_CHARACTERS),
      summary: summarized.description!,
      fullPath,
    };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `Summarize("${paginateText(op.input.path, 100, -100)}")`,
    (op) => {
      if (op.output) {
        return `${linkFile(op.output.fullPath)}: ${abbreviate(op.output.summary, 60)}`;
      }
      return null;
    },
    showInput, showOutput
  ),
});

export const file_index = operationOf<
  { glob: string, index: 'content' | 'summary', describeImages?: boolean, extractImages?: boolean, transcribeImages?: boolean },
  { files: string[], knowledge: number },
  {},
  { indexableFiles: Array<{ file: string; fileType: string }> }
>({
  mode: (input) => input.transcribeImages || input.extractImages || input.describeImages ? 'read' : 'local',
  signature: 'file_index(glob: string, index: "content" | "summary"...)',
  status: (input) => `Indexing files: ${input.glob}`,
  async analyze({ input }, { cwd, signal }) {
    const files = await searchFiles(cwd, input.glob, signal);

    const unreadable = files.filter(f => f.fileType === 'unreadable').map(f => f.file);
    const unknown = files.filter(f => f.fileType === 'unknown').map(f => f.file);
    const indexableFiles = files.filter(f => f.fileType !== 'unknown' && f.fileType !== 'unreadable');

    let doable = indexableFiles.length > 0;
    let analysis = '';
    if (unreadable.length > 0) {
      analysis += `Found ${unreadable.length} unreadable file(s): ${unreadable.join(', ')}\n`;
    }
    if (unknown.length > 0) {
      analysis += `Found ${unknown.length} file(s) of unknown/unsupported format: ${unknown.join(', ')}.\n`;
    }
    analysis += `Found ${indexableFiles.length} indexable file(s).\n`;

    if (indexableFiles.length > 0 && !await canEmbed()) {
      analysis = 'Embedding model is not configured or available.';
      doable = false;
    }

    return { analysis, doable, cache: { indexableFiles } };
  },
  async do({ input, cache }, { cwd, ai, chatStatus, signal }) {
    // Use cached indexable files if available, otherwise search again
    let indexableFiles: Array<{ file: string; fileType: string }>;
    if (cache?.indexableFiles) {
      indexableFiles = cache.indexableFiles;
    } else {
      const files = await searchFiles(cwd, input.glob, signal);
      indexableFiles = files.filter(f => f.fileType !== 'unknown' && f.fileType !== 'unreadable');
    }

    const knowledge: KnowledgeEntry[] = [];

    if (indexableFiles.length === 0) {
      throw new Error('No indexable files found.');
    }

    if (!await canEmbed()) {
      throw new Error('Embedding model is not configured or available.');
    }

    let filesProcessed = 0;
    let filesEmbedded = 0;

    chatStatus(`Indexing ${indexableFiles.length} files...`);

    await Promise.allSettled(indexableFiles.map(async (file) => {
      // Check if cancelled before processing each file
      if (signal?.aborted) {
        throw new Error('Operation cancelled');
      }

      const fullPath = path.resolve(cwd, file.file);

      const parsed = await processFile(fullPath, file.file, {
        assetPath: await getAssetPath(true),
        sections: true,
        describeImages: input.describeImages ?? false,
        extractImages: input.extractImages ?? false,
        transcribeImages: input.transcribeImages ?? false,
        summarize: input.index === 'summary',
        summarizer: (text) => summarize(ai, paginateText(text), signal),
        describer: (image) => describe(ai, image, signal),
        transcriber: (image) => transcribe(ai, image, signal),
        signal,
      });

      filesProcessed++;
      chatStatus(`Parsed/embedded ${filesProcessed}/${filesEmbedded} out of ${indexableFiles.length} files...`);
      
      const getSource = input.index === 'content'
        ? (sectionIndex: number) => `file@${file.file}:chunk[${sectionIndex}]`
        : (_: number) => `file@${file.file}:summary`;
      const chunkables = input.index === 'content' 
        ? parsed.sections 
        : [parsed.description || ''];

      const embeddable = chunkables.filter(s => s && s.length > 0);
      const embeddings = await embed(embeddable, signal) || [];

      knowledge.push(...embeddings.map((vector, index) => ({
        source: getSource(index),
        text: embeddable[index],
        vector: vector,
        created: Date.now()
      })));

    
      filesEmbedded++;
      chatStatus(`Parsed/embedded ${filesProcessed}/${filesEmbedded} out of ${indexableFiles.length} files...`);
    }));

    const knowledgeFile = new KnowledgeFile();
    await knowledgeFile.load();
    await knowledgeFile.addEntries(knowledge);
    
    return {
      files: indexableFiles.map(f => f.file),
      knowledge: knowledge.length,
    };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `Index("${op.input.glob}", ${op.input.index})`,
    (op) => {
      // Use cache for consistent rendering even if files change
      const fileCount = op.cache?.indexableFiles?.length ?? op.output?.files.length;
      if (fileCount !== undefined) {
        const knowledgeCount = op.output?.knowledge;
        if (knowledgeCount !== undefined) {
          return `Indexed **${pluralize(fileCount, 'file')}**, **${pluralize(knowledgeCount, 'knowledge entry', 'knowledge entries')}**`;
        }
        return `Will index **${pluralize(fileCount, 'file')}**`;
      }
      return null;
    }
  , showInput, showOutput),
});

export const file_create = operationOf<
  { path: string; content: string },
  { fullPath: string; size: number, lines: number }
>({
  mode: 'create',
  signature: 'file_create(path: string, content: string)',
  status: (input) => `Creating file: ${paginateText(input.path, 100, -100)}`,
  instructions: 'Preserve content formatting (like whitespace) when creating files. Ensure proper line breaks and indentation are maintained.',
  analyze: async ({ input }, { cwd }) => {
    const fullPath = path.resolve(cwd, input.path);
    const exists = await fileIsReadable(fullPath);

    if (exists) {
      return {
        analysis: `This would fail - file ${linkFile(fullPath)} already exists.`,
        doable: false,
      };
    } 

    const size = input.content.length;
    const lines = input.content.split('\n').length;

    return {
      analysis: `This will create file ${linkFile(fullPath)} with ${size} characters (${lines} lines).`,
      doable: true,
    };
  },
  do: async ({ input }, { cwd }) => {
    const fullPath = path.resolve(cwd, input.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, input.content, 'utf-8');

    const lines = input.content.split('\n').length;

    return { fullPath, size: input.content.length, lines };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `Write("${paginateText(op.input.path, 100, -100)}")`,
    (op) => {
      if (op.output) {
        return `Created ${linkFile(op.output.fullPath)} with **${op.output.size.toLocaleString()}** characters, **${op.output.lines}** lines`;
      }
      return null;
    },
    showInput, showOutput
  ),
});

export const file_copy = operationOf<
  { glob: string; target: string },
  { fullTarget: string, source: string[] },
  {},
  { sourceFiles: Array<{ file: string; fullPath: string; readable: boolean }>; fullTarget: string }
>({
  mode: 'create',
  signature: 'file_copy(glob: string, target: string)',
  status: (input) => `Copying: ${input.glob} → ${paginateText(input.target, 100, -100)}`,
  analyze: async ({ input }, { cwd, signal }) => {
    const source = await glob(input.glob, { cwd, signal });
    const fullTarget = path.resolve(cwd, input.target);
    
    // Build array with full path and readability for each file
    const sourceFiles = await Promise.all(source.map(async (file) => {
      const fullPath = path.resolve(cwd, file);
      const readable = await fileIsReadable(fullPath);
      return { file, fullPath, readable };
    }));

    if (sourceFiles.length === 0) {
      return {
        analysis: `This would fail - no files match pattern "${input.glob}".`,
        doable: false,
      };
    }

    if (sourceFiles.some(f => !f.readable)) {
      return {
        analysis: `This would fail - one or more source files are not readable.`,
        doable: false,
      };
    }

    if (sourceFiles.length > 1) {
      const { isDirectory } = await fileIsDirectory(fullTarget);
      if (!isDirectory) {
        return {
          analysis: `This would fail - target ${linkFile(fullTarget)} must be a directory when copying multiple files.`,
          doable: false,
        };
      }
    } else {
      if (await fileExists(fullTarget)) {
        return {
          analysis: `This would fail - target ${linkFile(fullTarget)} already exists.`,
          doable: false,
        };
      }
    }

    return {
      analysis: sourceFiles.length === 1
        ? `This will copy the file "${sourceFiles[0].file}" to "${input.target}".`
        : `This will copy ${pluralize(sourceFiles.length, 'file')} matching "${input.glob}" to "${input.target}".`,
      doable: true,
      cache: { sourceFiles, fullTarget },
    };
  },
  do: async ({ input, cache }, { cwd, signal }) => {
    // Use cached source files if available, otherwise search again
    const sourceFiles = cache?.sourceFiles ?? await Promise.all(
      (await glob(input.glob, { cwd, signal })).map(async (file) => {
        const fullPath = path.resolve(cwd, file);
        const readable = await fileIsReadable(fullPath);
        return { file, fullPath, readable };
      })
    );
    const fullTarget = cache?.fullTarget ?? path.resolve(cwd, input.target);

    // Verify source files still exist and are readable
    if (sourceFiles.some(f => !f.readable)) {
      throw new Error('One or more source files are no longer readable. State has changed since analysis.');
    }

    await fs.mkdir(path.dirname(fullTarget), { recursive: true });

    await Promise.all(sourceFiles.map(async ({ fullPath, file }) => {
      const targetFilePath = path.join(fullTarget, path.basename(file));
      await fs.copyFile(fullPath, targetFilePath);
    }));

    return { fullTarget, source: sourceFiles.map(f => f.file) };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `Copy("${op.input.glob}", "${op.input.target}")`,
    (op) => {
      // Use cache for consistent rendering
      const count = op.cache?.sourceFiles?.length ?? op.output?.source?.length;
      const fullTarget = op.cache?.fullTarget ?? op.output?.fullTarget;
      if (count !== undefined) {
        return op.output 
          ? `Copied ${pluralize(count, 'file')} to ${fullTarget ? linkFile(fullTarget) : op.input.target}`
          : `Will copy ${pluralize(count, 'file')} to ${fullTarget ? linkFile(fullTarget) : op.input.target}`;
      }
      return null;
    },
    showInput, showOutput
  ),
});

export const file_move = operationOf<
  { glob: string; target: string },
  { targetPath: string, count: number; files: string[] },
  {},
  { files: string[]; targetPath: string }
>({
  mode: 'update',
  signature: 'file_move(glob: string, target: string)',
  status: (input) => `Moving: ${input.glob} → ${paginateText(input.target, 100, -100)}`,
  analyze: async ({ input }, { cwd, signal }) => {
    const files = await glob(input.glob, { cwd, signal });
    const targetPath = path.resolve(cwd, input.target);

    if (files.length === 0) {
      return {
        analysis: `This would fail - no files match pattern "${input.glob}".`,
        doable: false,
      };
    }

    // If moving multiple files, target must be a directory
    if (files.length > 1) {
      try {
        const targetStats = await fs.stat(targetPath);
        if (!targetStats.isDirectory()) {
          return {
            analysis: `This would fail - target ${linkFile(targetPath)} must be a directory when moving multiple files.`,
            doable: false,
          };
        }
      } catch {
        return {
          analysis: `This would fail - target directory ${linkFile(targetPath)} does not exist.`,
          doable: false,
        };
      }
    }

    return {
      analysis: `This will move ${files.length} file(s) matching "${input.glob}" to ${linkFile(targetPath)}.`,
      doable: true,
      cache: { files, targetPath },
    };
  },
  do: async ({ input, cache }, { cwd, chatStatus, signal }) => {
    // Use cached files if available
    const files = cache?.files ?? await glob(input.glob, { cwd, signal });
    const targetPath = cache?.targetPath ?? path.resolve(cwd, input.target);

    if (files.length === 0) {
      throw new Error(`No files match pattern "${input.glob}".`);
    }

    // Verify source files still exist
    const filesExist = await Promise.all(files.map(f => fileIsReadable(path.resolve(cwd, f))));
    if (filesExist.some(e => !e)) {
      throw new Error('One or more source files no longer exist. State has changed since analysis.');
    }

    const targetDirectory = await fileIsDirectory(targetPath);

    const fileToFile = path.extname(targetPath) == path.extname(files[0]);
    if (fileToFile && files.length > 1) {
      throw new Error(`Target "${input.target}" must be a directory when moving multiple files.`);
    }
    if (files.length > 1 && !targetDirectory.isDirectory) {
      throw new Error(`Target "${input.target}" must be a directory when moving multiple files.`);
    }

    let filesMoved = 0;

    if (fileToFile) {
      const targetPathDirectory = path.dirname(targetPath);
      const targetFullPath = targetDirectory.isDirectory 
        ? path.join(targetPath, path.basename(files[0]))
        : targetPath;

      await fs.mkdir(targetPathDirectory, { recursive: true });
      await fs.rename(path.resolve(cwd, files[0]), targetFullPath);

      filesMoved++;
    } else {
      if (!targetDirectory.isDirectory) {
        await fs.mkdir(targetPath, { recursive: true });
      }

      await Promise.allSettled(files.map(async (file) => {
        if (signal?.aborted) {
          throw new Error('Operation cancelled');
        }

        const sourcePath = path.resolve(cwd, file);
        const destPath = path.join(targetPath, file);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.rename(sourcePath, destPath);

        filesMoved++;
        chatStatus(`Moved ${filesMoved}/${files.length} files...`);
      }));
    }

    chatStatus(`Moved ${filesMoved === files.length ? 'all' : filesMoved} files.`);

    return { targetPath, count: files.length, files };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `Move("${op.input.glob}", "${op.input.target}")`,
    (op) => {
      // Use cache for consistent rendering
      const files = op.cache?.files ?? op.output?.files;
      const targetPath = op.cache?.targetPath ?? op.output?.targetPath;
      if (files) {
        const count = files.length;
        return op.output
          ? `Moved ${pluralize(count, 'file')} to ${targetPath ? linkFile(targetPath) : op.input.target}`
          : `Will move ${pluralize(count, 'file')} to ${targetPath ? linkFile(targetPath) : op.input.target}`;
      }
      return null;
    },
    showInput, showOutput
  ),
});

export const file_stats = operationOf<
  { path: string },
  { fullPath: string, size: number; created: string; modified: string; accessed: string, type: string, mode: number, lines?: number, characters?: number }
>({
  status: (input) => `Getting stats: ${paginateText(input.path, 100, -100)}`,
  mode: 'local',
  signature: 'file_stats(path: string)',
  analyze: async ({ input }, { cwd }) => {
    const fullPath = path.resolve(cwd, input.path);
    const fileExists = await fileIsReadable(fullPath);

    if (!fileExists) {
      return {
        analysis: `This would fail - path ${linkFile(fullPath)} not found or readable.`,
        doable: false,
      };
    }

    return {
      analysis: `This will get file statistics for ${linkFile(fullPath)}.`,
      doable: true,
    };
  },
  do: async ({ input }, { cwd }) => {
    const fullPath = path.resolve(cwd, input.path);
    const stats = await fs.stat(fullPath);

    const contentType = await categorizeFile(fullPath, input.path);
    let lines: number | undefined = undefined;
    let characters: number | undefined = undefined;

    if (contentType === 'text') {
      const file = await fs.readFile(fullPath, 'utf-8');
      characters = file.length;
      lines = file.split('\n').length;
    }
    
    const typeAnalysis = [
      [stats.isDirectory(), 'directory' ],
      [stats.isFile(), contentType ],
      [stats.isBlockDevice(), 'block-device' ],
      [stats.isCharacterDevice(), 'character-device' ],
      [stats.isSymbolicLink(), 'symlink' ],
      [stats.isFIFO(), 'fifo' ],
      [stats.isSocket(), 'socket' ],
    ] as const;

    const type = typeAnalysis.find(([is]) => is)?.[1] || 'unknown'

    return {
      fullPath,
      size: stats.size,
      created: stats.birthtime.toISOString(),
      modified: stats.mtime.toISOString(),
      accessed: stats.atime.toISOString(),
      mode: stats.mode,
      type,
      lines,
      characters
    };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `FileStats("${paginateText(op.input.path, 100, -100)}")`,
    (op) => {
      if (op.output) {
        const sizeKB = (op.output.size / 1024).toFixed(1);
        return `${linkFile(op.output.fullPath)}: **${op.output.type}**, **${sizeKB} KB**${op.output.lines ? `, **${op.output.lines}** lines` : ''}`;
      }
      return null;
    },
    showInput, showOutput
  ),
});

export const file_delete = operationOf<
  { path: string },
  { deleted: boolean }
>({
  mode: 'delete',
  signature: 'file_delete(path: string)',
  status: (input) => `Deleting: ${paginateText(input.path, 100, -100)}`,
  analyze: async ({ input }, { cwd }) => {
    const fullPath = path.resolve(cwd, input.path);

    const deletable = await fileIsWritable(fullPath);
    if (!deletable) {
      return {
        analysis: `This would fail - ${linkFile(fullPath)} is not a file that can be deleted.`,
        doable: false,
      };
    }
    return {
      analysis: `This will delete the file ${linkFile(fullPath)}.`,
      doable: true,
    };
  },
  do: async ({ input }, { cwd }) => {
    const fullPath = path.resolve(cwd, input.path);
    await fs.unlink(fullPath);

    return { deleted: true };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `Delete("${paginateText(op.input.path, 100, -100)}")`,
    (op) => {
      if (op.output) {
        return `Deleted ${op.input.path}`;
      }
      return null;
    },
    showInput, showOutput
  ),
});

export const file_read = operationOf<
  { path: string, limit?: number, offset?: number, limitOffsetMode?: 'lines' | 'characters', describeImages?: boolean, extractImages?: boolean, transcribeImages?: boolean, showLines?: boolean },
  { fullPath: string; content: string; truncated: boolean }
>({
  mode: 'read',
  signature: 'file_read(path: string, limit?: number, offset?: number, limitOffsetMode...)',
  status: (input) => `Reading: ${paginateText(input.path, 100, -100)}`,
  instructions: 'Preserve content formatting (like whitespace) to present it clearly (like at the beginning of the line).',
  analyze: async ({ input }, { cwd }) => {
    const fullPath = path.resolve(cwd, input.path);
    const readable = await fileIsReadable(fullPath);

    if (!readable) {
      return {
        analysis: `This would fail - file ${linkFile(fullPath)} not found or not readable.`,
        doable: false,
      };
    }

    const type = await categorizeFile(fullPath, input.path);
    if (type === 'unknown') {
      return {
        analysis: `This would fail - file ${linkFile(fullPath)} is of an unsupported type for reading.`,
        doable: false,
      };
    }

    const limitOffsetMode = input.limitOffsetMode || 'characters';
    const limit = limitOffsetMode === 'characters'
      ? Math.min(CONSTS.MAX_CHARACTERS, input.limit || CONSTS.MAX_CHARACTERS)
      : Math.min(CONSTS.MAX_LINES, input.limit || CONSTS.MAX_LINES);

    const withLines = input.showLines ? ' with line numbers' : '';

    return {
      analysis: `This will read the ${type} file ${linkFile(fullPath)} (first ${limit.toLocaleString()} ${limitOffsetMode})${withLines}.`,
      doable: true,
    };
  },
  do: async ({ input }, { cwd, ai, signal }) => {
    const fullPath = path.resolve(cwd, input.path);
    const limitOffsetMode = input.limitOffsetMode || 'characters';

    const readable = await fileIsReadable(fullPath);

    if (!readable) {
      throw new Error(`File "${input.path}" not found or not readable.`);
    }

    const type = await categorizeFile(fullPath, input.path);
    if (type === 'unknown') {
      throw new Error(`File "${input.path}" is of an unsupported type for reading.`);
    }

    const processed = await processFile(fullPath, input.path, {
      assetPath: await getAssetPath(true),
      sections: false,
      describeImages: input.describeImages ?? false,
      extractImages: input.extractImages ?? false,
      transcribeImages: input.transcribeImages ?? false,
      summarize: false,
      describer: (image) => describe(ai, image, signal),
      transcriber: (image) => transcribe(ai, image, signal),
      signal,
    });

    let content = processed.sections.join('\n');

    // Add line numbers if requested
    if (input.showLines && content.length > 0) {
      const lines = content.split('\n');
      const maxLineNumWidth = lines.length.toString().length;
      content = lines
        .map((line, index) => {
          const lineNum = (index + 1).toString().padStart(maxLineNumWidth, ' ');
          return `${lineNum} | ${line}`;
        })
        .join('\n');
    }

    content = paginateText(content, input.limit, input.offset, limitOffsetMode);

    return {
      fullPath,
      content: content,
      truncated: content.length === Math.min(CONSTS.MAX_CHARACTERS, input.limitOffsetMode === 'lines' ? CONSTS.MAX_CHARACTERS : input.limit || CONSTS.MAX_CHARACTERS),
    };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `Read("${paginateText(op.input.path, 100, -100)}")`,
    (op) => {
      if (op.output) {
        const params: string[] = [];

        // Add limit/offset info if non-default
        const limitOffsetMode = op.input.limitOffsetMode || 'characters';
        const defaultLimit = limitOffsetMode === 'characters' ? CONSTS.MAX_CHARACTERS : CONSTS.MAX_LINES;
        if (op.input.limit && op.input.limit !== defaultLimit) {
          params.push(`limit=${op.input.limit} ${limitOffsetMode}`);
        }
        if (op.input.offset) {
          params.push(`offset=${op.input.offset}`);
        }
        if (op.input.limitOffsetMode && op.input.limitOffsetMode !== 'characters') {
          params.push(`mode=${op.input.limitOffsetMode}`);
        }

        // Add boolean flags if enabled
        if (op.input.showLines) params.push('lines');
        if (op.input.describeImages) params.push('describe');
        if (op.input.extractImages) params.push('extract');
        if (op.input.transcribeImages) params.push('transcribe');

        const paramsStr = params.length > 0 ? ` (${params.join(', ')})` : '';
        return `Read ${linkFile(op.output.fullPath)}: **${op.output.content.length.toLocaleString()}** characters${op.output.truncated ? ' *(truncated)*' : ''}${paramsStr}`;
      }
      return null;
    },
    showInput, showOutput
  ),
});

type FileEditInput = {
  path: string;
  request: string;
  offset?: number;
  limit?: number;
}

type FileEditResult = {
  insertStart?: number;
  insertEnd?: number;
  insert?: string;
  lastModified: number;
  changed: boolean;
  diff: string;
  originalNewlineType: NewlineType;
}

export const file_edit = operationOf<
  FileEditInput,
  string,
  { 
    diff: (
      input: FileEditInput,
      fileContent: string,
      lastModified: number,
      ai: CletusAI,
      signal?: AbortSignal
    ) => Promise<FileEditResult>; 
  },
  FileEditResult
>({
  mode: 'update',
  signature: 'file_edit(path: string, request: string, offset?: number, limit?: number)',
  status: (input) => `Editing: ${paginateText(input.path, 100, -100)}`,
  instructions: 'Do NOT show the diff to the user, it will be rendered separately.',
  async diff(
    input: FileEditInput,
    fileContent: string,
    lastModified: number,
    ai: CletusAI,
    signal?: AbortSignal
  ): Promise<FileEditResult> {
    // Detect and normalize newlines for consistent processing
    const originalNewlineType = detectNewlineType(fileContent);
    const normalizedContent = normalizeNewlines(fileContent);

    // Paginate the text if offset/limit are provided (lines only)
    const paginatedContent = paginateText(normalizedContent, input.limit, input.offset, 'lines');

    // Use AI to generate new content based on the request
    const models = ai.config.defaultContext!.config!.getData().user.models;
    const model = models?.edit || models?.chat;

    const response = await ai.chat.get({
      model,
      messages: [
        {
          role: 'system',
          content: `You are a helpful assistant that edits file content. You will receive the current content and a request describing the changes. Respond with ONLY the new content, nothing else - no explanations, no markdown formatting, just the raw edited content.
          <request>${input.request}</request>`
        },
        {
          role: 'user',
          content: paginatedContent,
        },
      ],
    }, {
      signal,
      metadata: {
        contextWindow: { min: (paginatedContent.length / 4) + (input.request.length / 4) + 2000 },
      }
    });

    // Normalize AI response to ensure consistent LF newlines
    const newPaginatedContent = normalizeNewlines(response.content);

    // Apply the changes to the full file content by replacing the paginated section
    const paginatedIndex = normalizedContent.indexOf(paginatedContent);
    const newNormalizedContent = normalizedContent.slice(0, paginatedIndex) + newPaginatedContent + normalizedContent.slice(paginatedIndex + paginatedContent.length);

    // Generate unified diff to show what will be changed (using normalized content)
    const diff = Diff.createPatch(
      input.path,
      normalizedContent,
      newNormalizedContent,
      'before',
      'after',
      { 
        ignoreWhitespace: true, 
        stripTrailingCr: true, 
        context: 3,
      },
    );

    const changed = normalizedContent !== newNormalizedContent;

    // Only include insert/insertStart/insertEnd if there are actual changes
    // This avoids storing entire file contents in chat JSON when nothing changed
    return {
      diff,
      lastModified,
      changed,
      ...(changed ? {
        insert: newPaginatedContent,
        insertStart: paginatedIndex,
        insertEnd: paginatedIndex + paginatedContent.length,
      } : {}),
      originalNewlineType,
    };
  },
  async analyze({ input }, { cwd, ai, signal }) {
    const fullPath = path.resolve(cwd, input.path);
    const readable = await fileIsReadable(fullPath);

    if (!readable) {
      return {
        analysis: `This would fail - file ${linkFile(fullPath)} not found or not readable.`,
        doable: false,
      };
    }

    const writable = await fileIsWritable(fullPath);
    if (!writable) {
      return {
        analysis: `This would fail - file ${linkFile(fullPath)} is not writable.`,
        doable: false,
      };
    }

    const type = await categorizeFile(fullPath, input.path);
    if (type !== 'text') {
      return {
        analysis: `This would fail - file ${linkFile(fullPath)} is not a text file (type: ${type}).`,
        doable: false,
      };
    }

    // Read the file content and generate diff in analyze phase
    const fileContent = await fs.readFile(fullPath, 'utf-8');
    const fileStats = await fs.stat(fullPath);
    const result = await this.diff(input, fileContent, fileStats.mtimeMs, ai, signal);

    return {
      analysis: result.changed ? result.diff : 'No changes needed.',
      doable: result.changed,
      cache: result,
    };
  },
  async do({ input, cache }, { cwd, ai, signal }) {
    const fullPath = path.resolve(cwd, input.path);

    const fileContent = await fs.readFile(fullPath, 'utf-8');
    const lastModified = await fs.stat(fullPath).then(s => s.mtimeMs);

    // Retrieve diff from analyze phase if available
    const result = cache || await this.diff(input, fileContent, lastModified, ai, signal);

    // Prevent overwriting changes if file was modified since analysis
    if (result.lastModified !== lastModified) {
      throw new Error(`File "${input.path}" was modified since analysis. Aborting edit to prevent overwriting changes.`);
    }

    // Only write file if there are actual changes
    if (result.changed && result.insert !== undefined && result.insertStart !== undefined && result.insertEnd !== undefined) {
      // Normalize file content for consistent processing with cached result
      const normalizedContent = normalizeNewlines(fileContent);

      // Build new content using normalized data and cached insert positions
      const newNormalizedContent = ''
        + normalizedContent.slice(0, result.insertStart)
        + result.insert
        + normalizedContent.slice(result.insertEnd);

      // Convert back to original newline type
      const newFileContent = convertNewlines(newNormalizedContent, result.originalNewlineType);

      // Write the new content back to the file
      await fs.writeFile(
        fullPath, 
        newFileContent, 
        { encoding: 'utf-8', signal }
      );
    }

    return {
      output: result.diff,
      cache: result,
    };
  },
  render: (op, ai, showInput) => renderOperation(
    op,
    `Edit("${paginateText(op.input.path, 100, -100)}")`,
    (op) => {
      // Check if there are no changes to apply
      if (op.cache?.changed === false) {
        return (
          <Box flexDirection="row">
            <Text>{'   → '}</Text>
            <Text>No changes</Text>
          </Box>
        );
      }

      // diff format:
      // Index: [filename]
      // ===================================================================
      // --- [filename]     before
      // +++ [filename]     after
      // @@ -old_index,old_lines +new_index,new_lines @@
      // [+- ]line
      // \ ignore
      const lineStyles = {
        '+': { backgroundColor: 'rgb(46, 121, 46)' },
        '-': { backgroundColor: 'rgb(96, 21, 21)' },
        ' ': {},
      } as const;

      // render format:
      // [gray line number] [+- ] content
      // ... divider
      let additions = 0;
      let subtractions = 0;
      const diff = op.cache?.diff || op.output || op.analysis || '';
      const diffLines = diff.split('\n');
      const relevantLines = diffLines.slice(4).filter(line => !line.startsWith('\\'));
      const changeSetLines = chunk(relevantLines, (_, line) => line.startsWith('@@'));
      const changeSets = changeSetLines.map((setLines, setLinesIndex) => {
        const [, lineStartText, lineCountText] = /^@@ -\d+,\d+ \+(\d+),(\d+) @@$/.exec(setLines[0]) || [];
        const lineStart = parseInt(lineStartText, 10);
        const lineCount = parseInt(lineCountText, 10);
        const linePadding = (lineStart + lineCount).toString().length + 1;
        const lines = setLines.slice(1);
        const lineNumbers: string[] = [];
        let currentLineNumber = lineStart;
        let removed = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith('-')) {
            removed++;
            subtractions++;
          } else if (line.startsWith('+')) {
            currentLineNumber -= removed;
            removed = 0;
            additions++;
          }
          lineNumbers.push(currentLineNumber.toFixed(0).padStart(linePadding, ' '));
          currentLineNumber++;
        }
        // Trim empty lines at start and end
        while (lines.length > 0 && lines[0].trim() === '') {
          lines.shift();
          lineNumbers.shift();
        }
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
          lines.pop();
          lineNumbers.pop();
        }

        return (
          <Box flexDirection="column" key={setLinesIndex}>
            {lines.map((line, lineIndex) => (
              <Box key={lineIndex} flexDirection="row">
                <Text color="gray">{lineNumbers[lineIndex]} </Text>
                <Text {...lineStyles[line[0] as '+' | '-' | ' ']}>
                  {line}
                </Text>
              </Box>
            ))}
          </Box>
        );
      });

      const changeSetsGrouped = changeSets.map((set, index) => (
        <React.Fragment key={index}>
          {index > 0 && (<Box><Text>...</Text></Box>)}
          {set}
        </React.Fragment>
      ));

      const fullPath = path.resolve(ai.config.defaultContext!.cwd!, op.input.path);
      const url = fileProtocol(fullPath);

      const boxStyle = op.output
        ? {}
        : op.status === 'rejected'
          ? { borderStyle: 'round', borderColor: 'gray' } as const
          : { borderStyle: 'round', borderColor: lineStyles['+'].backgroundColor } as const;

      return (
        <Box {...boxStyle} flexDirection="column" flexGrow={1}>
          <Box marginLeft={2} flexGrow={1}>
            <Text>{'→ '}</Text>
            <Text>{op.output ? 'Updated ' : op.analysis ? 'Edit ' : 'Analyzing '}</Text>
            <Link url={url}>{op.input.path}</Link>
            {diff && (
              <Text> with {pluralize(additions, 'addition')} and {pluralize(subtractions, 'removal')}</Text>
            )}
          </Box>
          {changeSetsGrouped}
        </Box>
      );
    },
    showInput,
    false,
  ),
});

export const text_search = operationOf<
  { glob: string; regex: string; surrounding?: number, transcribeImages?: boolean, caseInsensitive?: boolean, output?: 'file-count' | 'files' | 'match-count' | 'matches', offset?: number, limit?: number },
  { searched?: number, fileCount?: number; files?: Array<{ file: string; matches: number }>, matchCount?: number, matches?: Array<{ file: string, matches: string[] }> },
  {},
  { searchableFiles: Array<{ file: string; fileType: string }> }
>({
  mode: (input) => input.transcribeImages ? 'read' : 'local',
  signature: 'text_search(glob: string, regex: string, surrounding?: number, ...)',
  status: (input) => `Searching text: ${abbreviate(input.regex, 35)}`,
  analyze: async ({ input }, { cwd, signal }) => {
    const surrounding = input.surrounding || 0;
    const files = await searchFiles(cwd, input.glob, signal);

    if (files.length === 0) {
      return {
        analysis: `This would search 0 files matching "${input.glob}" - no files match the pattern.`,
        doable: true,
        cache: { searchableFiles: [] },
      };
    }

    const searchableFiles = files.filter(f => f.fileType !== 'unreadable' && f.fileType !== 'unknown');
    if (searchableFiles.length === 0) {
      return {
        analysis: `This would search 0 files matching "${input.glob}" - no readable files of supported types found.`,
        doable: true,
        cache: { searchableFiles: [] },
      }
    }

    // TODO update analysis to reflect case insensitivity, limit, & offset

    return {
      analysis: `This will search ${searchableFiles.length} file(s)${files.length !== searchableFiles.length ? ` (of ${files.length} total files)` : ``} for ${input.output || 'matches'} matching "${input.glob}" for pattern "${input.regex}" with ${surrounding} surrounding lines.`,
      doable: true,
      cache: { searchableFiles },
    };
  },
  do: async ({ input, cache }, { cwd, ai, chatStatus, signal }) => {
    // Use cached searchable files if available, otherwise search again
    const readable = cache?.searchableFiles ?? (await searchFiles(cwd, input.glob)).filter(f => f.fileType !== 'unreadable' && f.fileType !== 'unknown');

    if (readable.length === 0) {
      return { searched: 0 };
    }

    readable.sort((a, b) => a.file.localeCompare(b.file));

    const output = input.output || 'matches';
    const limit = input.limit || 0;
    const offset = input.offset || 0;
    const pattern = new RegExp(input.regex, input.caseInsensitive !== false ? 'gi' : 'g');
    const surrounding = input.surrounding || 0;

    let filesProcessed = 0;
    chatStatus(`Searching ${readable.length} files...`);

    const results = await Promise.allSettled(readable.map(async (file) => {
      // Check if cancelled before processing each file
      if (signal?.aborted) {
        throw new Error('Operation cancelled');
      }

      const fullPath = path.resolve(cwd, file.file);
      const processed = await processFile(fullPath, file.file, {
        assetPath: await getAssetPath(true),
        sections: false,
        describeImages: false,
        extractImages: false,
        summarize: false,
        transcribeImages: input.transcribeImages ?? false,
        transcriber: (image) => transcribe(ai, image, signal),
        signal,
      });

      filesProcessed++;
      chatStatus(`Searched ${filesProcessed}/${readable.length} files...`);

      type Section = {
        start: number;
        end: number;
        lines: Map<number, number>;
      }

      const content = processed.sections.join('\n');
      const lines = content.split('\n');
      const sections: Section[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          const start = Math.max(0, i - surrounding);
          const end = Math.min(lines.length, i + surrounding + 1);
          sections.push({ start, end, lines: new Map<number, number>([[i, 1]]) });

          if (output === 'file-count') {
            break;
          }
        }
      }

      if (output !== 'matches') {
        return {
          file: file.file,
          matchCount: sections.length,
          matches: [],
        };
      }

      const joinedSections: Section[] = [];
      let currentSection: Section | null = null;
      for(const section of sections) {
        if (currentSection === null || section.start >= currentSection.end) {
          currentSection = section;
          joinedSections.push(currentSection);
        } else {
          currentSection.end = section.end;
          for (const [line, count] of section.lines) {
            currentSection.lines.set(line, (currentSection.lines.get(line) || 0) + count);
          }
        }
      }

      return {
        file: file.file,
        matchCount: sections.length,
        matches: joinedSections.map(sec => {
          const lineCountSpaces = (sec.end + 1).toString().length;
          const sectionLines = lines.slice(sec.start, sec.end);

          const formattedLines = sectionLines.map((line, i) => {
            const hasMatches = sec.lines.has(i + sec.start);
            const lineNumber = (i + sec.start + 1).toString().padStart(lineCountSpaces, ' ');
            const matchIndicator = hasMatches ? '→' : ' ';
            const formattedLine = `${matchIndicator} ${lineNumber} | ${line}`;

            if (!hasMatches) {
              return formattedLine;
            }

            // Reset regex lastIndex for global flags
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            let matchLine = '';
            while ((match = pattern.exec(line)) !== null) {
              matchLine += ' '.repeat(match.index - matchLine.length) + '^'.repeat(match[0].length);
              if (!pattern.global) break;
            }
            if (matchLine === '') {
              return formattedLine;
            }

            const formattedMatchLine = ' '.repeat(lineCountSpaces + 5) + matchLine;

            return formattedLine + '\n' + formattedMatchLine;
          });

          return formattedLines.join('\n');
        }),
      };
    }));

    const successful = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const withMatches = successful.filter(r => r.matchCount > 0);

    chatStatus(`Searched ${successful.length === results.length ? 'all' : `${successful.length}/${results.length}`} files, ${withMatches} files with matches.`);

    switch (output) {
      case 'file-count':
        return { searched: results.length, fileCount: withMatches.length };
      case 'files':
        return { searched: results.length, files: withMatches.map(r => ({ file: r.file, matches: r.matchCount })) };
      case 'match-count':
        return { searched: results.length, matchCount: withMatches.reduce((acc, r) => acc + r.matchCount, 0) };
      case 'matches':
      default:
        const pagedResults = limit > 0 ? withMatches.slice(offset, offset + limit) : withMatches.slice(offset);
        return { searched: results.length, matches: pagedResults.map(r => ({ file: r.file, matches: r.matches })) };
    }
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `Search("${abbreviate(op.input.regex, 20)}", "${op.input.glob}")`,
    (op) => {
      // Use cache for consistent rendering when results are available
      const searchedCount = op.cache?.searchableFiles?.length ?? op.output?.searched;
      if (op.output) {
        const output = op.output;
        if (output.fileCount !== undefined) {
          return `Found ${pluralize(output.fileCount, 'file')} (searched ${searchedCount ?? output.searched})`;
        } else if (output.matchCount !== undefined) {
          return `Found ${pluralize(output.matchCount, 'match', 'matches')} (searched ${pluralize(searchedCount ?? output.searched ?? 0, 'file')})`;
        } else if (output.matches) {
          return `Found matches in ${pluralize(output.matches.length, 'file')}`;
        } else {
          return `Searched ${pluralize(searchedCount ?? output.searched ?? 0, 'file')}`;
        }
      } else if (searchedCount !== undefined) {
        return `Will search ${pluralize(searchedCount, 'file')}`;
      }
      return null;
    },
    showInput, showOutput
  ),
});

export const dir_create = operationOf<
  { path: string },
  { fullPath: string, created: boolean }
>({
  mode: 'create',
  signature: 'dir_create(path: string)',
  status: (input) => `Creating directory: ${paginateText(input.path, 100, -100)}`,
  analyze: async ({ input }, { cwd }) => {
    const fullPath = path.resolve(cwd, input.path);
    const { exists, isDirectory } = await fileIsDirectory(fullPath);

    if (exists && !isDirectory) {
      return {
        analysis: `This would fail - ${linkFile(fullPath)} exists but is not a directory.`,
        doable: false,
      };
    }
    if (exists && isDirectory) {
      return {
        analysis: `This would fail - directory ${linkFile(fullPath)} already exists.`,
        doable: false,
      };
    }

    return {
      analysis: `This will create directory ${input.path}.`,
      doable: true,
    };
  },
  do: async ({ input }, { cwd }) => {
    const fullPath = path.resolve(cwd, input.path);
    await fs.mkdir(fullPath, { recursive: true });

    return { fullPath, created: true };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `Dir("${paginateText(op.input.path, 100, -100)}")`,
    (op) => {
      if (op.output) {
        return `Created directory ${linkFile(op.output.fullPath)}`;
      }
      return null;
    },
    showInput, showOutput
  ),
});

type DirSummaryKind = 'files' | 'dirs' | 'ext' | 'all';

type DirSummaryInput = {
  path?: string;
  kind?: DirSummaryKind;
  depth?: number;
};

type DirSummaryOutput = {
  fullPath: string;
  summary: string;
  fileCount: number;
  dirCount: number;
  extCount: number;
};

export const dir_summary = operationOf<DirSummaryInput, DirSummaryOutput>({
  mode: 'local',
  signature: 'dir_summary(path?: string, kind?: "files" | "dirs" | "ext" | "all", depth?: number)',
  status: (input) => `Summarizing directory: ${paginateText(input.path || '.', 100, -100)}`,
  analyze: async ({ input }, { cwd }) => {
    const targetPath = input.path || '.';
    const fullPath = path.resolve(cwd, targetPath);
    const { exists, isDirectory } = await fileIsDirectory(fullPath);

    if (!exists) {
      return {
        analysis: `This would fail - path ${linkFile(fullPath)} does not exist.`,
        doable: false,
      };
    }
    if (!isDirectory) {
      return {
        analysis: `This would fail - ${linkFile(fullPath)} is not a directory.`,
        doable: false,
      };
    }

    return {
      analysis: `N/A`,
      doable: true,
    };
  },
  do: async ({ input }, { cwd, signal }) => {
    const targetPath = input.path || '.';
    const fullPath = path.resolve(cwd, targetPath);
    const kind = input.kind || 'all';
    const depth = input.depth ?? 10;

    // Use glob to get all files/dirs up to specified depth
    // Normalize path to avoid patterns like './**/*' which may not work correctly
    const globPattern = targetPath === '.' ? '**/*' : `${targetPath}/**/*`;
    const entries = await glob(globPattern, { 
      cwd,
      dot: false,
      maxDepth: depth,
      signal,
    });

    // Separate files and directories
    const files: string[] = [];
    const dirs: string[] = [];
    const extCounts = new Map<string, number>();
    // Track direct children counts for each directory
    const dirContents = new Map<string, { files: number; dirs: number }>();

    for (const entry of entries) {
      const entryFullPath = path.resolve(cwd, entry);
      const { isDirectory: isDir } = await fileIsDirectory(entryFullPath);
      
      if (isDir) {
        dirs.push(entry);
        // Initialize directory contents counter
        dirContents.set(entry, { files: 0, dirs: 0 });
      } else {
        files.push(entry);
        const ext = path.extname(entry).toLowerCase() || '(no extension)';
        extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
      }
    }

    // Count direct children for each directory
    for (const file of files) {
      const parent = path.dirname(file);
      if (dirContents.has(parent)) {
        const counts = dirContents.get(parent)!;
        counts.files++;
      }
    }
    for (const dir of dirs) {
      const parent = path.dirname(dir);
      if (dirContents.has(parent)) {
        const counts = dirContents.get(parent)!;
        counts.dirs++;
      }
    }

    // Sort entries
    files.sort();
    dirs.sort();

    const MAX_LINES = 50;
    const lines: string[] = [];

    const buildFilesSection = async (maxLines: number): Promise<string[]> => {
      const result: string[] = [];
      if (files.length === 0) return result;
      
      const toShow = files.slice(0, maxLines);
      result.push('Files:');
      // Only get stats for files we're actually displaying
      for (const file of toShow) {
        const filePath = path.resolve(cwd, file);
        const stats = await fs.stat(filePath);
        result.push(`  ${file} (${formatSize(stats.size)})`);
      }
      if (files.length > toShow.length) {
        result.push(`  ... and ${files.length - toShow.length} more files`);
      }
      return result;
    };

    const buildDirsSection = (maxLines: number): string[] => {
      const result: string[] = [];
      if (dirs.length === 0) return result;
      
      const toShow = dirs.slice(0, maxLines);
      result.push('Directories:');
      for (const dir of toShow) {
        const contents = dirContents.get(dir);
        const contentsInfo = contents 
          ? ` (${pluralize(contents.files, 'file')}, ${pluralize(contents.dirs, 'subdir')})`
          : '';
        result.push(`  ${dir}/${contentsInfo}`);
      }
      if (dirs.length > toShow.length) {
        result.push(`  ... and ${dirs.length - toShow.length} more directories`);
      }
      return result;
    };

    const buildExtSection = (maxLines: number): string[] => {
      const result: string[] = [];
      if (extCounts.size === 0) return result;
      
      const sortedExts = Array.from(extCounts.entries()).sort((a, b) => b[1] - a[1]);
      const toShow = sortedExts.slice(0, maxLines);
      result.push('Extensions:');
      for (const [ext, count] of toShow) {
        result.push(`  ${ext}: ${pluralize(count, 'file')}`);
      }
      if (sortedExts.length > toShow.length) {
        result.push(`  ... and ${sortedExts.length - toShow.length} more extensions`);
      }
      return result;
    };

    // Reserve 4 lines for summary at the end: empty line, separator (---), summary text, and buffer
    const SUMMARY_LINES = 4;
    const availableLines = MAX_LINES - SUMMARY_LINES;

    if (kind === 'files') {
      lines.push(...await buildFilesSection(availableLines - 1));
    } else if (kind === 'dirs') {
      lines.push(...buildDirsSection(availableLines - 1));
    } else if (kind === 'ext') {
      lines.push(...buildExtSection(availableLines - 1));
    } else {
      // kind === 'all' - try to fit all sections evenly, filling unused space
      const hasFiles = files.length > 0;
      const hasDirs = dirs.length > 0;
      const hasExts = extCounts.size > 0;
      const activeSections = [hasFiles, hasDirs, hasExts].filter(Boolean).length;
      
      if (activeSections === 0) {
        lines.push('(empty directory)');
      } else {
        // Build sections with adaptive line allocation
        // Each section gets an equal share of remaining lines, unused lines go to the next section
        let remainingLines = availableLines;
        let remainingActive = activeSections;
        
        // Handle files section (async)
        if (hasFiles) {
          const linesForSection = Math.floor(remainingLines / remainingActive);
          const sectionContent = await buildFilesSection(linesForSection);
          
          if (sectionContent.length > 0) {
            if (lines.length > 0) lines.push('');
            lines.push(...sectionContent);
          }
          
          remainingLines -= sectionContent.length + (lines.length > 0 ? 1 : 0);
          remainingActive--;
        }
        
        // Handle dirs section (sync)
        if (hasDirs) {
          const linesForSection = Math.floor(remainingLines / remainingActive);
          const sectionContent = buildDirsSection(linesForSection);
          
          if (sectionContent.length > 0) {
            if (lines.length > 0) lines.push('');
            lines.push(...sectionContent);
          }
          
          remainingLines -= sectionContent.length + (lines.length > 0 ? 1 : 0);
          remainingActive--;
        }
        
        // Handle ext section (sync)
        if (hasExts) {
          const linesForSection = Math.floor(remainingLines / remainingActive);
          const sectionContent = buildExtSection(linesForSection);
          
          if (sectionContent.length > 0) {
            if (lines.length > 0) lines.push('');
            lines.push(...sectionContent);
          }
        }
      }
    }

    // Add summary at the end
    lines.push('');
    lines.push('---');
    lines.push(`Summary: ${pluralize(files.length, 'file')}, ${pluralize(dirs.length, 'subdirectory', 'subdirectories')}, ${pluralize(extCounts.size, 'unique extension')}`);

    return {
      fullPath,
      summary: lines.join('\n'),
      fileCount: files.length,
      dirCount: dirs.length,
      extCount: extCounts.size,
    };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `DirSummary("${paginateText(op.input.path || '.', 100, -100)}")`,
    (op) => {
      if (op.output) {
        return `${linkFile(op.output.fullPath)}: ${pluralize(op.output.fileCount, 'file')}, ${pluralize(op.output.dirCount, 'dir')}, ${pluralize(op.output.extCount, 'extension')}`;
      }
      return null;
    },
    showInput, showOutput
  ),
});

export const file_attach = operationOf<
  { path: string },
  { fullPath: string, attached: boolean }
>({
  mode: 'create',
  signature: 'file_attach({ path })',
  status: ({ path: filePath }) => `Attaching file: ${paginateText(filePath, 100, -100)}`,
  analyze: async ({ input: { path: filePath } }, { cwd }) => {
    const fullPath = path.resolve(cwd, filePath);

    // Check if file exists and is readable
    const readable = await fileIsReadable(fullPath);
    if (!readable) {
      return {
        analysis: `This would fail - file ${linkFile(filePath)} not found or not readable.`,
        doable: false,
      };
    }

    // Check file type - only allow text, audio, or PDF
    const fileType = await categorizeFile(fullPath, filePath);
    const isAudio = await isAudioFile(fullPath, filePath);

    if (!ALLOWED_FILE_TYPES.includes(fileType) && !isAudio) {
      return {
        analysis: `This would fail - file type "${fileType}" is not allowed. Only text, audio, and PDF files can be attached.`,
        doable: false,
      };
    }

    return {
      analysis: `This will attach the ${isAudio ? 'audio' : fileType} file ${linkFile(filePath)} to the chat as a user message.`,
      doable: true,
    };
  },
  do: async ({ input: { path: filePath } }, { cwd, chatMessage }) => {
    const fullPath = path.resolve(cwd, filePath);
    const fileLink = linkFile(fullPath);

    // Determine the content type
    const isAudio = await isAudioFile(fullPath, filePath);

    // Add file to the chat message
    if (chatMessage) {
      if (isAudio) {
        chatMessage.content.push({ type: 'audio', content: fileLink });
      } else {
        chatMessage.content.push({ type: 'file', content: fileLink });
      }
    }

    return { fullPath, attached: true };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `FileAttach("${paginateText(op.input.path, 100, -100)}")`,
    (op) => {
      if (op.output?.attached) {
        return `Attached file: ${linkFile(op.output.fullPath)}`;
      }
      return null;
    },
    showInput, showOutput
  ),
});

// Helper function to process shell output
const processShellOutput = (stdout: string, stderr: string) => {
  const allOutput = stdout + stderr;
  const lines = allOutput.split('\n').filter(l => l.length > 0);
  return { allOutput, lines, lineCount: lines.length };
};

export const shell = operationOf<
  { command: string },
  { stdout: string; stderr: string; exitCode: number | null; signal: string | null }
>({
  mode: 'delete',
  signature: 'shell(command: string)',
  status: (input) => `Running: ${abbreviate(input.command, 50)}`,
  analyze: async ({ input }, { cwd }) => {
    return {
      analysis: `This will execute the shell command: "${input.command}" in the directory ${cwd}`,
      doable: true,
    };
  },
  do: async ({ input }, { cwd, chatStatus, events, signal }) => {
    const { spawn } = await import('child_process');

    return new Promise((resolve, reject) => {
      // Determine shell and command arguments based on platform
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd.exe' : process.env.SHELL || '/bin/sh';
      const childProcess = spawn(input.command, [], {
        cwd,
        shell,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      });

      let stdout = '';
      let stderr = '';
      let lastUpdate = Date.now();
      const UPDATE_INTERVAL = 100; // Update status at most every 100ms

      const updateStatus = () => {
        const now = Date.now();
        // Only process output if enough time has passed
        if (now - lastUpdate >= UPDATE_INTERVAL) {
          const { lineCount } = processShellOutput(stdout, stderr);
          chatStatus(`Executing... ${pluralize(lineCount, 'line')} of output`);
          events?.onRefreshPending?.();
          lastUpdate = now;
        }
      };

      childProcess.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
        updateStatus();
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        updateStatus();
      });

      childProcess.on('error', (error) => {
        reject(new Error(`Failed to execute command: ${error.message}`));
      });

      childProcess.on('close', (exitCode, signalName) => {
        const { lineCount } = processShellOutput(stdout, stderr);
        chatStatus(`Completed with exit code ${exitCode ?? 'signal ' + signalName}. ${lineCount} ${lineCount === 1 ? 'line' : 'lines'} of output.`);
        
        resolve({
          stdout,
          stderr,
          exitCode,
          signal: signalName,
        });
      });

      // Handle abort signal
      if (signal) {
        signal.addEventListener('abort', () => {
          childProcess.kill();
          reject(new Error('Command execution was cancelled'));
        });
      }
    });
  },
  render: (op, ai, showInput, showOutput) => {
    const formatOutput = () => {
      if (!op.output) {
        return 'Executing...';
      }

      const { lines, lineCount } = processShellOutput(op.output.stdout, op.output.stderr);
      const lastLines = lines.slice(-4);
      const exitCode = op.output.exitCode;
      const signal = op.output.signal;

      const statusText = exitCode !== null 
        ? `Exit code: ${exitCode}`
        : signal 
          ? `Terminated by signal: ${signal}`
          : 'Running...';

      return (
        <Box flexDirection="column" marginLeft={3}>
          {lastLines.length > 0 && (
            <>
              {lineCount > 4 && (
                <Text color="gray">... ({lineCount - 4} more lines)</Text>
              )}
              <Text>{lastLines.join('\n')}</Text>
            </>
          )}
          <Text color={exitCode === 0 ? 'green' : exitCode !== null ? 'red' : 'yellow'}>
            {lineCount} {lineCount === 1 ? 'line' : 'lines'} • {statusText}
          </Text>
        </Box>
      );
    };

    return renderOperation(
      op,
      `Shell("${abbreviate(op.input.command, 60)}")`,
      formatOutput,
      showInput,
      showOutput
    );
  },
});
