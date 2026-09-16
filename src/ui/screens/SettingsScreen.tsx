import { useEffect, useState } from 'react';
import type { HighlightMode, Settings, StartupMode, ThemeMode } from '../../types';
import { useApp } from '../../state/store';
import * as db from '../../lib/db';
import { kokoroClient } from '../../lib/tts/kokoro/client';
import { DTYPE_SIZE_MB } from '../../lib/tts/kokoro/protocol';
import { PronunciationEditor } from '../components/PronunciationEditor';
import { Banner, Segmented, SettingRow, Sheet, Switch } from '../components/common';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

export function SettingsScreen(): React.JSX.Element {
  const { settings, updateSettings, engineStatus, open, showToast, library } = useApp();
  const [cache, setCache] = useState<{ count: number; bytes: number } | null>(null);
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const [perDoc, setPerDoc] = useState<Map<string, { count: number; bytes: number }>>(new Map());
  const [budget, setBudget] = useState<db.BudgetInfo | null>(null);
  const [showPronunciation, setShowPronunciation] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const refreshStorage = async () => {
    setCache(await db.audioStats());
    setQuota(await db.storageEstimate());
    setPerDoc(await db.audioStatsByDoc());
    setBudget(await db.effectiveCacheBudget(settings.cacheBudgetGb));
  };

  useEffect(() => {
    void refreshStorage();
    // Re-measure when the budget preference changes so the warning stays true.
  }, [settings.cacheBudgetGb]);

  return (
    <div className="screen">
      <div className="topbar">
        <h1>Settings</h1>
      </div>

      <div className="container">
        <div className="section">
          <div className="section-head">
            <h2>Appearance</h2>
          </div>
          <div className="card">
            <SettingRow label="Theme">
              <Segmented<ThemeMode>
                value={settings.theme}
                onChange={(theme) => updateSettings({ theme })}
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' },
                ]}
              />
            </SettingRow>
          </div>

          <div className="card" style={{ marginTop: 10 }}>
            <div className="field">
              <label htmlFor="fs">Text size &middot; {Math.round(settings.fontScale * 100)}%</label>
              <input
                id="fs"
                type="range"
                min={0.8}
                max={1.8}
                step={0.05}
                value={settings.fontScale}
                onChange={(e) => updateSettings({ fontScale: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label htmlFor="lh">Line spacing &middot; {settings.lineHeight.toFixed(2)}</label>
              <input
                id="lh"
                type="range"
                min={1.3}
                max={2.2}
                step={0.05}
                value={settings.lineHeight}
                onChange={(e) => updateSettings({ lineHeight: Number(e.target.value) })}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="rw">
                Reading width &middot; {Math.round(settings.readingWidth * 100)}%
              </label>
              <input
                id="rw"
                type="range"
                min={0.7}
                max={1.5}
                step={0.05}
                value={settings.readingWidth}
                onChange={(e) => updateSettings({ readingWidth: Number(e.target.value) })}
              />
            </div>
          </div>
        </div>

        <div className="section">
          <div className="section-head">
            <h2>Reading</h2>
          </div>
          <div className="card">
            <SettingRow label="Highlight" hint="What lights up as the voice reads">
              <Segmented<HighlightMode>
                value={settings.highlight}
                onChange={(highlight) => updateSettings({ highlight })}
                options={[
                  { value: 'sentence', label: 'Sentence' },
                  { value: 'word', label: 'Word' },
                  { value: 'paragraph', label: 'Paragraph' },
                  { value: 'none', label: 'Off' },
                ]}
              />
            </SettingRow>
            <SettingRow label="Auto-scroll" hint="Keep the spoken text on screen">
              <Switch
                checked={settings.autoScroll}
                label="Auto-scroll"
                onChange={(autoScroll) => updateSettings({ autoScroll })}
              />
            </SettingRow>
            <SettingRow label="Skip interval">
              <select
                className="select"
                value={settings.skipSeconds}
                onChange={(e) => updateSettings({ skipSeconds: Number(e.target.value) })}
                aria-label="Skip interval"
              >
                {[10, 15, 30, 45, 60].map((s) => (
                  <option key={s} value={s}>
                    {s}s
                  </option>
                ))}
              </select>
            </SettingRow>
            <SettingRow label="Pronunciation" hint="Teach Narrato how to say names">
              <button className="btn btn-sm" onClick={() => setShowPronunciation(true)}>
                Edit
              </button>
            </SettingRow>
          </div>

          {settings.highlight === 'word' ? (
            <Banner kind="info">
              Word highlighting is exact with device voices. With Kokoro it is estimated from
              elapsed time, because the model does not report word timings - sentence
              highlighting tracks more closely.
            </Banner>
          ) : null}
        </div>

        <div className="section">
          <div className="section-head">
            <h2>Playback</h2>
          </div>
          <div className="card">
            <SettingRow
              label="Start mode"
              hint="How much audio to build before playback begins"
            >
              <Segmented<StartupMode>
                value={settings.startupMode}
                onChange={(startupMode) => updateSettings({ startupMode })}
                options={[
                  { value: 'fast', label: 'Fast' },
                  { value: 'balanced', label: 'Balanced' },
                  { value: 'smooth', label: 'Smooth' },
                ]}
              />
            </SettingRow>
            <SettingRow
              label="Battery saver"
              hint="Build a bigger buffer, then idle - fewer wake-ups, less heat"
            >
              <Switch
                checked={settings.batterySaver}
                label="Battery saver"
                onChange={(batterySaver) => updateSettings({ batterySaver })}
              />
            </SettingRow>
            <SettingRow label="Character voices" hint="Give detected speakers their own voice">
              <Switch
                checked={settings.characterVoices}
                label="Character voices"
                onChange={(characterVoices) => updateSettings({ characterVoices })}
              />
            </SettingRow>
          </div>
        </div>

        <div className="section">
          <div className="section-head">
            <h2>Storage</h2>
          </div>
          <div className="card">
            <SettingRow
              label="Cached audio"
              hint={
                cache
                  ? `${cache.count} clips · ${formatBytes(cache.bytes)}`
                  : 'Measuring...'
              }
            >
              <button className="btn btn-sm" onClick={() => setConfirmClear(true)}>
                Clear
              </button>
            </SettingRow>
            {quota ? (
              <SettingRow
                label="Device storage"
                hint={`${formatBytes(quota.usage)} used of about ${formatBytes(quota.quota)} available`}
              >
                <span />
              </SettingRow>
            ) : null}

            <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
              <label htmlFor="budget">
                Keep up to {settings.cacheBudgetGb} GB of audio
              </label>
              <input
                id="budget"
                type="range"
                min={1}
                max={db.MAX_CACHE_BUDGET_GB}
                step={1}
                value={settings.cacheBudgetGb}
                onChange={(e) => updateSettings({ cacheBudgetGb: Number(e.target.value) })}
              />
              <div className="small muted">
                Roughly {Math.round((settings.cacheBudgetGb * 1024 * 1024 * 1024) /
                  db.AUDIO_BYTES_PER_SEC / 3600)}{' '}
                hours of narration - about{' '}
                {Math.max(1, Math.round((settings.cacheBudgetGb * 1024 * 1024 * 1024) /
                  db.AUDIO_BYTES_PER_SEC / 3600 / 6))}{' '}
                full-length books. Older audio is deleted first once this is reached.
              </div>
            </div>
          </div>

          {budget?.quotaLimited ? (
            <Banner kind="warn">
              This browser will only grant about {formatBytes(budget.budget)} to Narrato, so the{' '}
              {settings.cacheBudgetGb} GB setting cannot be reached. Freeing space on the device
              usually raises the limit. Installing Narrato to your home screen also helps, as
              installed apps are given a larger, more durable allowance.
            </Banner>
          ) : null}

          {perDoc.size > 0 ? (
            <div className="card" style={{ marginTop: 10 }}>
              <div className="small muted" style={{ marginBottom: 8 }}>
                Audio stored per book. Books marked <strong>Keep offline</strong> are never
                deleted automatically - set that from the &#8942; menu in your library.
              </div>
              <div className="stack">
                {[...perDoc.entries()]
                  .map(([id, stat]) => ({
                    id,
                    stat,
                    meta: library.find((d) => d.id === id) ?? null,
                  }))
                  .sort((a, b) => b.stat.bytes - a.stat.bytes)
                  .map(({ id, stat, meta }) => (
                    <div key={id} className="spread">
                      <div style={{ minWidth: 0 }}>
                        <div className="truncate" style={{ fontSize: 13.5 }}>
                          {meta?.keepOffline ? '\u2B07 ' : ''}
                          {meta?.title ?? 'Deleted document'}
                        </div>
                        <div className="small muted">
                          {formatBytes(stat.bytes)} &middot; {stat.count} sections
                        </div>
                      </div>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          void db.clearAudioForDoc(id).then(refreshStorage);
                        }}
                      >
                        Delete audio
                      </button>
                    </div>
                  ))}
              </div>
            </div>
          ) : null}
          <p className="small muted" style={{ marginTop: 8 }}>
            Everything - your documents and the audio generated from them - is stored only on
            this device. Deleting a document deletes its audio too.
          </p>
        </div>

        <div className="section">
          <div className="section-head">
            <h2>Diagnostics</h2>
          </div>
          <div className="card">
            <SettingRow label="Show technical details" hint="Engine, buffer and queue state">
              <Switch
                checked={settings.showDiagnostics}
                label="Show diagnostics"
                onChange={(showDiagnostics) => updateSettings({ showDiagnostics })}
              />
            </SettingRow>

            {settings.showDiagnostics ? (
              <>
                <SettingRow
                  label="Voice backend"
                  hint="Auto uses WASM, the path that is verified before every release. WebGPU is much faster where it works, but its output quality depends on your browser's GPU support - try it, and switch back if the voice sounds distorted."
                >
                  <select
                    className="select"
                    value={settings.kokoroDevice}
                    onChange={(e) =>
                      updateSettings({
                        kokoroDevice: e.target.value as Settings['kokoroDevice'],
                      })
                    }
                    aria-label="Voice backend"
                  >
                    <option value="auto">Auto</option>
                    <option value="webgpu">WebGPU</option>
                    <option value="wasm">WASM</option>
                  </select>
                </SettingRow>

                <SettingRow
                  label="Voice quality"
                  hint={`Larger weights sound better but take longer to download (q8 ~${DTYPE_SIZE_MB.q8} MB, fp32 ~${DTYPE_SIZE_MB.fp32} MB). Changing this regenerates audio.`}
                >
                  <select
                    className="select"
                    value={settings.kokoroDtype}
                    onChange={(e) =>
                      updateSettings({ kokoroDtype: e.target.value as Settings['kokoroDtype'] })
                    }
                    aria-label="Voice quality"
                  >
                    <option value="auto">Auto</option>
                    <option value="q4f16">Smallest ({DTYPE_SIZE_MB.q4f16} MB)</option>
                    <option value="q8">Balanced ({DTYPE_SIZE_MB.q8} MB)</option>
                    <option value="fp32">Best ({DTYPE_SIZE_MB.fp32} MB)</option>
                  </select>
                </SettingRow>
              </>
            ) : null}

            {settings.showDiagnostics ? (
              <div className="small mono" style={{ paddingTop: 10, lineHeight: 1.8 }}>
                <div>
                  AI engine: {engineStatus.device?.toUpperCase() ?? 'not loaded'}
                  {engineStatus.dtype ? ` / ${engineStatus.dtype}` : ''}
                </div>
                <div>State: {engineStatus.state}</div>
                <div>
                  Real-time factor:{' '}
                  {engineStatus.rtf ? `${engineStatus.rtf.toFixed(2)}x` : 'not measured'}
                </div>
                <div>Open document: {open?.meta.title ?? 'none'}</div>
                <div>Chunks: {open?.chunks.length ?? 0}</div>
                <div>
                  WebGPU: {typeof navigator !== 'undefined' && 'gpu' in navigator ? 'yes' : 'no'}
                </div>
                <div>
                  Media Session:{' '}
                  {typeof navigator !== 'undefined' && 'mediaSession' in navigator ? 'yes' : 'no'}
                </div>
              </div>
            ) : null}
          </div>

          {settings.showDiagnostics ? (
            <button
              className="btn btn-block"
              style={{ marginTop: 10 }}
              onClick={() => {
                kokoroClient.reinit({
                  device: settings.kokoroDevice,
                  dtype: settings.kokoroDtype,
                });
                showToast('Reloading the voice engine with these settings.');
              }}
            >
              Reload voice engine
            </button>
          ) : null}
        </div>

        <div className="section">
          <p className="small muted">
            Narrato runs entirely in your browser. No account, no server, nothing uploaded.
            Only process material you are allowed to read - Narrato does not remove DRM or open
            paywalled content.
          </p>
        </div>
      </div>

      {showPronunciation ? (
        <PronunciationEditor
          onClose={() => setShowPronunciation(false)}
          docId={open?.meta.id ?? null}
          docTitle={open?.meta.title ?? null}
        />
      ) : null}

      {confirmClear ? (
        <Sheet title="Clear cached audio?" onClose={() => setConfirmClear(false)}>
          <p className="small muted">
            This deletes generated speech for every document. Your documents, positions and
            bookmarks are kept. Audio is regenerated as you listen again.
          </p>
          <div className="btn-row">
            <button
              className="btn btn-danger"
              onClick={() => {
                void db.clearAllAudio().then(() => {
                  void refreshStorage();
                  showToast('Cached audio cleared.');
                });
                setConfirmClear(false);
              }}
            >
              Clear all audio
            </button>
            <button className="btn" onClick={() => setConfirmClear(false)}>
              Cancel
            </button>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
