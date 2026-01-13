import React, { useMemo, useState, useEffect } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { ClickableImage, ImageViewer } from './ImageViewer';
import { X, Download, ExternalLink } from 'lucide-react';
import { cn } from '../lib/utils';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';


// Preprocess content to convert LaTeX delimiters to markdown math delimiters
const preprocessLatex = (text: string): string => {
  // Convert \[...\] to $$...$$ (display math)
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (match, content) => `$$${content}$$`);
  // Convert \(...\) to $...$ (inline math)
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (match, content) => `$${content}$`);
  // Convert standalone [... ] patterns that look like display math (with array/equation content)
  // Only convert if it contains LaTeX commands like \begin, \text, etc.
  text = text.replace(/\[\s*(\\begin|\\text|\\frac|\\int|\\sum|\\prod)([\s\S]*?)\s*\]/g, (match, cmd, rest) => `$$${cmd}${rest}$$`);
  return text;
};

// Check if a URL is a local file path
const isLocalFile = (href: string): boolean => {
  if (!href) return false;

  // For now - consider any non-http(s) URL as local file
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('data:')) return false;

  return true;
/*
  // file:// protocol
  if (href.startsWith('file://')) return true;
  // Absolute paths starting with /
  if (href.startsWith('/')) return true;
  // Windows drive letter paths (C:\, D:\, etc.)
  if (/^[A-Za-z]:\\/.test(href)) return true;
  return false;
*/
};

// Check if a file extension can be previewed with syntax highlighting
const canPreviewFile = (filepath: string): boolean => {
  const ext = filepath.split('.').pop()?.toLowerCase();
  if (!ext) return false;

  const previewableExtensions = [
    // Code files
    'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt',
    // Web files
    'html', 'css', 'scss', 'sass', 'less', 'vue', 'svelte',
    // Config files
    'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
    // Scripts
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    // Documentation
    'md', 'markdown', 'txt', 'rst', 'adoc',
    // Other
    'sql', 'graphql', 'proto', 'dockerfile', 'makefile',
  ];

  return previewableExtensions.includes(ext);
};

// Check if a file extension is an image
const canPreviewImage = (filepath: string): boolean => {
  const ext = filepath.split('.').pop()?.toLowerCase();
  if (!ext) return false;
  const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tiff', 'svg'];
  return imageExtensions.includes(ext);
};

// Get file path from various URL formats
const getFilePath = (href: string): string => {
  if (href.startsWith('file://')) {
    return decodeURIComponent(href.replace('file://', ''));
  }
  return href;
};

// Get language for syntax highlighting based on file extension
const getLanguageFromFilename = (filepath: string): string => {
  const ext = filepath.split('.').pop()?.toLowerCase();
  if (!ext) return 'text';

  const languageMap: Record<string, string> = {
    // JavaScript/TypeScript
    'js': 'javascript',
    'jsx': 'jsx',
    'ts': 'typescript',
    'tsx': 'tsx',
    'mjs': 'javascript',
    'cjs': 'javascript',
    // Python
    'py': 'python',
    'pyw': 'python',
    // Java/Kotlin/Scala
    'java': 'java',
    'kt': 'kotlin',
    'scala': 'scala',
    // C/C++
    'c': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'hh': 'cpp',
    // C#
    'cs': 'csharp',
    // Go
    'go': 'go',
    // Rust
    'rs': 'rust',
    // Ruby
    'rb': 'ruby',
    // PHP
    'php': 'php',
    // Swift
    'swift': 'swift',
    // Web
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass',
    'less': 'less',
    'vue': 'vue',
    'svelte': 'svelte',
    // Data formats
    'json': 'json',
    'xml': 'xml',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'ini': 'ini',
    'cfg': 'ini',
    'conf': 'ini',
    // Shell scripts
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    'fish': 'bash',
    'ps1': 'powershell',
    'bat': 'batch',
    'cmd': 'batch',
    // Documentation
    'md': 'markdown',
    'markdown': 'markdown',
    'rst': 'rst',
    'txt': 'text',
    // SQL
    'sql': 'sql',
    // Other
    'graphql': 'graphql',
    'proto': 'protobuf',
    'dockerfile': 'dockerfile',
    'makefile': 'makefile',
  };

  return languageMap[ext] || 'text';
};

// Check if file should be rendered as markdown
const isMarkdownFile = (filepath: string): boolean => {
  const ext = filepath.split('.').pop()?.toLowerCase();
  return ext === 'md' || ext === 'markdown';
};

// File Viewer Modal Component
interface FileViewerProps {
  filepath: string;
  isOpen: boolean;
  onClose: () => void;
}

