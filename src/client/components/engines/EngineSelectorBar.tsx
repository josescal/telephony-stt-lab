import React from 'react';
import { Check, AlertTriangle, Layers } from 'lucide-react';
import type { EngineId, EngineMetadata } from '../../../engines/index.js';

export interface EngineConfigStatus {
  id: EngineId;
  name: string;
  isConfigured: boolean;
  model: string;
}

interface EngineSelectorBarProps {
  availableEngines: EngineMetadata[];
  selectedEngineIds: EngineId[];
  onToggleEngine: (id: EngineId) => void;
  serverStatuses?: Record<string, boolean>; // engineId -> isConfigured
}

export const EngineSelectorBar: React.FC<EngineSelectorBarProps> = ({
  availableEngines,
  selectedEngineIds,
  onToggleEngine,
  serverStatuses = {},
}) => {
  return (
    <div className="engine-selector-bar">
      <div className="engine-selector-label">
        <Layers size={15} />
        <span>Motores STT Activos:</span>
      </div>
      <div className="engine-selector-chips">
        {availableEngines.map((engine) => {
          const isSelected = selectedEngineIds.includes(engine.id);
          const isConfigured = serverStatuses[engine.id] !== false;

          return (
            <button
              key={engine.id}
              type="button"
              className={`engine-chip ${isSelected ? 'engine-chip-active' : ''}`}
              onClick={() => onToggleEngine(engine.id)}
              title={`${engine.name} (${engine.defaultModel}) - Click para ${
                isSelected ? 'desactivar' : 'activar'
              }`}
            >
              <span className="engine-chip-checkbox">
                {isSelected && <Check size={12} strokeWidth={3} />}
              </span>
              <span className="engine-chip-name">{engine.name}</span>
              <span className="engine-chip-model">{engine.defaultModel}</span>
              {!isConfigured && (
                <span
                  className="engine-chip-warn"
                  title="Falta configurar la API Key de este motor en el archivo .env"
                >
                  <AlertTriangle size={12} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
