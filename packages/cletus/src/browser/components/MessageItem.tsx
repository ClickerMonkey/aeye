import { getReasoningText } from '@aeye/core';
import { Bot, Info, User, Download, Brain } from 'lucide-react';
import React, { useState } from 'react';
import type { Message } from '../../schemas';
import { cn } from '../lib/utils';
import { OperationDisplay } from '../operations';
import { MarkdownContent, CustomLink } from './Markdown';
import { ClickableImage } from './ImageViewer';
import { TypingIndicator } from './TypingIndicator';
import { ExpandableText } from './ExpandableText';


interface CollapsibleReasoningProps {
  content: string;
  isAnimated: boolean;
  isUser: boolean;
  isAssistant: boolean;
  isSystem: boolean;
}

const CollapsibleReasoning: React.FC<CollapsibleReasoningProps> = ({
  content,
  isAnimated,
  isUser,
  isAssistant,
  isSystem,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="w-full">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 py-2 px-3 rounded-md hover:bg-yellow-500/10 transition-colors cursor-pointer group"
      >
        <Brain className="w-4 h-4 text-yellow-600 dark:text-yellow-500 flex-shrink-0" />
        <span className={cn(
          'text-sm font-medium text-yellow-600 dark:text-yellow-500',
          isAnimated && 'animate-shimmer bg-gradient-to-r from-yellow-600/60 via-yellow-500 to-yellow-600/60 bg-[length:200%_100%] text-transparent bg-clip-text'
        )}>
          {isAnimated ? 'Reasoning...' : 'Reasoning'}
        </span>
      </button>

      {/* Content */}
      {isExpanded && (
        <div className="pl-10 pr-3 py-2 text-yellow-600 dark:text-yellow-500 text-sm">
          <MarkdownContent content={content} />
        </div>
      )}
    </div>
  );
};

interface MessageItemProps {
  message: Message;
  operationDecisions?: Map<number, 'approve' | 'reject'>;
  onToggleOperationDecision?: (idx: number, decision: 'approve' | 'reject') => void;
  onApproveOperation: (message: Message, idx: number) => void;
  onRejectOperation: (message: Message, idx: number) => void;
  hasMultiplePendingOperations?: boolean;
  isProcessing?: boolean;
  isLast?: boolean;
}

