import type {
  EngineId,
  EngineMetadata,
  STTEngineAdapter,
} from './types.js';

export type AdapterFactory = () => STTEngineAdapter;

interface EngineRegistration {
  metadata: EngineMetadata;
  factory: AdapterFactory;
}

const engineRegistry = new Map<EngineId, EngineRegistration>();

/**
 * Registers an STT Engine Adapter into the central registry.
 */
export function registerEngine(
  metadata: EngineMetadata,
  factory: AdapterFactory
): void {
  engineRegistry.set(metadata.id, { metadata, factory });
}

/**
 * Retrieves metadata for all registered engines.
 */
export function getRegisteredEngines(): EngineMetadata[] {
  return Array.from(engineRegistry.values()).map((r) => r.metadata);
}

/**
 * Retrieves metadata for a specific engine.
 */
export function getEngineMetadata(id: EngineId): EngineMetadata | undefined {
  return engineRegistry.get(id)?.metadata;
}

/**
 * Instantiates an adapter for the specified engine.
 */
export function createEngineAdapter(id: EngineId): STTEngineAdapter {
  const reg = engineRegistry.get(id);
  if (!reg) {
    throw new Error(`Engine "${id}" is not registered in the STT Engine Registry.`);
  }
  return reg.factory();
}

/**
 * Checks if an engine is registered.
 */
export function isEngineRegistered(id: EngineId): boolean {
  return engineRegistry.has(id);
}
