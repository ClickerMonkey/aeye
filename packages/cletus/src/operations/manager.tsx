
import { CletusAIContext } from "../ai";
import { ANALYSIS_END, ERROR_END, ANALYSIS_START, ERROR_START, formatName, formatValue, formatValueWithFormat, INPUT_END, INPUT_START, INSTRUCTIONS_END, INSTRUCTIONS_START, OUTPUT_END, OUTPUT_START } from "../common";
import { Operation, OperationKind } from "../schemas";
import { OperationDefinition, OperationDefinitionFor, OperationInput, OperationMode, Operations } from "./types";


/**
 * Mapping of operation modes to levels for comparison purposes.
 */
const ModeLevels: Record<OperationMode, number> = {
  local: -1,
  none: 0,
  read: 1,
  create: 2,
  update: 3,
  delete: 4,
};


/**
 * Operation Manager to handle operations based on the current chat mode.
 */
export class OperationManager {
  public constructor(
    public mode: OperationMode,
    public operations: Operation[] = [],
    public onOperationAdded?: (op: Operation, index: number) => void,
    public onOperationUpdated?: (op: Operation, index: number) => void,
  ) {
  }

  /**
   * If any operation requires approval.
   */
  public requiresApproval(offset: number = 0) {
    return this.operations.slice(offset).some(op => op.status === 'analyzed');
  }

  /**
   * If all operations are in a done state and we don't need approval.
   */
  public automatedOperations(offset: number = 0) {
    return this.operations.length > offset && !this.requiresApproval(offset);
  }

  /**
   * If the chat agent is in a state where it needs clarifications.
   */
  public needsUserInput(offset: number = 0) {
    return this.operations.length <= offset;
  }
  
  /**
   * Handle an operation based on the current mode.
   * 
   * @param operation - Operation input
   * @param ctx - Cletus core context
   * @returns Result message
   */
  public async handle<
    K extends OperationKind,
    C extends CletusAIContext,
  >(operation: OperationInput<K>, ctx: C): Promise<string> {
    const def = Operations[operation.type] as unknown as OperationDefinitionFor<K>;
    if (!def) {
      throw new Error(`Unknown operation type: ${operation.type}`);
    }
    const operationMode = typeof def.mode === 'function' ? def.mode(operation.input, ctx) : def.mode;
    const doNow = ModeLevels[this.mode] >= ModeLevels[operationMode];
    
    const op: Operation = {
      type: operation.type,
      input: operation.input,
      status: 'created',
      start: performance.now(),
    };

    this.operations.push(op);

    this.onOperationAdded?.(op, this.operations.length - 1);
    
    // Update status with operation description
    const statusMsg = def.status ? def.status(op.input) : `Processing operation: ${formatName(op.type)}`;
    ctx.chatStatus(statusMsg);

    const result = await this.execute(op, doNow, ctx);
    
    // Update status after operation completes
    ctx.chatStatus(`Analyzing ${formatName(op.type)} results...`);
    
    return result;
  }

  /**
   * Execute the operation, either analyzing or performing it.
   *
   * @param op - Operation record
   * @param doit - Whether the operation can be performed automatically
   * @param ctx - Cletus core context
   * @returns Result message
   */
  public async execute(op: Operation, doit: boolean, ctx: CletusAIContext): Promise<string> {
    const def = Operations[op.type] as OperationDefinition<any, any, any>;

    if (doit && op.status !== 'created' && op.status !== 'analyzed') {
      throw new Error(`Operation ${op.type} is not in a doable state. Current status: ${op.status}`);
    }
    if (!doit && op.status !== 'created') {
      throw new Error(`Operation ${op.type} has already been analyzed. Current status: ${op.status}`);
    }

    ctx.log(`op start: ${op.type} input=${JSON.stringify(op.input)}`);

    op.start = performance.now();
    op.end = undefined;
    try {
      if (doit) {
        op.status = 'doing';
        const result = await def.do(op, ctx);
        if (typeof result === 'object' && 'output' in result && 'cache' in result) {
          op.output = result.output;
          op.cache = result.cache;
        } else {
          op.output = result;
        }
        op.status = 'done';
      } else {
        op.status = 'analyzing';
        const analysisResult = await def.analyze(op, ctx);
        op.analysis = analysisResult.analysis;
        op.cache = analysisResult.cache;

        // Check if analysis completed the operation
        if (analysisResult.done) {
          op.output = analysisResult.output;
          op.status = 'done';
        } else {
          op.status = analysisResult.doable ? 'analyzed' : 'analyzedBlocked';
        }
      }
    } catch (e: any) {
      ctx.log(`op error: ${op.type} error=${e.message || String(e)} stack=${e.stack}`);

      op.error = e.message || String(e);
      op.status = doit ? 'doneError' : 'analyzeError';
    } finally {
      op.end = performance.now();
    }

    // Update the operation message based on its current state.
    const message = this.updateMessage(op);

    ctx.log(op);

    return message;
  }

  /**
   * Update the operation message based on its current state.
   * 
   * @param op - Operation to update
   */
  public updateMessage(op: Operation): string {
    const message = OperationManager.getContent(op);

    if (message !== op.message) {  
      op.message = message;

      this.onOperationUpdated?.(op, this.operations.indexOf(op));
    }

    return op.message;
  }

  /**
   * Get the content for an operation based on its state.
   * 
   * @param op - Operation
   * @param prioritizeAnalysis - Whether to prioritize analysis content
   * @returns 
   */
  public static getContent(op: Operation, prioritizeAnalysis: boolean = false): string {
    const def = Operations[op.type] as OperationDefinition<any, any, any>;
    let content = '';

    if (op.analysis && (prioritizeAnalysis || (!def.content && !op.error && op.output === undefined))) {
      content = `${ANALYSIS_START}${formatValue(op.analysis)}${ANALYSIS_END}`;
    } else if (def.content) {
      content = def.content(op);
    } else if (op.error) {
      content = `${ERROR_START}${op.error}${ERROR_END}`;
    } else if (op.output !== undefined) {
      const outputFormat = def.outputFormat || 'yaml';
      content = `${OUTPUT_START}${formatValueWithFormat(op.output, outputFormat)}${OUTPUT_END}`
      if (def.instructions) {
        content += `${INSTRUCTIONS_START}${def.instructions}${INSTRUCTIONS_END}`;
      }
    }

    return content;
  }
}