import { useState } from 'react';
import type { VoiceEngineId, VoicePreset } from '../../types';
import { gradeRank, presetsForEngine } from '../../lib/tts/voices';
import { previewVoice, stopPreview } from '../../lib/tts/preview';
import { Spinner } from './common';

/**
 * Voice list with a preview button on every row.
 *
 * Kokoro's own quality grade is shown next to each voice. The friendly preset
 * names are informed guesses about character, but the grade is measured, so it
 * is the honest signal for "will this sound good for a whole book".
 */

export function VoicePicker({
  engine,
  selectedId,
  onSelect,
  deviceVoiceURI,
  engineReady,
  onNeedsEngine,
}: {
  engine: VoiceEngineId;
  selectedId: string;
  onSelect: (preset: VoicePreset) => void;
  deviceVoiceURI: string | null;
  engineReady: boolean;
  onNeedsEngine: () => void;
}): React.JSX.Element {
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'female' | 'male'>('all');

  const presets = presetsForEngine(engine)
    .filter((p) => filter === 'all' || p.gender === filter)
    .slice()
    .sort((a, b) => gradeRank(a.quality) - gradeRank(b.quality));

  const handlePreview = async (preset: VoicePreset) => {
    if (engine === 'kokoro' && preset.engine === 'kokoro' && !engineReady) {
      onNeedsEngine();
      return;
    }
    setError(null);
    setPreviewing(preset.id);
    try {
      await previewVoice(preset, deviceVoiceURI, engine);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed.');
    } finally {
      setPreviewing(null);
    }
  };

  return (
    <div>
      <div className="chip-row" style={{ marginBottom: 12 }}>
        {(['all', 'female', 'male'] as const).map((f) => (
          <button
            key={f}
            className={`chip${filter === f ? ' active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All voices' : f === 'female' ? 'Female' : 'Male'}
          </button>
        ))}
      </div>

      {error ? (
        <div className="banner banner-error" style={{ marginBottom: 10 }}>
          <span aria-hidden="true">{'⚠️'}</span>
          <div>{error}</div>
        </div>
      ) : null}

      <div className="stack">
        {presets.map((preset) => {
          const selected = preset.id === selectedId;
          return (
            <div
              key={preset.id}
              className="card"
              style={{
                padding: 12,
                borderColor: selected ? 'var(--accent)' : 'var(--border)',
                background: selected ? 'var(--accent-soft)' : 'var(--surface)',
              }}
            >
              <div className="spread">
                <button
                  onClick={() => {
                    stopPreview();
                    onSelect(preset);
                  }}
                  style={{
                    background: 'none',
                    border: 0,
                    padding: 0,
                    textAlign: 'left',
                    flex: 1,
                    minWidth: 0,
                  }}
                  aria-pressed={selected}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 14.5 }}>{preset.label}</span>
                    {preset.quality ? (
                      <span
                        className="small"
                        style={{
                          padding: '1px 7px',
                          borderRadius: 999,
                          background: 'var(--surface-3)',
                          color: 'var(--text-dim)',
                          fontWeight: 600,
                        }}
                        title="Kokoro's published quality grade for this voice"
                      >
                        {preset.quality}
                      </span>
                    ) : null}
                  </div>
                  <div className="small muted" style={{ marginTop: 3 }}>
                    {preset.description}
                    {preset.kokoroVoice ? (
                      <span className="mono" style={{ marginLeft: 6, opacity: 0.7 }}>
                        {preset.kokoroVoice}
                      </span>
                    ) : null}
                  </div>
                </button>

                <button
                  className="btn btn-sm"
                  onClick={() => void handlePreview(preset)}
                  disabled={previewing !== null}
                  aria-label={`Preview ${preset.label}`}
                  style={{ flex: 'none' }}
                >
                  {previewing === preset.id ? <Spinner /> : <>&#9654; Preview</>}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
