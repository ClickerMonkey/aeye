import { Box, Text, useInput } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import type { CletusAI } from '../ai';
import { ChatFile } from '../chat';
import { formatName, formatTime, pluralize } from '../common';
import { COLORS } from '../theme';
import { logger } from '../logger';
import { OperationManager } from '../operations/manager';
import type { ChatMeta, Message, Operation } from '../schemas';


interface OperationApprovalMenuProps {
  message: Message;
  ai: CletusAI;
  chatMeta: ChatMeta;
  chatData: ChatFile;
  signal?: AbortSignal;
  onStart?: () => void | AbortSignal;
  onMessageUpdate?: (message: Message) => void;
  onComplete: (result: CompletionResult | null) => void;
  onChatStatus?: (status: string) => void;
  onUsageUpdate?: (accumulated: any, accumulatedCost: number) => void;
}

type MenuState = 'main' | 'approving-some' | 'processing' | 'complete';

export interface CompletionResult {
  success: number;
  failed: number;
  rejected: number;
  hasErrors: boolean;
}

export const OperationApprovalMenu: React.FC<OperationApprovalMenuProps> = ({
  message,
  ai,
  chatMeta,
  chatData,
  signal,
  onStart,
  onMessageUpdate,
  onComplete,
  onChatStatus,
  onUsageUpdate,
}) => {
  const [menuState, setMenuState] = useState<MenuState>('main');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [currentOperationIndex, setCurrentOperationIndex] = useState(0);
  const [operationDecisions, setOperationDecisions] = useState<Map<number, 'approve' | 'reject'>>(new Map());
  const [isProcessing, setIsProcessing] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [completionResult, setCompletionResult] = useState<CompletionResult | null>(null);
  const startTimeRef = useRef<number>(0);

  // Get operations that need approval
  const approvableOperations = (message.operations || [])
    .map((op, idx) => ({ op, idx }))
    .filter(({ op }) => op.status === 'analyzed');

  const hasMultipleOperations = approvableOperations.length > 1;

  const updateMessageContent = (op: Operation, operationIndex: number) => {
    // Update the message content when operation is executed.
    // Move to end of message content array to ensure visibility.
    const contentIndex = message.content.findIndex((c) => c.operationIndex === operationIndex);
    if (contentIndex !== -1) {
      // const content = message.content.splice(contentIndex, 1)[0];
      // content.content = op.message || '';
      // message.content.push(content);

      message.content[contentIndex].content = op.message || '';
      onMessageUpdate?.(message);
    }
  };

  // Timer for elapsed time
  useEffect(() => {
    if (isProcessing) {
      startTimeRef.current = performance.now();
      const interval = setInterval(() => {
        setElapsedTime(performance.now() - startTimeRef.current);
      }, 100);
      return () => clearInterval(interval);
    }
  }, [isProcessing]);

  // Auto-dismiss after completion
  useEffect(() => {
    if (menuState === 'complete' && completionResult) {
      const timeout = setTimeout(() => {
        onComplete(completionResult);
      }, 1500);
      return () => clearTimeout(timeout);
    }
  }, [menuState, completionResult]);

  const setComplete = (completedResult: CompletionResult) => {
    setIsProcessing(false);
    setCompletionResult(completedResult);
    setMenuState('complete');
  };

  const getContext = async (overrideSignal?: AbortSignal) => {
    return await ai.buildContext({
      signal: overrideSignal || signal,
      chat: chatMeta,
      chatData,
      chatMessage: message,
      chatStatus: onChatStatus,
    });
  }

  const executeOperations = async (indices: number[]) => {
    setIsProcessing(true);
    setMenuState('processing');
    setElapsedTime(0);
    const startTime = performance.now();
    let result: CompletionResult = {
      success: 0,
      failed: indices.length,
      rejected: 0,
      hasErrors: true,
    };

    try {
      const sessionSignal = onStart?.() || undefined;

      const operations = message.operations || [];
      const manager = new OperationManager(
        'none',
        operations,
        undefined,
        updateMessageContent,
      );

      const ctx = await getContext(sessionSignal);

      let success = 0;
      let failed = 0;

      // Execute each approved operation
      for (const idx of indices) {
        const op = operations[idx];
        await manager.execute(op, true, ctx);

        if (op.status === 'done') {
          success++;
        } else if (op.status === 'doneError') {
          failed++;
        }
      }

      // Report usage after operations complete
      if (onUsageUpdate && ctx.usage) {
        onUsageUpdate(ctx.usage.accumulated, ctx.usage.accumulatedCost);
      }

      result = {
        success,
        failed,
        rejected: 0,
        hasErrors: failed > 0,
      };
    } catch (error: any) {
      logger.log(`Failed to execute operations: ${error.message}: ${error.stack}`);
    } finally {
      setComplete(result);
    }
  };

  const rejectOperations = async (indices: number[]) => {
    setIsProcessing(true);
    setMenuState('processing');
    setElapsedTime(0);
    let result: CompletionResult = {
      success: 0,
      failed: 0,
      rejected: 0,
      hasErrors: true,
    };

    try {
      const operations = message.operations || [];
      const manager = new OperationManager(
        'none',
        operations,
        undefined,
        updateMessageContent,
      );

      // Mark operations as rejected
      for (const idx of indices) {
        operations[idx].status = 'rejected';
        manager.updateMessage(operations[idx]);
      }

      result = {
        success: 0,
        failed: 0,
        rejected: indices.length,
        hasErrors: false,
      };
    } catch (error: any) {
      logger.log(`Failed to reject operations: ${error.message}: ${error.stack}`);
    } finally {
      setComplete(result)
    }
  };

  const handleMainMenuSelection = async () => {
    if (hasMultipleOperations) {
      if (selectedIndex === 0) {
        // Approve all
        await executeOperations(approvableOperations.map(({ idx }) => idx));
      } else if (selectedIndex === 1) {
        // Reject all
        await rejectOperations(approvableOperations.map(({ idx }) => idx));
      } else if (selectedIndex === 2) {
        // Approve some
        setMenuState('approving-some');
        setCurrentOperationIndex(0);
        setSelectedIndex(0);
      }
    } else {
      // Single operation - approve or reject based on selection
      if (selectedIndex === 0) {
        await executeOperations([approvableOperations[0].idx]);
      } else {
        await rejectOperations([approvableOperations[0].idx]);
      }
    }
  };

  const handleOperationDecision = async () => {
    const decision = selectedIndex === 0 ? 'approve' : 'reject';
    const newDecisions = new Map(operationDecisions);
    newDecisions.set(approvableOperations[currentOperationIndex].idx, decision);
    setOperationDecisions(newDecisions);

    // Move to next operation or finish
    if (currentOperationIndex < approvableOperations.length - 1) {
      setCurrentOperationIndex(currentOperationIndex + 1);
      setSelectedIndex(0);
    } else {
      // All decisions made, execute
      const approved: number[] = [];
      const rejected: number[] = [];

      newDecisions.forEach((decision, idx) => {
        if (decision === 'approve') {
          approved.push(idx);
        } else {
          rejected.push(idx);
        }
      });

      // Process both approved and rejected in one go
      setIsProcessing(true);
      setMenuState('processing');
      setElapsedTime(0);
      let result: CompletionResult = {
        success: 0,
        failed: approved.length,
        rejected: rejected.length,
        hasErrors: true,
      };

      try {
        const sessionSignal = onStart?.() || undefined;

        const operations = message.operations || [];
        const manager = new OperationManager(
          'none',
          operations,
          undefined,
          (op, operationIndex) => {
            // Update the message content when operation is executed
            const content = message.content.find((c) => c.operationIndex === operationIndex);
            if (content) {
              content.content = op.message || '';
              onMessageUpdate?.(message);
            }
          }
        );
        const ctx = await getContext(sessionSignal);

        let success = 0;
        let failed = 0;

        // Execute approved operations
        for (const idx of approved) {
          const op = operations[idx];
          await manager.execute(op, true, ctx);
          if (op.status === 'done') {
            success++;
          } else if (op.status === 'doneError') {
            failed++;
          }
        }

        // Mark rejected operations
        for (const idx of rejected) {
          operations[idx].status = 'rejected';
          manager.updateMessage(operations[idx]);
        }

        result = {
          success,
          failed,
          rejected: rejected.length,
          hasErrors: failed > 0,
        };
      } catch (error: any) {
        logger.log(`Failed to process operations: ${error.message}: ${error.stack}`);
      } finally {
        setComplete(result);
      }
    }
  };

  // Handle keyboard input - MUST be called unconditionally (before any returns)
  useInput(
    (input, key) => {
      if (isProcessing || approvableOperations.length === 0) return;

      // Handle Ctrl+C to reject and cancel
      if (key.ctrl && input === 'c') {
        if (menuState === 'main') {
          // Reject all operations
          rejectOperations(approvableOperations.map(({ idx }) => idx));
        } else if (menuState === 'approving-some') {
          // Reject remaining operations and process what we have so far
          const approved: number[] = [];
          const rejected: number[] = [];

          // Process decisions made so far
          operationDecisions.forEach((decision, idx) => {
            if (decision === 'approve') {
              approved.push(idx);
            } else {
              rejected.push(idx);
            }
          });

          // Reject all remaining operations that haven't been decided
          for (let i = currentOperationIndex; i < approvableOperations.length; i++) {
            rejected.push(approvableOperations[i].idx);
          }

          // Process both approved and rejected
          if (approved.length > 0 || rejected.length > 0) {
            setIsProcessing(true);
            setMenuState('processing');
            rejectOperations(rejected);
          }
        }
        return;
      }

      if (menuState === 'main') {
        // Main menu navigation
        const menuOptions = hasMultipleOperations ? 3 : 2;

        if (key.upArrow) {
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : menuOptions - 1));
        } else if (key.downArrow) {
          setSelectedIndex((prev) => (prev < menuOptions - 1 ? prev + 1 : 0));
        } else if (key.return) {
          handleMainMenuSelection();
        }
      } else if (menuState === 'approving-some') {
        // Operation-by-operation approval
        if (key.upArrow) {
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 1));
        } else if (key.downArrow) {
          setSelectedIndex((prev) => (prev < 1 ? prev + 1 : 0));
        } else if (key.return) {
          handleOperationDecision();
        }
      }
    },
    { isActive: !isProcessing && approvableOperations.length > 0 }
  );

  // Early return AFTER all hooks are called - but not if we're processing or showing completion
  if (approvableOperations.length === 0 && menuState !== 'processing' && menuState !== 'complete') {
    return null;
  }

  // Processing state
  if (menuState === 'processing') {
    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.PROCESSING_BORDER}
        paddingX={1}
        marginBottom={1}
        flexDirection="column"
      >
        <Text color={COLORS.PROCESSING_TEXT}>
          Processing operations... {formatTime(elapsedTime)}
        </Text>
      </Box>
    );
  }

  // Completion state
  if (menuState === 'complete' && completionResult) {
    const { success, failed, rejected, hasErrors } = completionResult;
    const borderColor = hasErrors ? COLORS.ERROR_BORDER : COLORS.SUCCESS_BORDER;
    const textColor = hasErrors ? COLORS.ERROR_TEXT : COLORS.SUCCESS_TEXT;

    let message = '';
    const parts: string[] = [];

    if (success > 0) {
      parts.push(`${success} completed`);
    }
    if (failed > 0) {
      parts.push(`${failed} failed`);
    }
    if (rejected > 0) {
      parts.push(`${rejected} rejected`);
    }

    if (parts.length === 1 && rejected > 0) {
      message = `✓ ${parts[0]}`;
    } else if (hasErrors) {
      message = `✗ ${parts.join(', ')}`;
    } else {
      message = `✓ ${parts.join(', ')}`;
    }

    return (
      <Box
        borderStyle="round"
        borderColor={borderColor}
        paddingX={1}
        marginBottom={1}
        flexDirection="column"
      >
        <Text color={textColor}>{message}</Text>
      </Box>
    );
  }

  if (menuState === 'main') {
    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.APPROVAL_BORDER}
        paddingX={1}
        marginBottom={1}
        flexDirection="column"
      >
        <Text bold color={COLORS.APPROVAL_BORDER}>
          {pluralize(approvableOperations.length, 'operation')} require approval (↑↓ to navigate, Enter to select):
        </Text>

        {hasMultipleOperations ? (
          <>
            <Box>
              <Text color={selectedIndex === 0 ? COLORS.APPROVAL_SELECTED : COLORS.APPROVAL_UNSELECTED}>
                {selectedIndex === 0 ? '▶ ' : '  '}Approve all
              </Text>
            </Box>
            <Box>
              <Text color={selectedIndex === 1 ? COLORS.APPROVAL_SELECTED : COLORS.APPROVAL_UNSELECTED}>
                {selectedIndex === 1 ? '▶ ' : '  '}Reject all
              </Text>
            </Box>
            <Box>
              <Text color={selectedIndex === 2 ? COLORS.APPROVAL_SELECTED : COLORS.APPROVAL_UNSELECTED}>
                {selectedIndex === 2 ? '▶ ' : '  '}Approve some
              </Text>
            </Box>
          </>
        ) : (
          <>
            <Box>
              <Text color={selectedIndex === 0 ? COLORS.APPROVAL_SELECTED : COLORS.APPROVAL_UNSELECTED}>
                {selectedIndex === 0 ? '▶ ' : '  '}Approve
              </Text>
            </Box>
            <Box>
              <Text color={selectedIndex === 1 ? COLORS.APPROVAL_SELECTED : COLORS.APPROVAL_UNSELECTED}>
                {selectedIndex === 1 ? '▶ ' : '  '}Reject
              </Text>
            </Box>
          </>
        )}
      </Box>
    );
  }

  // Approving some - show current operation
  const currentOp = approvableOperations[currentOperationIndex];

  return (
    <Box
      borderStyle="round"
      borderColor={COLORS.APPROVAL_BORDER}
      paddingX={1}
      marginBottom={1}
      flexDirection="column"
    >
      <Text bold color={COLORS.APPROVAL_BORDER}>
        Operation {currentOperationIndex + 1} of {approvableOperations.length}: {formatName(currentOp.op.type)}
      </Text>

      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>{currentOp.op.analysis}</Text>
      </Box>

      <Box>
        <Text color={selectedIndex === 0 ? COLORS.APPROVAL_SELECTED : COLORS.APPROVAL_UNSELECTED}>
          {selectedIndex === 0 ? '▶ ' : '  '}Approve
        </Text>
      </Box>
      <Box>
        <Text color={selectedIndex === 1 ? COLORS.APPROVAL_SELECTED : COLORS.APPROVAL_UNSELECTED}>
          {selectedIndex === 1 ? '▶ ' : '  '}Reject
        </Text>
      </Box>
    </Box>
  );
};
