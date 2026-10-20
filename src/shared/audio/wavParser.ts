import { decodeMuLawSample, pcm16ToFloat32 } from './mulaw.js';
import { downmixToMono } from './resampler.js';

export interface ParsedWavAudio {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  audioFormatCode: number; // 1 = PCM, 3 = IEEE Float, 7 = G.711 mu-law
  durationSeconds: number;
  monoSamples: Float32Array;
  channelSamples: Float32Array[];
}

function readAscii(view: DataView, offset: number, length: number): string {
  let str = '';
  for (let i = 0; i < length; i++) {
    str += String.fromCharCode(view.getUint8(offset + i));
  }
  return str;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Parse a standard RIFF/WAVE binary ArrayBuffer or Uint8Array into normalized Float32 samples.
 * Supports:
 * - Format 1 (Linear PCM: 8-bit unsigned, 16-bit signed, 24-bit signed, 32-bit signed)
 * - Format 3 (IEEE 32-bit / 64-bit Float)
 * - Format 7 (ITU-T G.711 8-bit μ-law)
 */
export function parseWavFile(buffer: ArrayBuffer | Uint8Array): ParsedWavAudio {
  const arrayBuffer =
    buffer instanceof Uint8Array
      ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      : buffer;

  if (arrayBuffer.byteLength < 44) {
    throw new Error('Invalid WAV file: buffer is smaller than minimum 44-byte RIFF header.');
  }

  const view = new DataView(arrayBuffer);
  const riffHeader = readAscii(view, 0, 4);
  const waveHeader = readAscii(view, 8, 4);

  if (riffHeader !== 'RIFF' || waveHeader !== 'WAVE') {
    throw new Error(`Invalid WAV file header: expected RIFF/WAVE, got ${riffHeader}/${waveHeader}`);
  }

  let offset = 12;
  let audioFormatCode = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new Error('Invalid WAV fmt chunk size.');
      }
      audioFormatCode = view.getUint16(chunkDataStart, true);
      numChannels = view.getUint16(chunkDataStart + 2, true);
      sampleRate = view.getUint32(chunkDataStart + 4, true);
      bitsPerSample = view.getUint16(chunkDataStart + 14, true);

      // Handle WAVE_FORMAT_EXTENSIBLE (0xFFFE)
      if (audioFormatCode === 0xfffe && chunkSize >= 40) {
        audioFormatCode = view.getUint16(chunkDataStart + 24, true);
      }
    } else if (chunkId === 'data') {
      dataOffset = chunkDataStart;
      dataLength = Math.min(chunkSize, view.byteLength - chunkDataStart);
      break;
    }

    // Chunks are word-aligned (padded to even byte boundary)
    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (numChannels <= 0 || sampleRate <= 0 || bitsPerSample <= 0) {
    throw new Error('Invalid WAV file: missing or malformed fmt chunk.');
  }

  if (dataOffset < 0 || dataLength <= 0) {
    throw new Error('Invalid WAV file: missing or empty data chunk.');
  }

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const totalFrames = Math.floor(dataLength / blockAlign);

  const channelSamples: Float32Array[] = Array.from(
    { length: numChannels },
    () => new Float32Array(totalFrames)
  );

  let cursor = dataOffset;
  for (let frame = 0; frame < totalFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = 0;

      if (audioFormatCode === 1) {
        // Linear PCM
        if (bitsPerSample === 8) {
          const u8 = view.getUint8(cursor);
          sample = (u8 - 128) / 128;
        } else if (bitsPerSample === 16) {
          const i16 = view.getInt16(cursor, true);
          sample = i16 < 0 ? i16 / 32768 : i16 / 32767;
        } else if (bitsPerSample === 24) {
          const b0 = view.getUint8(cursor);
          const b1 = view.getUint8(cursor + 1);
          const b2 = view.getUint8(cursor + 2);
          const i24 = (b0 | (b1 << 8) | (b2 << 16)) << 8 >> 8;
          sample = i24 < 0 ? i24 / 8388608 : i24 / 8388607;
        } else if (bitsPerSample === 32) {
          const i32 = view.getInt32(cursor, true);
          sample = i32 < 0 ? i32 / 2147483648 : i32 / 2147483647;
        } else {
          throw new Error(`Unsupported PCM bit depth: ${bitsPerSample}-bit`);
        }
      } else if (audioFormatCode === 3) {
        // IEEE Float
        if (bitsPerSample === 32) {
          sample = view.getFloat32(cursor, true);
        } else if (bitsPerSample === 64) {
          sample = view.getFloat64(cursor, true);
        } else {
          throw new Error(`Unsupported IEEE Float bit depth: ${bitsPerSample}-bit`);
        }
      } else if (audioFormatCode === 7 && bitsPerSample === 8) {
        // ITU-T G.711 mu-law
        const ulawByte = view.getUint8(cursor);
        const pcm16 = decodeMuLawSample(ulawByte);
        sample = pcm16 < 0 ? pcm16 / 32768 : pcm16 / 32767;
      } else {
        throw new Error(
          `Unsupported WAV format code ${audioFormatCode} with ${bitsPerSample} bits per sample.`
        );
      }

      channelSamples[ch]![frame] = Math.max(-1, Math.min(1, sample));
      cursor += bytesPerSample;
    }
  }

  const monoSamples = downmixToMono(channelSamples);
  const durationSeconds = totalFrames / sampleRate;

  return {
    sampleRate,
    numChannels,
    bitsPerSample,
    audioFormatCode,
    durationSeconds,
    monoSamples,
    channelSamples,
  };
}

/**
 * Encode mono 16-bit signed linear PCM samples into a standard 44-byte header WAV file (Uint8Array).
 */
export function encodePcm16ToWav(pcm16: Int16Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = 2;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = pcm16.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // Format 1 = Linear PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcm16.length; i++) {
    view.setInt16(offset, pcm16[i] ?? 0, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

/**
 * Helper to convert Int16Array into little-endian Uint8Array bytes for WebSocket streaming.
 */
export function pcm16ToLittleEndianBytes(pcm16: Int16Array): Uint8Array {
  const bytes = new Uint8Array(pcm16.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm16.length; i++) {
    view.setInt16(i * 2, pcm16[i] ?? 0, true);
  }
  return bytes;
}

/**
 * Compute RMS and Peak levels in dBFS from Float32 or Int16 samples.
 */
export function computeSignalLevels(samples: Float32Array | Int16Array): {
  rmsDbFs: number;
  peakDbFs: number;
  rmsLinear: number;
  peakLinear: number;
} {
  const floatSamples = samples instanceof Int16Array ? pcm16ToFloat32(samples) : samples;
  if (floatSamples.length === 0) {
    return { rmsDbFs: -96, peakDbFs: -96, rmsLinear: 0, peakLinear: 0 };
  }

  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < floatSamples.length; i++) {
    const abs = Math.abs(floatSamples[i] ?? 0);
    sumSq += abs * abs;
    if (abs > peak) {
      peak = abs;
    }
  }

  const rms = Math.sqrt(sumSq / floatSamples.length);
  const rmsDbFs = rms > 1e-5 ? Number((20 * Math.log10(rms)).toFixed(1)) : -96.0;
  const peakDbFs = peak > 1e-5 ? Number((20 * Math.log10(peak)).toFixed(1)) : -96.0;

  return {
    rmsDbFs,
    peakDbFs,
    rmsLinear: rms,
    peakLinear: peak,
  };
}
