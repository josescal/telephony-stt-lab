import { BiquadFilter } from './biquadFilter.js';
import type { ElevenLabsAudioFormat } from '../types.js';

export const SUPPORTED_PCM_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000] as const;
export type SupportedPcmSampleRate = (typeof SUPPORTED_PCM_SAMPLE_RATES)[number];

/**
 * Find the closest supported ElevenLabs PCM sample rate for the 'original' wideband profile.
 * For wideband audio, prefers >= 16000 Hz unless the input itself is <= 8000 Hz.
 */
export function resolveSupportedOriginalSampleRate(inputSampleRate: number): {
  sampleRate: SupportedPcmSampleRate;
  audioFormat: ElevenLabsAudioFormat;
} {
  const candidates: SupportedPcmSampleRate[] =
    inputSampleRate <= 11025
      ? [8000, 16000, 22050, 24000, 44100, 48000]
      : [16000, 22050, 24000, 44100, 48000];

  let best: SupportedPcmSampleRate = candidates[0] ?? 16000;
  let minDiff = Math.abs(inputSampleRate - best);

  for (const rate of candidates) {
    const diff = Math.abs(inputSampleRate - rate);
    if (diff < minDiff) {
      minDiff = diff;
      best = rate;
    }
  }

  return {
    sampleRate: best,
    audioFormat: `pcm_${best}` as ElevenLabsAudioFormat,
  };
}

/**
 * Downmix interleaved or planar multi-channel audio into a single mono Float32Array.
 */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) {
    return new Float32Array(0);
  }
  const firstChannel = channels[0]!;
  if (channels.length === 1) {
    return new Float32Array(firstChannel);
  }

  const length = firstChannel.length;
  const mono = new Float32Array(length);
  const numChannels = channels.length;

  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      sum += channels[ch]?.[i] ?? 0;
    }
    mono[i] = sum / numChannels;
  }

  return mono;
}

/**
 * Stateful streaming resampler with anti-aliasing low-pass filtering when downsampling.
 * Preserves fractional sample position and filter states across consecutive audio chunks.
 */
export class StreamingResampler {
  private readonly inputRate: number;
  private readonly outputRate: number;
  private readonly step: number;
  private readonly antiAliasFilters: BiquadFilter[];
  private position = 0;
  private lastSample = 0;
  private hasLastSample = false;

  constructor(inputRate: number, outputRate: number) {
    if (inputRate <= 0 || outputRate <= 0) {
      throw new Error(`Invalid sample rates: input=${inputRate}, output=${outputRate}`);
    }
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.step = inputRate / outputRate;

    // When downsampling, apply a 4th-order Butterworth anti-aliasing low-pass filter
    // just below the target Nyquist frequency (0.45 * outputRate)
    if (outputRate < inputRate) {
      const antiAliasCutoff = outputRate * 0.45;
      this.antiAliasFilters = [
        BiquadFilter.createLowPass(inputRate, antiAliasCutoff, 0.5411961),
        BiquadFilter.createLowPass(inputRate, antiAliasCutoff, 1.306563),
      ];
    } else {
      this.antiAliasFilters = [];
    }
  }

  processChunk(inputChunk: Float32Array): Float32Array {
    if (inputChunk.length === 0) {
      return new Float32Array(0);
    }

    if (this.inputRate === this.outputRate) {
      return new Float32Array(inputChunk);
    }

    // Apply anti-aliasing filter before decimation
    let filtered = inputChunk;
    for (const filter of this.antiAliasFilters) {
      filtered = filter.processBuffer(filtered);
    }

    // Prepend the last sample from the previous chunk if available for seamless interpolation
    let buffer: Float32Array;
    if (this.hasLastSample) {
      buffer = new Float32Array(filtered.length + 1);
      buffer[0] = this.lastSample;
      buffer.set(filtered, 1);
    } else {
      buffer = filtered;
      this.position = 0;
    }

    const maxIndex = buffer.length - 1;
    if (maxIndex < 0) {
      return new Float32Array(0);
    }

    const estimatedOutLength = Math.max(0, Math.ceil((maxIndex - this.position) / this.step) + 1);
    const tempOut = new Float32Array(estimatedOutLength);
    let outIdx = 0;

    while (this.position <= maxIndex) {
      const indexFloor = Math.floor(this.position);
      const frac = this.position - indexFloor;
      const s0 = buffer[indexFloor] ?? 0;
      const s1 = indexFloor + 1 <= maxIndex ? (buffer[indexFloor + 1] ?? s0) : s0;

      tempOut[outIdx++] = s0 + frac * (s1 - s0);
      this.position += this.step;
    }

    // Advance position relative to the next chunk (which will have buffer[maxIndex] at index 0)
    this.position -= maxIndex;
    this.lastSample = buffer[maxIndex] ?? 0;
    this.hasLastSample = true;

    return tempOut.subarray(0, outIdx);
  }

  reset(): void {
    this.position = 0;
    this.lastSample = 0;
    this.hasLastSample = false;
    for (const filter of this.antiAliasFilters) {
      filter.reset();
    }
  }
}

/**
 * Batch resample a complete mono Float32Array from `inputRate` to `outputRate`.
 */
export function resampleAudio(
  input: Float32Array,
  inputRate: number,
  outputRate: number
): Float32Array {
  const resampler = new StreamingResampler(inputRate, outputRate);
  return resampler.processChunk(input);
}
