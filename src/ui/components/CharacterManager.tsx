import { useState } from 'react';
import { useApp } from '../../state/store';
import { presetsForEngine } from '../../lib/tts/voices';
import { previewVoice } from '../../lib/tts/preview';
import { Banner, Sheet, Switch } from './common';

/**
 * Character voice manager.
 *
 * Detection only attributes a line when the text says who is speaking
 * ("...", said Marcus). Anything ambiguous stays with the narrator, and every
 * assignment here is editable - including adding a character the detector
 * missed and deleting one it invented.
 */
export function CharacterManager({ onClose }: { onClose: () => void }): React.JSX.Element {
  const {
    characters,
    detectDocCharacters,
    setCharacterVoice,
    addCharacter,
    removeCharacter,
    settings,
    updateSettings,
    reloadOpenDoc,
    preset,
  } = useApp();

  const [scanning, setScanning] = useState(false);
  const [newName, setNewName] = useState('');
  const presets = presetsForEngine(settings.engine);

  const handleScan = async () => {
    setScanning(true);
    try {
      await detectDocCharacters();
    } finally {
      setScanning(false);
    }
  };

  return (
    <Sheet title="Character voices" onClose={onClose}>
      <div className="row">
        <div style={{ minWidth: 0 }}>
          <div className="row-label">Use character voices</div>
          <div className="row-hint">
            Splits audio at dialogue boundaries so each speaker can have their own voice.
            Re-generates audio from here on.
          </div>
        </div>
        <Switch
          checked={settings.characterVoices}
          label="Use character voices"
          onChange={(v) => {
            updateSettings({ characterVoices: v });
            // Chunk boundaries change, so the document must be re-planned.
            void reloadOpenDoc();
          }}
        />
      </div>

      {!settings.characterVoices ? (
        <Banner kind="info">
          Turn this on to assign voices. Everything not attributed to a character keeps using
          the narrator voice, <strong>{preset.label}</strong>.
        </Banner>
      ) : null}

      <div className="btn-row" style={{ margin: '14px 0' }}>
        <button className="btn" onClick={() => void handleScan()} disabled={scanning}>
          {scanning ? 'Scanning...' : 'Scan for characters'}
        </button>
      </div>

      {characters.length === 0 ? (
        <p className="small muted">
          No characters yet. Scan the document, or add a speaker by name below.
        </p>
      ) : (
        <div className="stack">
          {characters.map((c) => (
            <div key={c.id} className="card" style={{ padding: 12 }}>
              <div className="spread" style={{ marginBottom: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{c.name}</div>
                  <div className="small muted">
                    {c.manual ? 'Added manually' : `${c.lineCount} detected lines`}
                  </div>
                </div>
                <button
                  className="icon-btn"
                  onClick={() => void removeCharacter(c.id)}
                  aria-label={`Remove ${c.name}`}
                >
                  &#128465;
                </button>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  className="select"
                  value={c.presetId ?? ''}
                  onChange={(e) => void setCharacterVoice(c.id, e.target.value || null)}
                  aria-label={`Voice for ${c.name}`}
                >
                  <option value="">Narrator voice</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                      {p.quality ? ` (${p.quality})` : ''}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-sm"
                  style={{ flex: 'none' }}
                  disabled={!c.presetId}
                  onClick={() => {
                    const chosen = presets.find((p) => p.id === c.presetId);
                    if (chosen) void previewVoice(chosen, settings.deviceVoiceURI, settings.engine);
                  }}
                  aria-label={`Preview voice for ${c.name}`}
                >
                  &#9654;
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="field" style={{ marginTop: 16 }}>
        <label htmlFor="newchar">Add a character</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="newchar"
            className="input"
            value={newName}
            placeholder="Name as it appears in the book"
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            className="btn"
            style={{ flex: 'none' }}
            onClick={() => {
              void addCharacter(newName);
              setNewName('');
            }}
            disabled={newName.trim() === ''}
          >
            Add
          </button>
        </div>
      </div>
    </Sheet>
  );
}