const FileViewer: React.FC<FileViewerProps> = ({ filepath, isOpen, onClose }) => {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && filepath) {
      setLoading(true);
      setError(null);

      fetch(`/file?path=${encodeURIComponent(filepath)}`)
        .then(res => {
          if (!res.ok) throw new Error('Failed to load file');
          return res.text();
        })
        .then(text => {
          setContent(text);
          setLoading(false);
        })
        .catch(err => {
          setError(err.message);
          setLoading(false);
        });
    }
  }, [isOpen, filepath]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const downloadFile = () => {
    const a = document.createElement('a');
    a.href = `/file?path=${encodeURIComponent(filepath)}`;
    a.download = filepath.split('/').pop() || filepath.split('\\').pop() || 'file';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      {/* Controls */}
      <div className="absolute top-4 right-4 flex gap-2 z-10">
        <button
          onClick={downloadFile}
          className="p-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
          title="Download"
        >
          <Download className="w-5 h-5 text-white" />
        </button>
        <button
          onClick={onClose}
          className="p-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
          title="Close (ESC)"
        >
          <X className="w-5 h-5 text-white" />
        </button>
      </div>

      {/* File path */}
      <div className="absolute top-4 left-4 px-3 py-1 bg-white/10 rounded-lg text-white text-sm max-w-2xl truncate">
        {filepath}
      </div>

      {/* Content */}
      <div className="relative w-full h-full p-8 pt-16">
        {loading ? (
          <div className="flex items-center justify-center h-full text-white">
            Loading...
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full text-red-400">
            Error: {error}
          </div>
        ) : isMarkdownFile(filepath) ? (
          <div className="w-full h-full overflow-auto bg-black/50 rounded-lg p-4">
            <MarkdownContent content={content} />
          </div>
        ) : (
          <SyntaxHighlighter
            language={getLanguageFromFilename(filepath)}
            style={vscDarkPlus}
            customStyle={{
              margin: 0,
              width: '100%',
              height: '100%',
              background: 'rgba(0, 0, 0, 0.5)',
              borderRadius: '0.5rem',
              padding: '1rem',
            }}
            showLineNumbers
            wrapLongLines
          >
            {content}
          </SyntaxHighlighter>
        )}
      </div>

      {/* Instructions */}
      <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 px-4 py-2 bg-white/10 rounded-lg text-white text-xs text-center">
        ESC or click outside to close
      </div>
    </div>
  );
};

// URL Confirmation Modal Component
interface URLConfirmModalProps {
  url: string;
  isOpen: boolean;
  onClose: () => void;
}

const URLConfirmModal: React.FC<URLConfirmModalProps> = ({ url, isOpen, onClose }) => {
  const openURL = () => {
    window.open(url, '_blank', 'noopener,noreferrer');
    onClose();
  };

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="relative w-full max-w-2xl bg-card rounded-lg border border-border shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-xl font-bold text-foreground mb-4">Open External Link</h2>
        <p className="text-muted-foreground mb-4">
          You are about to open an external URL:
        </p>
        <div className="bg-muted p-3 rounded mb-4 break-all text-sm font-mono">
          {url}
        </div>
        <p className="text-muted-foreground text-sm mb-6">
          Please verify this URL is safe before opening it in a new tab.
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-muted hover:bg-muted/80 text-foreground rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={openURL}
            className="px-4 py-2 bg-neon-cyan hover:bg-neon-cyan/80 text-black rounded-lg transition-colors flex items-center gap-2"
          >
            <ExternalLink className="w-4 h-4" />
            Open Link
          </button>
        </div>
      </div>
    </div>
  );
};

