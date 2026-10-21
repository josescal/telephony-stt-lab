import { describe, it, expect } from 'vitest';
import {
  encodePcm16ToWav,
  parseWavFile,
} from '../src/shared/audio/wavParser.js';
import {
  processBatchAudioForProfile,
  StreamingMicrophoneAgc,
  StreamingProfileProcessor,
} from '../src/shared/audio/profileProcessor.js';
import { float32ToPcm16 } from '../src/shared/audio/mulaw.js';
import {
  resolveGladiaAudioFormat,
  buildGladiaLiveSessionPayload,
} from '../src/shared/gladia/liveSession.js';

describe('WAV Parser and Audio Profile Processing Pipeline', () => {
  it('encodes 16-bit PCM to WAV and parses it back losslessly', () => {
    const sampleRate = 16000;
    const origFloat = new Float32Array(1600);
    for (let i = 0; i < origFloat.length; i++) {
      origFloat[i] = 0.5 * Math.sin((2 * Math.PI * 800 * i) / sampleRate);
    }

    const pcm16 = float32ToPcm16(origFloat);
    const wavBytes = encodePcm16ToWav(pcm16, sampleRate);

    const parsed = parseWavFile(wavBytes);
    expect(parsed.sampleRate).toBe(16000);
    expect(parsed.numChannels).toBe(1);
    expect(parsed.bitsPerSample).toBe(16);
    expect(parsed.audioFormatCode).toBe(1);
    expect(parsed.monoSamples.length).toBe(1600);
    expect(parsed.durationSeconds).toBeCloseTo(0.1, 4);

    for (let i = 0; i < 50; i++) {
      expect(parsed.monoSamples[i]).toBeCloseTo(origFloat[i]!, 3);
    }
  });

  it('processes audio differently and accurately across original, pcm_8000, and ulaw_8000 profiles', () => {
    const inputRate = 48000;
    const durationSec = 0.5;
    const numSamples = inputRate * durationSec;
    const compositeSignal = new Float32Array(numSamples);

    // Combine 60 Hz hum + 1000 Hz speech band + 6000 Hz high frequency
    for (let i = 0; i < numSamples; i++) {
      const t = i / inputRate;
      compositeSignal[i] =
        0.25 * Math.sin(2 * Math.PI * 60 * t) +
        0.5 * Math.sin(2 * Math.PI * 1000 * t) +
        0.2 * Math.sin(2 * Math.PI * 6000 * t);
    }

    const origResult = processBatchAudioForProfile(compositeSignal, inputRate, 'original');
    const pcm8kResult = processBatchAudioForProfile(compositeSignal, inputRate, 'pcm_8000');
    const ulaw8kResult = processBatchAudioForProfile(
      compositeSignal,
      inputRate,
      'ulaw_8000',
      'ulaw_8000'
    );
    const ulawDecodedTransportResult = processBatchAudioForProfile(
      compositeSignal,
      inputRate,
      'ulaw_8000',
      'pcm_8000_decoded'
    );

    // 1. Original profile keeps 48000 Hz wideband PCM16
    expect(origResult.outputSampleRate).toBe(48000);
    expect(origResult.elevenLabsFormat).toBe('pcm_48000');
    expect(origResult.previewPcm16.length).toBe(24000);
    expect(origResult.wireBytes.byteLength).toBe(48000); // 2 bytes per sample
    expect(origResult.muLawBytes).toBeNull();
    expect(origResult.quantizationSnrDb).toBeNull();

    // 2. PCM 8000 profile resamples to 8000 Hz (4000 samples) and encodes 2 bytes/sample (8000 bytes)
    expect(pcm8kResult.outputSampleRate).toBe(8000);
    expect(pcm8kResult.elevenLabsFormat).toBe('pcm_8000');
    expect(pcm8kResult.previewPcm16.length).toBe(4000);
    expect(pcm8kResult.wireBytes.byteLength).toBe(8000);
    expect(pcm8kResult.muLawBytes).toBeNull();

    // 3. G.711 u-law 8000 profile resamples to 8000 Hz and produces 1 byte/sample (4000 bytes) in native ulaw_8000 mode
    expect(ulaw8kResult.outputSampleRate).toBe(8000);
    expect(ulaw8kResult.elevenLabsFormat).toBe('ulaw_8000');
    expect(ulaw8kResult.previewPcm16.length).toBe(4000);
    expect(ulaw8kResult.wireBytes.byteLength).toBe(4000); // 1 byte per u-law sample
    expect(ulaw8kResult.muLawBytes).not.toBeNull();
    expect(ulaw8kResult.muLawBytes?.byteLength).toBe(4000);
    expect(ulaw8kResult.quantizationSnrDb).toBeGreaterThan(30);

    // Verify that the generated WAV file for ulaw_8000 is 8-bit, mono (1 channel), 8000 Hz ITU-T G.711 u-law (format code 7)
    const parsedUlawWav = parseWavFile(ulaw8kResult.previewWavBytes);
    expect(parsedUlawWav.sampleRate).toBe(8000);
    expect(parsedUlawWav.numChannels).toBe(1);
    expect(parsedUlawWav.bitsPerSample).toBe(8);
    expect(parsedUlawWav.audioFormatCode).toBe(7);
    expect(ulaw8kResult.previewWavBytes.byteLength).toBe(44 + 4000);

    // 4. G.711 u-law with pcm_8000_decoded transport sends the 16-bit reconstructed PCM after u-law quantization
    expect(ulawDecodedTransportResult.elevenLabsFormat).toBe('pcm_8000');
    expect(ulawDecodedTransportResult.wireBytes.byteLength).toBe(8000);

    // Verify that G.711 u-law decoded preview samples differ from un-companded pcm_8000 samples due to u-law quantization
    let quantizedDifferences = 0;
    for (let i = 0; i < pcm8kResult.previewPcm16.length; i++) {
      if (pcm8kResult.previewPcm16[i] !== ulaw8kResult.previewPcm16[i]) {
        quantizedDifferences++;
      }
    }
    expect(quantizedDifferences).toBeGreaterThan(3000);
  });

  it('streams chunks seamlessly via StreamingProfileProcessor', () => {
    const processor = new StreamingProfileProcessor('ulaw_8000', 16000, 'ulaw_8000');
    const chunk = new Float32Array(1600); // 100ms at 16kHz -> 800 samples at 8kHz
    for (let i = 0; i < chunk.length; i++) {
      chunk[i] = 0.4 * Math.sin((2 * Math.PI * 1000 * i) / 16000);
    }

    const processed = processor.processChunk(chunk);
    expect(processed.outputSampleRate).toBe(8000);
    expect(processed.elevenLabsFormat).toBe('ulaw_8000');
    expect(processed.wireBytes.length).toBe(800);
    expect(processed.wireBase64.length).toBeGreaterThan(1000);
  });

  it('maps audio profiles accurately to Gladia Live v2 parameters', () => {
    const ulawFmt = resolveGladiaAudioFormat('ulaw_8000', 48000);
    expect(ulawFmt).toEqual({
      encoding: 'wav/ulaw',
      bitDepth: 8,
      sampleRate: 8000,
      label: 'wav/ulaw 8000Hz (8-bit)',
    });

    const pcm8kFmt = resolveGladiaAudioFormat('pcm_8000', 48000);
    expect(pcm8kFmt).toEqual({
      encoding: 'wav/pcm',
      bitDepth: 16,
      sampleRate: 8000,
      label: 'wav/pcm 8000Hz (16-bit)',
    });

    const origFmt = resolveGladiaAudioFormat('original', 48000);
    expect(origFmt).toEqual({
      encoding: 'wav/pcm',
      bitDepth: 16,
      sampleRate: 48000,
      label: 'wav/pcm 48000Hz (16-bit)',
    });

    const payload = buildGladiaLiveSessionPayload({
      profileId: 'ulaw_8000',
      sampleRate: 8000,
      languageCode: 'es',
      endpointing: 0.3,
    });

    expect(payload.model).toBe('solaria-1');
    expect(payload.encoding).toBe('wav/ulaw');
    expect(payload.bit_depth).toBe(8);
    expect(payload.sample_rate).toBe(8000);
    expect(payload.language_config).toEqual({
      languages: ['es'],
      code_switching: false,
    });
    expect(payload.messages_config).toMatchObject({
      receive_partial_transcripts: true,
      receive_final_transcripts: true,
      receive_speech_events: true,
    });
  });

  it('normalizes quiet microphone audio via StreamingMicrophoneAgc before G.711 u-law encoding', () => {
    const agc = new StreamingMicrophoneAgc();
    const processor = new StreamingProfileProcessor('ulaw_8000', 16000, 'ulaw_8000');

    // Simulate a quiet microphone signal (~ -34 dBFS peak = 0.02 linear amplitude)
    const quietChunk = new Float32Array(4096);
    for (let i = 0; i < quietChunk.length; i++) {
      quietChunk[i] = 0.02 * Math.sin((2 * Math.PI * 1000 * i) / 16000);
    }

    const rawProcessed = processor.processChunk(quietChunk);
    processor.reset();
    const agcProcessed = processor.processChunk(agc.processChunk(quietChunk));

    // With AGC, G.711 u-law quantization SNR improves significantly and signal amplitude is boosted
    expect(agcProcessed.quantizationSnrDb!).toBeGreaterThan(rawProcessed.quantizationSnrDb!);
  });
});

