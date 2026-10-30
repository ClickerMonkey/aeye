/**
 * Image, transcription, and speech mapping.
 */

import { AI, type AIContextAny, type ImageEditRequest } from '@aeye/ai';
import OpenAI from 'openai';
import { OpenAIProvider } from '../openai';

const mockEdit = jest.fn();
const mockGenerate = jest.fn();
const mockTranscribe = jest.fn();
const mockSpeech = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  images: { edit: mockEdit, generate: mockGenerate },
  audio: { transcriptions: { create: mockTranscribe }, speech: { create: mockSpeech } },
})));

const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: {} };
const provider = new OpenAIProvider({ apiKey: 'test' });
const png = 'data:image/png;base64,iVBORw0KGgo=';
const wav = 'data:audio/wav;base64,UklGRg==';

const lastCall = (mock: jest.Mock) => mock.mock.calls[mock.mock.calls.length - 1][0];

beforeEach(() => jest.clearAllMocks());

describe('images', () => {
  it('applies the edit hook to edits and sends every input image', async () => {
    mockEdit.mockResolvedValue({ data: [{ b64_json: 'out' }] });
    const edited: ImageEditRequest[] = [];
    class Tagging extends OpenAIProvider {
      protected override augmentImageEditRequest(params: OpenAI.ImageEditParams, request: ImageEditRequest) {
        params.user = 'edit-hook';
        edited.push(request);
      }
    }

    await new Tagging({ apiKey: 'test' }).editImage!({ prompt: 'Combine', image: [png, png], inputFidelity: 'high' }, ctx);

    expect(edited).toHaveLength(1);
    expect(lastCall(mockEdit)).toMatchObject({ user: 'edit-hook', input_fidelity: 'high', model: 'gpt-image-2' });
    expect(lastCall(mockEdit).image).toHaveLength(2);
  });

  it('snaps sizes, passes output options, and prices the image produced', async () => {
    mockGenerate.mockResolvedValue({
      data: [{ b64_json: 'a' }, { b64_json: 'b' }],
      quality: 'high',
      size: '1536x1024',
      usage: { input_tokens: 30, input_tokens_details: { text_tokens: 30, image_tokens: 0 }, output_tokens: 4000, total_tokens: 4030 },
    });

    const response = await provider.generateImage!({ prompt: 'Wide', size: '1600x900', n: 2, quality: 'high', outputFormat: 'webp', outputCompression: 80 }, ctx);

    expect(lastCall(mockGenerate)).toMatchObject({ size: '1536x1024', n: 2, quality: 'high', output_format: 'webp', output_compression: 80 });
    expect(response.usage).toEqual({
      text: { input: 30 },
      image: { input: 0, output: [{ quality: 'high', size: { width: 1536, height: 1024 }, count: 2 }] },
    });
  });

  it('passes auto size through', async () => {
    mockGenerate.mockResolvedValue({ data: [] });

    await provider.generateImage!({ prompt: 'Any', size: 'auto' }, ctx);

    expect(lastCall(mockGenerate).size).toBe('auto');
  });
});

describe('transcription', () => {
  it('returns bare-string formats as text', async () => {
    mockTranscribe.mockResolvedValue('1\n00:00:00,000 --> 00:00:01,000\nHello\n');

    const response = await provider.transcribe!({ audio: wav, responseFormat: 'srt' }, ctx);

    expect(response.text).toContain('Hello');
  });

  it('diarizes with known speakers', async () => {
    mockTranscribe.mockResolvedValue({
      text: 'Hi. Hello.',
      segments: [
        { id: 'seg_0', start: 0, end: 1, text: 'Hi.', speaker: 'Ana', type: 'transcript.text.segment' },
        { id: 'seg_1', start: 1, end: 2, text: 'Hello.', speaker: 'B', type: 'transcript.text.segment' },
      ],
      usage: { type: 'tokens', input_tokens: 50, input_token_details: { audio_tokens: 45, text_tokens: 5 }, output_tokens: 4, total_tokens: 54 },
    });

    const response = await provider.transcribe!({
      audio: wav,
      model: 'gpt-4o-transcribe-diarize',
      responseFormat: 'diarized_json',
      knownSpeakers: [{ name: 'Ana', audio: wav }],
    }, ctx);

    expect(lastCall(mockTranscribe)).toMatchObject({
      response_format: 'diarized_json',
      chunking_strategy: 'auto',
      known_speaker_names: ['Ana'],
      known_speaker_references: [wav],
    });
    expect(response.segments).toEqual([
      { id: 'seg_0', start: 0, end: 1, text: 'Hi.', speaker: 'Ana' },
      { id: 'seg_1', start: 1, end: 2, text: 'Hello.', speaker: 'B' },
    ]);
    expect(response.usage).toEqual({ text: { input: 5, output: 4 }, audio: { input: 45, output: undefined } });
  });
});

describe('speech', () => {
  it('passes any voice through, including custom voice ids', async () => {
    mockSpeech.mockResolvedValue({ body: new ReadableStream() });

    await provider.speech!({ text: 'Hi', voice: 'voice_custom123' }, ctx);

    expect(lastCall(mockSpeech).voice).toBe('voice_custom123');
  });
});
