import React, { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { MessageItem } from './MessageItem';
import type { Message } from '../../schemas';

interface MessageListProps {
  messages: Message[];
  loading?: boolean;
  isProcessing?: boolean;
  operationDecisions?: Map<number, 'approve' | 'reject'>;
  onToggleOperationDecision?: (idx: number, decision: 'approve' | 'reject') => void;
  onApproveOperation: (message: Message, idx: number) => void;
  onRejectOperation: (message: Message, idx: number) => void;
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  loading = false,
  isProcessing = false,
  operationDecisions,
  onToggleOperationDecision,
  onApproveOperation,
  onRejectOperation,
}) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Scroll to bottom when messages change
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  return (
    <div className="flex-1 overflow-auto">
      {messages.length === 0 ? (
        <div className="text-center text-muted-foreground mt-8">
          {loading ? (
            <div className="flex items-center justify-center gap-2">
              <Loader2 className="w-5 h-5 animate-spin" />
              <p>Loading messages...</p>
            </div>
          ) : (
            <p>No messages yet. Start a conversation!</p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {messages.map((message, index) => {
            // Check if this is the last message with pending operations
            const isLastMessage = index === messages.length - 1;
            // const hasPendingOps = message.operations?.some(op => op.status === 'analyzed');
            const pendingCount = message.operations?.filter(op => op.status === 'analyzed' || op.status === 'doing').length || 0;

            return (
              <MessageItem
                key={message.created}
                message={message}
                operationDecisions={operationDecisions}
                onToggleOperationDecision={onToggleOperationDecision}
                onApproveOperation={onApproveOperation}
                onRejectOperation={onRejectOperation}
                hasMultiplePendingOperations={pendingCount > 1}
                isProcessing={loading || isProcessing}
                isLast={isLastMessage}
              />
            );
          })}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
};
