import { describe, it, expect } from 'vitest';
import {
  encodeMuLawSample,
  decodeMuLawSample,
  encodePcm16ToMuLaw,
  decodeMuLawToPcm16,
  float32ToPcm16,
  pcm16ToFloat32,
  processMuLawCompanding,
} from '../src/shared/audio/mulaw.js';

describe('ITU-T G.711 μ-law Encoder and Decoder', () => {
  it('encodes 0 linear PCM to 0xFF (or 0x7F) and decodes back to exactly 0', () => {
    const encodedZero = encodeMuLawSample(0);
    expect(encodedZero).toBe(0xff);
    expect(decodeMuLawSample(0xff)).toBe(0);
    expect(decodeMuLawSample(0x7f)).toBe(0);
  });

  it('preserves polarity (sign) for positive and negative PCM samples', () => {
    const posEncoded = encodeMuLawSample(4096);
    const negEncoded = encodeMuLawSample(-4096);

    const posDecoded = decodeMuLawSample(posEncoded);
    const negDecoded = decodeMuLawSample(negEncoded);

    expect(posDecoded).toBeGreaterThan(0);
    expect(negDecoded).toBeLessThan(0);
    expect(posDecoded).toBe(-negDecoded);
  });

  it('clamps extreme 16-bit PCM values at the G.711 clip ceiling (32635)', () => {
    const maxEncoded = encodeMuLawSample(32767);
    const clipEncoded = encodeMuLawSample(32635);
    expect(maxEncoded).toBe(clipEncoded);
    expect(maxEncoded).toBe(0x80);

    const minEncoded = encodeMuLawSample(-32768);
    const negClipEncoded = encodeMuLawSample(-32635);
    expect(minEncoded).toBe(negClipEncoded);
    expect(minEncoded).toBe(0x00);

    // Decoded full-scale magnitude in ITU-T G.711 u-law is +/- 32124
    expect(decodeMuLawSample(0x80)).toBe(32124);
    expect(decodeMuLawSample(0x00)).toBe(-32124);
  });

  it('maintains monotonic magnitude across the entire 16-bit linear input range', () => {
    let prevDecoded = -33000;
    for (let sample = -32768; sample <= 32767; sample += 64) {
      const u = encodeMuLawSample(sample);
      const d = decodeMuLawSample(u);
      expect(d).toBeGreaterThanOrEqual(prevDecoded);
      prevDecoded = d;
    }
  });

  it('achieves expected G.711 logarithmic SQNR (~35-40 dB) on a 1 kHz sine wave', () => {
    const sampleRate = 8000;
    const numSamples = 8000; // 1 second
    const floatSine = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      floatSine[i] = 0.7 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
    }

    const pcm16 = float32ToPcm16(floatSine);
    const { muLawBytes, decodedPcm16, quantizationSnrDb } = processMuLawCompanding(pcm16);

    expect(muLawBytes.length).toBe(numSamples);
    expect(decodedPcm16.length).toBe(numSamples);
    // Theoretical 8-bit G.711 mu-law SQNR for mid/high level sine wave is ~37-39 dB
    expect(quantizationSnrDb).toBeGreaterThan(33);
    expect(quantizationSnrDb).toBeLessThan(43);

    // Ensure quantization actually occurred on non-zero samples (at 1 kHz / 8 kHz, 25% of samples are exact 0 crossings)
    let diffCount = 0;
    for (let i = 0; i < numSamples; i++) {
      if (pcm16[i] !== decodedPcm16[i]) {
        diffCount++;
      }
    }
    expect(diffCount).toBeGreaterThanOrEqual(numSamples * 0.7);
  });

  it('converts Float32 <-> Int16 arrays accurately with proper clamping', () => {
    const floats = new Float32Array([-1.5, -1.0, -0.5, 0, 0.5, 1.0, 1.5]);
    const pcm16 = float32ToPcm16(floats);
    expect(pcm16[0]).toBe(-32768);
    expect(pcm16[1]).toBe(-32768);
    expect(pcm16[3]).toBe(0);
    expect(pcm16[5]).toBe(32767);
    expect(pcm16[6]).toBe(32767);

    const roundTrip = pcm16ToFloat32(pcm16);
    expect(roundTrip[1]).toBeCloseTo(-1.0, 4);
    expect(roundTrip[3]).toBe(0);
    expect(roundTrip[5]).toBeCloseTo(1.0, 4);

    const u8 = encodePcm16ToMuLaw(pcm16);
    const d16 = decodeMuLawToPcm16(u8);
    expect(d16.length).toBe(pcm16.length);
  });
});
