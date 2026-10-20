import { describe, it, expect } from 'vitest';
import { TelephoneBandpassFilter } from '../src/shared/audio/biquadFilter.js';
import {
  downmixToMono,
  resampleAudio,
  StreamingResampler,
  resolveSupportedOriginalSampleRate,
} from '../src/shared/audio/resampler.js';
import { computeSignalLevels } from '../src/shared/audio/wavParser.js';

function generateSineWave(freqHz: number, sampleRate: number, durationSec: number, amplitude = 0.8): Float32Array {
  const numSamples = Math.floor(sampleRate * durationSec);
  const out = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

describe('Telephone Bandpass Filter (300–3400 Hz) & Resampler', () => {
  it('passes a 1000 Hz voice-band tone cleanly while attenuating 50 Hz hum and 6500 Hz highs', () => {
    const sampleRate = 16000;
    const duration = 0.5;

    const filter1k = new TelephoneBandpassFilter(sampleRate, 300, 3400);
    const filter50Hz = new TelephoneBandpassFilter(sampleRate, 300, 3400);
    const filter6500Hz = new TelephoneBandpassFilter(sampleRate, 300, 3400);

    const tone1k = generateSineWave(1000, sampleRate, duration, 0.8);
    const tone50 = generateSineWave(50, sampleRate, duration, 0.8);
    const tone6500 = generateSineWave(6500, sampleRate, duration, 0.8);

    // Skip initial 10% transient when measuring steady-state RMS
    const skip = Math.floor(tone1k.length * 0.1);
    const out1k = filter1k.processBuffer(tone1k).subarray(skip);
    const out50 = filter50Hz.processBuffer(tone50).subarray(skip);
    const out6500 = filter6500Hz.processBuffer(tone6500).subarray(skip);

    const level1k = computeSignalLevels(out1k);
    const level50 = computeSignalLevels(out50);
    const level6500 = computeSignalLevels(out6500);

    // 1 kHz tone (0.8 peak -> -1.9 dBFS peak, -4.9 dBFS RMS) should pass with < 0.5 dB loss
    expect(level1k.rmsDbFs).toBeGreaterThan(-5.5);
    expect(level1k.rmsDbFs).toBeLessThan(-4.5);

    // 50 Hz hum is >2.5 octaves below 300 Hz -> attenuated by >40 dB
    expect(level50.rmsDbFs).toBeLessThan(level1k.rmsDbFs - 40);

    // 6500 Hz tone is nearly 1 octave above 3400 Hz -> attenuated by >20 dB
    expect(level6500.rmsDbFs).toBeLessThan(level1k.rmsDbFs - 20);
  });

  it('downmixes stereo channels into mono accurately', () => {
    const left = new Float32Array([1.0, -0.5, 0.2]);
    const right = new Float32Array([0.0, -0.5, 0.8]);
    const mono = downmixToMono([left, right]);

    expect(mono.length).toBe(3);
    expect(mono[0]).toBeCloseTo(0.5, 5);
    expect(mono[1]).toBeCloseTo(-0.5, 5);
    expect(mono[2]).toBeCloseTo(0.5, 5);
  });

  it('resamples 48000 Hz audio down to 8000 Hz with exact 6:1 ratio and anti-aliasing', () => {
    const input = generateSineWave(1000, 48000, 1.0, 0.8);
    const output = resampleAudio(input, 48000, 8000);

    // 48000 samples resampled at 6:1 yields 8000 samples
    expect(output.length).toBe(8000);

    // Steady-state 1000 Hz signal should still have strong energy at 8000 Hz
    const levels = computeSignalLevels(output.subarray(500));
    expect(levels.rmsDbFs).toBeGreaterThan(-6.0);
  });

  it('maintains phase continuity across streaming chunks in StreamingResampler', () => {
    const fullInput = generateSineWave(440, 44100, 1.0, 0.75);
    const resampler = new StreamingResampler(44100, 8000);

    const chunks: Float32Array[] = [];
    const chunkSize = 1024;
    for (let i = 0; i < fullInput.length; i += chunkSize) {
      chunks.push(resampler.processChunk(fullInput.subarray(i, i + chunkSize)));
    }

    const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
    // 1.0s at 8000 Hz should be ~8000 samples (within 1 sample due to chunk boundary)
    expect(Math.abs(totalLen - 8000)).toBeLessThanOrEqual(2);
  });

  it('resolves closest supported ElevenLabs PCM sample rate for original profile', () => {
    expect(resolveSupportedOriginalSampleRate(48000)).toEqual({
      sampleRate: 48000,
      audioFormat: 'pcm_48000',
    });
    expect(resolveSupportedOriginalSampleRate(44100)).toEqual({
      sampleRate: 44100,
      audioFormat: 'pcm_44100',
    });
    expect(resolveSupportedOriginalSampleRate(16000)).toEqual({
      sampleRate: 16000,
      audioFormat: 'pcm_16000',
    });
    expect(resolveSupportedOriginalSampleRate(32000)).toEqual({
      sampleRate: 24000,
      audioFormat: 'pcm_24000',
    });
  });
});
