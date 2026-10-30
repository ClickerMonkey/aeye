import { MessageContentType, ModelInput, OutputModality, REASONING_EFFORTS, ReasoningEffort } from "@aeye/core";
import { ModelCapability, ModelInfo } from "./types";

/**
 * The capability a model needs to read each kind of message content.
 */
export const INPUT_CAPABILITIES: Partial<Record<MessageContentType, ModelCapability>> = {
  image: 'vision',
  file: 'files',
  audio: 'hearing',
  video: 'videoInput',
};

/**
 * The capability a chat model needs to produce each output modality beyond text.
 */
export const OUTPUT_CAPABILITIES: Partial<Record<OutputModality, ModelCapability>> = {
  image: 'image',
  audio: 'audioOutput',
};

/**
* Type guard to check if a ModelInput is a ModelInfo object.
* 
* @param input - The model input to check.
* @returns True if the input is a ModelInfo object, false otherwise.
*/
export function isModelInfo<TProvider extends string = string>(input: ModelInput): input is ModelInfo<TProvider> {
  return typeof input === 'object'
    && ('id' in input)
    && ('provider' in input)
    && ('name' in input)
    && ('capabilities' in input)
    && ('tier' in input)
    && ('pricing' in input)
    && ('contextWindow' in input);
}

/**
 * The accepted reasoning effort closest to the one asked for, preferring the
 * lower on a tie. Returns the effort unchanged when acceptance is unknown.
 *
 * @param effort - The effort asked for.
 * @param accepted - The efforts the model accepts, lowest to highest.
 * @returns The effort to send.
 */
export function clampReasoningEffort(effort: ReasoningEffort, accepted?: readonly ReasoningEffort[]): ReasoningEffort {
  if (!accepted?.length || accepted.includes(effort)) {
    return effort;
  }
  const distance = (e: ReasoningEffort) => Math.abs(REASONING_EFFORTS.indexOf(e) - REASONING_EFFORTS.indexOf(effort));
  return accepted.reduce((best, e) => distance(e) < distance(best) ? e : best);
}
