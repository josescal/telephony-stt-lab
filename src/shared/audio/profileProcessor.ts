import type {
  AudioProfileId,
  ElevenLabsAudioFormat,
  G711WireTransport,
} from '../types.js';
import { TelephoneBandpassFilter } from './biquadFilter.js';
import { float32ToPcm16, processMuLawCompanding } from './mulaw.js';
import {
  resolveSupportedOriginalSampleRate,
  StreamingResampler,
} from './resampler.js';
import {
  computeSignalLevels,
  encodePcm16ToWav,
  pcm16ToLittleEndianBytes,
} from './wavParser.js';

export interface ProcessedAudioChunk {
  wireBytes: Uint8Array;
  wireBase64: string;
  previewPcm16: Int16Array;
  muLawBytes: Uint8Array | null;
  outputSampleRate: number;
  elevenLabsFormat: ElevenLabsAudioFormat;
  quantizationSnrDb: number | null;
}

export interface BatchProcessedProfileAudio {
  profileId: AudioProfileId;
  inputSampleRate: number;
  outputSampleRate: number;
  elevenLabsFormat: ElevenLabsAudioFormat;
  wireBytes: Uint8Array;
  previewPcm16: Int16Array;
  previewWavBytes: Uint8Array;
  muLawBytes: Uint8Array | null;
  durationSeconds: number;
  rmsDbFs: number;
  peakDbFs: number;
  quantizationSnrDb: number | null;
}

/**
 * Cross-environment Uint8Array -> Base64 encoder (works in Browser and Node.js).
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

/**
 * Cross-environment Base64 -> Uint8Array decoder.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Stateful real-time audio processor for a given AudioProfileId.
 * Maintains IIR bandpass filter state and fractional resampler state across chunks.
 */
export class StreamingProfileProcessor {
  public readonly profileId: AudioProfileId;
  public readonly inputSampleRate: number;
  public readonly outputSampleRate: number;
  public readonly elevenLabsFormat: ElevenLabsAudioFormat;
  public readonly g711WireTransport: G711WireTransport;

  private readonly bandpassFilter: TelephoneBandpassFilter | null;
  private readonly resampler: StreamingResampler;

  constructor(
    profileId: AudioProfileId,
    inputSampleRate: number,
    g711WireTransport: G711WireTransport = 'ulaw_8000'
  ) {
    this.profileId = profileId;
    this.inputSampleRate = inputSampleRate;
    this.g711WireTransport = g711WireTransport;

    if (profileId === 'original') {
      const resolved = resolveSupportedOriginalSampleRate(inputSampleRate);
      this.outputSampleRate = resolved.sampleRate;
      this.elevenLabsFormat = resolved.audioFormat;
      this.bandpassFilter = null;
      this.resampler = new StreamingResampler(inputSampleRate, this.outputSampleRate);
    } else if (profileId === 'pcm_8000') {
      this.outputSampleRate = 8000;
      this.elevenLabsFormat = 'pcm_8000';
      this.bandpassFilter = new TelephoneBandpassFilter(inputSampleRate, 300, 3400);
      this.resampler = new StreamingResampler(inputSampleRate, 8000);
    } else {
      // ulaw_8000
      this.outputSampleRate = 8000;
      this.elevenLabsFormat =
        g711WireTransport === 'pcm_8000_decoded' ? 'pcm_8000' : 'ulaw_8000';
      this.bandpassFilter = new TelephoneBandpassFilter(inputSampleRate, 300, 3400);
      this.resampler = new StreamingResampler(inputSampleRate, 8000);
    }
  }

  /**
   * Process a chunk of mono Float32 samples at `inputSampleRate` and return the
   * encoded wire payload + preview 16-bit PCM samples.
   */
  processChunk(monoInput: Float32Array): ProcessedAudioChunk {
    // Step 1: Telephone-band filtering (300–3400 Hz) if profile requires it
    const filtered = this.bandpassFilter
      ? this.bandpassFilter.processBuffer(monoInput)
      : monoInput;

    // Step 2: Resample to outputSampleRate
    const resampled = this.resampler.processChunk(filtered);

    // Step 3: Convert to 16-bit linear PCM
    const linearPcm16 = float32ToPcm16(resampled);

    // Step 4: If G.711 μ-law profile, perform actual μ-law encoding & decoding
    if (this.profileId === 'ulaw_8000') {
      const { muLawBytes, decodedPcm16, quantizationSnrDb } =
        processMuLawCompanding(linearPcm16);

      const wireBytes =
        this.g711WireTransport === 'pcm_8000_decoded'
          ? pcm16ToLittleEndianBytes(decodedPcm16)
          : muLawBytes;

      return {
        wireBytes,
        wireBase64: uint8ArrayToBase64(wireBytes),
        previewPcm16: decodedPcm16,
        muLawBytes,
        outputSampleRate: this.outputSampleRate,
        elevenLabsFormat: this.elevenLabsFormat,
        quantizationSnrDb,
      };
    }

    // For 'original' and 'pcm_8000'
    const wireBytes = pcm16ToLittleEndianBytes(linearPcm16);
    return {
      wireBytes,
      wireBase64: uint8ArrayToBase64(wireBytes),
      previewPcm16: linearPcm16,
      muLawBytes: null,
      outputSampleRate: this.outputSampleRate,
      elevenLabsFormat: this.elevenLabsFormat,
      quantizationSnrDb: null,
    };
  }

  reset(): void {
    this.bandpassFilter?.reset();
    this.resampler.reset();
  }
}

/**
 * Batch process an entire mono Float32 buffer through the selected audio profile.
 * Useful for WAV file uploads, preview playback generation, and unit testing.
 */
export function processBatchAudioForProfile(
  monoInput: Float32Array,
  inputSampleRate: number,
  profileId: AudioProfileId,
  g711WireTransport: G711WireTransport = 'ulaw_8000'
): BatchProcessedProfileAudio {
  const processor = new StreamingProfileProcessor(
    profileId,
    inputSampleRate,
    g711WireTransport
  );
  const chunkResult = processor.processChunk(monoInput);
  const previewWavBytes = encodePcm16ToWav(
    chunkResult.previewPcm16,
    chunkResult.outputSampleRate
  );
  const levels = computeSignalLevels(chunkResult.previewPcm16);
  const durationSeconds =
    chunkResult.outputSampleRate > 0
      ? chunkResult.previewPcm16.length / chunkResult.outputSampleRate
      : 0;

  return {
    profileId,
    inputSampleRate,
    outputSampleRate: chunkResult.outputSampleRate,
    elevenLabsFormat: chunkResult.elevenLabsFormat,
    wireBytes: chunkResult.wireBytes,
    previewPcm16: chunkResult.previewPcm16,
    previewWavBytes,
    muLawBytes: chunkResult.muLawBytes,
    durationSeconds,
    rmsDbFs: levels.rmsDbFs,
    peakDbFs: levels.peakDbFs,
    quantizationSnrDb: chunkResult.quantizationSnrDb,
  };
}