// Custom Link Component
export const CustomLink: React.FC<{ href: string | undefined, children: React.ReactNode }> = (props) => {
  const { href, children } = props;
  const [showFileViewer, setShowFileViewer] = useState(false);
  const [showURLConfirm, setShowURLConfirm] = useState(false);
  const [showImageViewer, setShowImageViewer] = useState(false);

  // If href is empty but children is a string that looks like a filename, use children as the path
  let effectiveHref = href || (typeof children === 'string' ? children : '');

  // Decode URL-encoded hrefs (ReactMarkdown encodes backslashes as %5C)
  try {
    effectiveHref = decodeURIComponent(effectiveHref);
  } catch (e) {
    // If decoding fails, use the original
    console.warn('Failed to decode href:', effectiveHref, e);
  }

  const filepath = effectiveHref && isLocalFile(effectiveHref) ? getFilePath(effectiveHref) : '';
  const download = `/file?path=${encodeURIComponent(filepath)}`;

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();

    if (!effectiveHref) {
      console.warn('No href or filename provided to link');
      return;
    }

    if (isLocalFile(effectiveHref)) {
      const filepath = getFilePath(effectiveHref);

      if (canPreviewFile(filepath)) {
        setShowFileViewer(true);
      } else if (canPreviewImage(filepath)) {
        setShowImageViewer(true);
      } else {
        // Download the file
        const a = document.createElement('a');
        a.href = download;
        a.download = filepath.split('/').pop() || filepath.split('\\').pop() || 'file';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } else {
      setShowURLConfirm(true);
    }
  };

  return (
    <>
      <a
        href={effectiveHref || '#'}
        onClick={handleClick}
        className="text-neon-cyan hover:underline cursor-pointer"
      >
        {children}
      </a>

      {effectiveHref && isLocalFile(effectiveHref) && canPreviewFile(filepath) && (
        <FileViewer
          filepath={filepath}
          isOpen={showFileViewer}
          onClose={() => setShowFileViewer(false)}
        />
      )}

      {effectiveHref && isLocalFile(effectiveHref) && canPreviewImage(filepath) && (
        <ImageViewer
          src={download}
          isOpen={showImageViewer}
          onClose={() => setShowImageViewer(false)}
        />
      )}

      {effectiveHref && !isLocalFile(effectiveHref) && (
        <URLConfirmModal
          url={effectiveHref}
          isOpen={showURLConfirm}
          onClose={() => setShowURLConfirm(false)}
        />
      )}
    </>
  );
};

// Stable markdown components reference - created once and reused
const markdownComponents: Components = {
  h1: ({ children }) => <h1 className="text-foreground text-3xl font-bold mb-3 mt-6 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-foreground text-2xl font-bold mb-2 mt-5 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="text-foreground text-xl font-semibold mb-2 mt-4 first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="text-foreground text-lg font-semibold mb-2 mt-3 first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="text-foreground text-base font-semibold mb-1 mt-3 first:mt-0">{children}</h5>,
  h6: ({ children }) => <h6 className="text-foreground text-sm font-semibold mb-1 mt-2 first:mt-0">{children}</h6>,
  p: ({ children }) => <p className="text-foreground mb-3 leading-normal whitespace-normal">{children}</p>,
  ul: ({ children }) => <ul className="text-foreground list-disc pl-5 mb-3">{children}</ul>,
  ol: ({ children }) => <ol className="text-foreground list-decimal pl-5 mb-3">{children}</ol>,
  li: ({ children }) => <li className="text-foreground mb-1">{children}</li>,
  code: ({ inline, className, children, ...props }: any) => {
    // Extract language from className (format: language-javascript)
    const match = /language-(\w+)/.exec(className || '');
    const language = match ? match[1] : '';

    // If it has a language, it's a code block with syntax highlighting
    if (language) {
      return (
        <SyntaxHighlighter
          language={language}
          style={vscDarkPlus}
          customStyle={{
            margin: '0 0 0.75rem 0',
            borderRadius: '0.375rem',
            fontSize: '0.875rem',
            marginBottom: '0',
          }}
          wrapLongLines
          PreTag="div"
        >
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      );
    }

    // Otherwise treat as inline code (label-like)
    return (
      <code className="text-foreground bg-muted px-1.5 py-0.5 rounded text-sm font-mono whitespace-nowrap inline-block align-middle" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => {
    // Check if the child is a code element with syntax highlighting
    // If it is, just return the children (the code component handles the styling)
    // Otherwise, wrap in a pre tag
    const child = React.Children.only(children) as any;
    if (child?.type === 'code' && child?.props?.className?.includes('language-')) {
      return <>{children}</>;
    }
    return <pre className="text-foreground bg-muted p-3 rounded mb-3 overflow-x-auto whitespace-pre">{children}</pre>;
  },
  a: ({ href, children }) => <CustomLink href={href}>{children}</CustomLink>,
  img: ({ src, alt, ...props }: any) => {
    // Transform local file paths to use the /file route
    const imageSrc = src && !src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:')
      ? `/file?path=${encodeURIComponent(decodeURIComponent(src))}`
      : src;
    return <ClickableImage src={imageSrc} alt={alt} className="max-w-full rounded" {...props} />;
  },
  blockquote: ({ children }) => <blockquote className="border-l-4 border-muted pl-4 italic text-muted-foreground mb-3">{children}</blockquote>,
  hr: () => <hr className="border-border my-4" />,
};

// Memoized markdown content renderer
export const MarkdownContent = React.memo<{ content: string }>(({ content }) => {
  const processedContent = useMemo(() => preprocessLatex(content), [content]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={markdownComponents}
      urlTransform={(url) => {
        // Preserve all URLs including local file paths
        // ReactMarkdown by default sanitizes URLs, but we want to handle local files
        return url;
      }}
    >
      {processedContent}
    </ReactMarkdown>
  );
});