import { registerEngine } from './base/registry.js';
import { ElevenLabsAdapter, ELEVENLABS_METADATA } from './elevenlabs/adapter.js';
import { GladiaAdapter, GLADIA_METADATA } from './gladia/adapter.js';
import { GoogleSttAdapter, GOOGLE_METADATA } from './google/adapter.js';

// Auto-register built-in STT Engines
registerEngine(ELEVENLABS_METADATA, () => new ElevenLabsAdapter());
registerEngine(GLADIA_METADATA, () => new GladiaAdapter());
registerEngine(GOOGLE_METADATA, () => new GoogleSttAdapter());

export * from './base/types.js';
export * from './base/registry.js';
export { ElevenLabsAdapter, ELEVENLABS_METADATA } from './elevenlabs/adapter.js';
export { GladiaAdapter, GLADIA_METADATA } from './gladia/adapter.js';
export { GoogleSttAdapter, GOOGLE_METADATA } from './google/adapter.js';
