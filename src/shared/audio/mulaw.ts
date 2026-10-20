/**
 * ITU-T Recommendation G.711 μ-law (u-law, mu=255) Encoder & Decoder
 *
 * Implements standard logarithmic companding between 16-bit signed linear PCM
 * and 8-bit G.711 μ-law telephony audio bytes, plus Float32 conversion helpers
 * and quantization SNR measurement.
 */

const MULAW_BIAS = 0x84; // 132
const MULAW_CLIP = 32635;

const EXP_LUT = [
  0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
] as const;

/**
 * Encode a single 16-bit signed linear PCM sample [-32768, 32767]
 * into an 8-bit ITU-T G.711 μ-law byte [0, 255].
 */
export function encodeMuLawSample(pcm16Sample: number): number {
  let sample = Math.trunc(pcm16Sample);
  let sign = 0;

  if (sample < 0) {
    sample = -sample;
    sign = 0x80;
  }

  if (sample > MULAW_CLIP) {
    sample = MULAW_CLIP;
  }

  sample += MULAW_BIAS;

  const exponent = EXP_LUT[(sample >> 7) & 0xff] ?? 0;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;

  return ulawByte;
}

/**
 * Decode a single 8-bit ITU-T G.711 μ-law byte [0, 255]
 * back into a 16-bit signed linear PCM sample [-32124, 32124].
 */
export function decodeMuLawSample(ulawByte: number): number {
  const u = ~ulawByte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;

  const magnitude = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  if (magnitude === 0) {
    return 0;
  }
  return sign !== 0 ? -magnitude : magnitude;
}

/**
 * Encode an Int16Array of linear PCM samples into a Uint8Array of G.711 μ-law bytes.
 */
export function encodePcm16ToMuLaw(pcm16: Int16Array): Uint8Array {
  const output = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    output[i] = encodeMuLawSample(pcm16[i] ?? 0);
  }
  return output;
}

/**
 * Decode a Uint8Array of G.711 μ-law bytes into an Int16Array of linear PCM samples.
 */
export function decodeMuLawToPcm16(ulawBytes: Uint8Array): Int16Array {
  const output = new Int16Array(ulawBytes.length);
  for (let i = 0; i < ulawBytes.length; i++) {
    output[i] = decodeMuLawSample(ulawBytes[i] ?? 0xff);
  }
  return output;
}

/**
 * Convert Float32Array [-1.0, 1.0] to Int16Array [-32768, 32767] with proper clamping.
 */
export function float32ToPcm16(floatSamples: Float32Array): Int16Array {
  const output = new Int16Array(floatSamples.length);
  for (let i = 0; i < floatSamples.length; i++) {
    const val = floatSamples[i] ?? 0;
    const clamped = Math.max(-1, Math.min(1, val));
    output[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  return output;
}

/**
 * Convert Int16Array [-32768, 32767] to normalized Float32Array [-1.0, 1.0].
 */
export function pcm16ToFloat32(pcm16: Int16Array): Float32Array {
  const output = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    const s = pcm16[i] ?? 0;
    output[i] = s < 0 ? s / 32768 : s / 32767;
  }
  return output;
}

/**
 * Perform a full G.711 μ-law encode -> decode round-trip on 16-bit PCM samples,
 * returning both the 8-bit μ-law encoded buffer, the reconstructed 16-bit PCM buffer,
 * and the measured Signal-to-Quantization-Noise Ratio (SQNR) in dB.
 */
export function processMuLawCompanding(pcm16: Int16Array): {
  muLawBytes: Uint8Array;
  decodedPcm16: Int16Array;
  quantizationSnrDb: number;
} {
  const muLawBytes = encodePcm16ToMuLaw(pcm16);
  const decodedPcm16 = decodeMuLawToPcm16(muLawBytes);

  let signalPower = 0;
  let noisePower = 0;

  for (let i = 0; i < pcm16.length; i++) {
    const orig = pcm16[i] ?? 0;
    const recon = decodedPcm16[i] ?? 0;
    const err = orig - recon;
    signalPower += orig * orig;
    noisePower += err * err;
  }

  let quantizationSnrDb = 0;
  if (signalPower > 0 && noisePower > 0) {
    quantizationSnrDb = Number((10 * Math.log10(signalPower / noisePower)).toFixed(2));
  } else if (signalPower > 0 && noisePower === 0) {
    quantizationSnrDb = 96.0;
  }

  return {
    muLawBytes,
    decodedPcm16,
    quantizationSnrDb,
  };
}
