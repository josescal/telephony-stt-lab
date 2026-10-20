/**
 * Cascaded Biquad IIR Digital Filter Implementation
 *
 * Provides second-order (and cascaded fourth-order) Butterworth High-Pass and
 * Low-Pass IIR filters for authentic ITU-T PSTN telephone-band (300 Hz – 3400 Hz)
 * filtering and anti-aliasing prior to downsampling.
 *
 * Uses Direct Form II Transposed for numerical stability and preserves internal
 * state (`z1`, `z2`) across streaming audio chunks.
 */

export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export class BiquadFilter {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private z1 = 0;
  private z2 = 0;

  constructor(coeffs: BiquadCoefficients) {
    this.b0 = coeffs.b0;
    this.b1 = coeffs.b1;
    this.b2 = coeffs.b2;
    this.a1 = coeffs.a1;
    this.a2 = coeffs.a2;
  }

  /**
   * Design a 2nd-order Butterworth Low-Pass filter using Audio EQ Cookbook formulas.
   */
  static createLowPass(sampleRate: number, cutoffHz: number, q = Math.SQRT1_2): BiquadFilter {
    // Clamp cutoff safely below Nyquist frequency (0.495 * sampleRate)
    const safeCutoff = Math.max(10, Math.min(cutoffHz, sampleRate * 0.495));
    const omega = (2 * Math.PI * safeCutoff) / sampleRate;
    const sinW = Math.sin(omega);
    const cosW = Math.cos(omega);
    const alpha = sinW / (2 * q);

    const b0 = (1 - cosW) / 2;
    const b1 = 1 - cosW;
    const b2 = (1 - cosW) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cosW;
    const a2 = 1 - alpha;

    return new BiquadFilter({
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: a1 / a0,
      a2: a2 / a0,
    });
  }

  /**
   * Design a 2nd-order Butterworth High-Pass filter using Audio EQ Cookbook formulas.
   */
  static createHighPass(sampleRate: number, cutoffHz: number, q = Math.SQRT1_2): BiquadFilter {
    const safeCutoff = Math.max(10, Math.min(cutoffHz, sampleRate * 0.495));
    const omega = (2 * Math.PI * safeCutoff) / sampleRate;
    const sinW = Math.sin(omega);
    const cosW = Math.cos(omega);
    const alpha = sinW / (2 * q);

    const b0 = (1 + cosW) / 2;
    const b1 = -(1 + cosW);
    const b2 = (1 + cosW) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cosW;
    const a2 = 1 - alpha;

    return new BiquadFilter({
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: a1 / a0,
      a2: a2 / a0,
    });
  }

  /**
   * Process a single audio sample (Direct Form II Transposed).
   */
  processSample(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  /**
   * Process a Float32Array buffer, returning a new filtered Float32Array.
   */
  processBuffer(input: Float32Array): Float32Array {
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      output[i] = this.processSample(input[i] ?? 0);
    }
    return output;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}

/**
 * Cascaded 4th-order Butterworth Bandpass Filter for PSTN Telephone Audio (300 Hz – 3400 Hz).
 * Combines two cascaded 2nd-order High-Pass stages (at 300 Hz) and two cascaded
 * 2nd-order Low-Pass stages (at 3400 Hz) with optimal 4th-order Butterworth Q factors
 * (Q1 = 0.54119610, Q2 = 1.30656296) for a flat passband and steep 24 dB/octave roll-off.
 */
export class TelephoneBandpassFilter {
  private readonly stages: BiquadFilter[];

  constructor(sampleRate: number, highpassHz = 300, lowpassHz = 3400) {
    const q1 = 0.5411961;
    const q2 = 1.306563;

    this.stages = [
      BiquadFilter.createHighPass(sampleRate, highpassHz, q1),
      BiquadFilter.createHighPass(sampleRate, highpassHz, q2),
      BiquadFilter.createLowPass(sampleRate, lowpassHz, q1),
      BiquadFilter.createLowPass(sampleRate, lowpassHz, q2),
    ];
  }

  processSample(sample: number): number {
    let val = sample;
    for (const stage of this.stages) {
      val = stage.processSample(val);
    }
    return val;
  }

  processBuffer(input: Float32Array): Float32Array {
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      output[i] = this.processSample(input[i] ?? 0);
    }
    return output;
  }

  reset(): void {
    for (const stage of this.stages) {
      stage.reset();
    }
  }
}