export const MessageItem: React.FC<MessageItemProps> = ({
  message,
  operationDecisions,
  onToggleOperationDecision,
  onApproveOperation,
  onRejectOperation,
  hasMultiplePendingOperations: hasMultiplePendingOps = false,
  isProcessing = false,
  isLast = false,
}) => {
  const { role, name, content, operations = [] } = message;

  const isUser = role === 'user';
  const isAssistant = role === 'assistant';
  const isSystem = role === 'system';

  // Map content items to their operations
  const mappedContent = content.map((c) => ({
    ...c,
    operation: c.operationIndex !== undefined ? operations[c.operationIndex] : undefined,
  }));

  // Filter content: show all non-empty content without operationIndex, and operations
  const visibleContent = mappedContent.filter(
    (c) => (c.operationIndex === undefined && (c.content.trim().length > 0 || getReasoningText(c.reasoning))) || c.operation
  );

  const isUrl = (str: string): boolean => {
    return str.startsWith('http://') || str.startsWith('https://') || str.startsWith('file://');
  };

  const downloadDataFile = (dataUrl: string, filename: string) => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div
      className={cn(
        'flex gap-4 mb-6 group',
        isUser && 'flex-row-reverse'
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center',
          isUser && 'bg-neon-purple/20 border-2 border-neon-purple',
          isAssistant && 'bg-neon-cyan/20 border-2 border-neon-cyan',
          isSystem && 'bg-muted border-2 border-border'
        )}
      >
        {isUser && <User className="w-5 h-5 text-neon-purple" />}
        {isAssistant && <Bot className="w-5 h-5 text-neon-cyan" />}
        {isSystem && <Info className="w-5 h-5 text-muted-foreground" />}
      </div>

      {/* Content */}
      <div className={cn('flex-1 space-y-2 min-w-0', isUser && 'flex flex-col items-end')}>
        {/* Header */}
        <div
          className={cn(
            'text-xs font-semibold opacity-70',
            isUser && 'text-neon-purple',
            isAssistant && 'text-neon-cyan',
            isSystem && 'text-muted-foreground'
          )}
        >
          {isUser ? (name || 'You') : isAssistant ? (name || 'Assistant') : 'System'}
        </div>

        {/* Content and Operations in order */}
        <div className={cn('flex-1 space-y-2', isUser && 'flex flex-col items-end')}>
          {visibleContent.length === 0 && isAssistant && isProcessing && isLast ? (
            <div className="rounded-lg bg-card p-2">
              <TypingIndicator />
            </div>
          ) : visibleContent.length === 0 && isAssistant ? null : (
            visibleContent.map((item, index) => {
            // Render operation if this content item has an operation
            if (item.operation && item.operationIndex !== undefined) {
              const opIdx = item.operationIndex;

              return (
                <OperationDisplay
                  key={index}
                  operation={item.operation}
                  operationIndex={opIdx}
                  approvalDecision={operationDecisions?.get(opIdx)}
                  onToggleDecision={onToggleOperationDecision}
                  onApprove={() => onApproveOperation(message, opIdx)}
                  onReject={() => onRejectOperation(message, opIdx)}
                  hasMultipleOperations={hasMultiplePendingOps}
                  isProcessing={isProcessing}
                  isLast={isLast}
                />
              );
            }

            // Render content based on type
            if (item.type === 'reasoning') {
              const isLastContent = index === visibleContent.length - 1;
              const content = getReasoningText(item.reasoning)

              return (
                <CollapsibleReasoning
                  key={index}
                  content={content}
                  isAnimated={isLastContent}
                  isUser={isUser}
                  isAssistant={isAssistant}
                  isSystem={isSystem}
                />
              );
            }

            if (item.type === 'image') {
              const hasProtocol = item.content.startsWith('data:') || isUrl(item.content);
              if (hasProtocol) {
                return (
                  <div key={index} className="max-w-3xl">
                    <ClickableImage
                      src={item.content}
                      alt="Image"
                      className="max-w-full rounded-lg"
                    />
                  </div>
                );
              }
            }

            if (item.type === 'audio') {
              const hasProtocol = item.content.startsWith('data:') || isUrl(item.content);
              if (hasProtocol) {
                return (
                  <div
                    key={index}
                    className={cn(
                      'rounded-lg p-4 max-w-3xl',
                      isUser && 'bg-neon-purple/10 border border-neon-purple/30',
                      isAssistant && 'bg-card',
                      isSystem && 'bg-muted/50 border border-muted'
                    )}
                  >
                    <audio controls className="w-full">
                      <source src={item.content} />
                      Your browser does not support the audio element.
                    </audio>
                  </div>
                );
              }
            }

            if (item.type === 'file') {
              if (item.content.startsWith('data:')) {
                // Extract filename from data URL or use default
                const match = item.content.match(/data:([^;]+);/);
                const mimeType = match ? match[1] : 'application/octet-stream';
                const extension = mimeType.split('/')[1] || 'bin';
                const filename = `file.${extension}`;

                return (
                  <div
                    key={index}
                    className={cn(
                      'rounded-lg p-4 max-w-3xl',
                      isUser && 'bg-neon-purple/10 border border-neon-purple/30',
                      isAssistant && 'bg-card',
                      isSystem && 'bg-muted/50 border border-muted'
                    )}
                  >
                    <button
                      onClick={() => downloadDataFile(item.content, filename)}
                      className="flex items-center gap-2 text-neon-cyan hover:underline cursor-pointer"
                    >
                      <Download className="w-4 h-4" />
                      Download File
                    </button>
                  </div>
                );
              } else if (isUrl(item.content)) {
                return (
                  <div
                    key={index}
                    className={cn(
                      'rounded-lg p-4 max-w-3xl',
                      isUser && 'bg-neon-purple/10 border border-neon-purple/30',
                      isAssistant && 'bg-card',
                      isSystem && 'bg-muted/50 border border-muted'
                    )}
                  >
                    <CustomLink href={item.content}>
                      {item.content}
                    </CustomLink>
                  </div>
                );
              }
            }

            // Render text content with expandable feature for user messages
            return (
              <ExpandableText
                key={index}
                content={item.content}
                isUser={isUser}
                isAssistant={isAssistant}
                isSystem={isSystem}
              />
            );
            })
          )}
        </div>

        {/* Timestamp */}
        <div className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
          {new Date(message.created).toLocaleString()}
        </div>
      </div>
    </div>
  );
};
