import { useEffect, useState } from 'react';
import type { VoiceEngineId } from '../../types';
import { useApp } from '../../state/store';
import { kokoroClient } from '../../lib/tts/kokoro/client';
import { DTYPE_SIZE_MB } from '../../lib/tts/kokoro/protocol';
import { isPremiumConfigured } from '../../lib/tts/premium';
import { VoicePicker } from '../components/VoicePicker';
import { Banner, ProgressBar } from '../components/common';

/**
 * Voice engine and preset selection.
 *
 * Three engines, and the trade-off between them is stated plainly rather than
 * buried: Kokoro is free and private but needs a one-time download and real
 * compute; device voices are instant but robotic and unreliable in the
 * background; premium needs a relay the user hosts themselves.
 */

const ENGINES: Array<{
  id: VoiceEngineId;
  title: string;
  blurb: string;
  badge: string;
}> = [
  {
    id: 'kokoro',
    title: 'Kokoro AI',
    blurb:
      'Natural AI voices that run entirely on your device. No account, no API key, no per-character cost. One-time model download.',
    badge: 'Free · Recommended',
  },
  {
    id: 'device',
    title: 'Device voices',
    blurb:
      'Your phone or browser’s built-in speech. Instant and uses no storage, but noticeably more robotic, and it usually stops when the screen locks.',
    badge: 'Free · Fallback',
  },
  {
    id: 'premium',
    title: 'Premium cloud voices',
    blurb:
      'Optional. Routed through a relay you host, so your API key never ships in the page. See "Premium voices" in the README.',
    badge: 'Needs setup',
  },
];

export function VoicesScreen({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { settings, updateSettings, engineStatus, showToast } = useApp();
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);

  // The system voice list arrives asynchronously on most browsers.
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const load = () => setSystemVoices(synth.getVoices());
    load();
    synth.addEventListener('voiceschanged', load);
    return () => synth.removeEventListener('voiceschanged', load);
  }, []);

  const premiumConfigured = isPremiumConfigured();

  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" onClick={onBack} aria-label="Back">
          &#8592;
        </button>
        <h1>Voices</h1>
      </div>

      <div className="container">
        <div className="section">
          <div className="section-head">
            <h2>Voice engine</h2>
          </div>
          <div className="stack">
            {ENGINES.map((eng) => {
              const active = settings.engine === eng.id;
              const disabled = eng.id === 'premium' && !premiumConfigured;
              return (
                <button
                  key={eng.id}
                  className="card"
                  onClick={() => {
                    if (disabled) {
                      showToast(
                        'Premium voices need a relay URL. See "Premium voices" in the README.'
                      );
                      return;
                    }
                    updateSettings({ engine: eng.id });
                    if (eng.id === 'kokoro') kokoroClient.init();
                  }}
                  style={{
                    textAlign: 'left',
                    width: '100%',
                    borderColor: active ? 'var(--accent)' : 'var(--border)',
                    background: active ? 'var(--accent-soft)' : 'var(--surface)',
                    opacity: disabled ? 0.6 : 1,
                  }}
                  aria-pressed={active}
                >
                  <div className="spread">
                    <strong>{eng.title}</strong>
                    <span className="small muted">{eng.badge}</span>
                  </div>
                  <p className="small muted" style={{ margin: '6px 0 0' }}>
                    {eng.blurb}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        {settings.engine === 'kokoro' ? (
          <div className="section">
            {engineStatus.state === 'loading' ? (
              <div className="card">
                <strong>{engineStatus.message}</strong>
                <p className="small muted" style={{ margin: '6px 0 10px' }}>
                  About {DTYPE_SIZE_MB.q8} MB on mobile. Cached afterwards, so this happens once.
                </p>
                <ProgressBar value={engineStatus.progress} />
              </div>
            ) : engineStatus.state === 'ready' ? (
              <Banner kind="info">
                Voice engine ready on <strong>{engineStatus.device?.toUpperCase()}</strong>
                {engineStatus.rtf
                  ? ` · generating about ${engineStatus.rtf.toFixed(1)}x faster than real time`
                  : ''}
                .
              </Banner>
            ) : engineStatus.state === 'error' ? (
              <Banner kind="error">{engineStatus.message}</Banner>
            ) : (
              <button className="btn btn-primary btn-block" onClick={() => kokoroClient.init()}>
                Download the free voice model
              </button>
            )}
          </div>
        ) : null}

        {settings.engine === 'device' && systemVoices.length > 0 ? (
          <div className="field">
            <label htmlFor="sysvoice">System voice</label>
            <select
              id="sysvoice"
              className="select"
              value={settings.deviceVoiceURI ?? ''}
              onChange={(e) => updateSettings({ deviceVoiceURI: e.target.value || null })}
            >
              <option value="">Choose automatically</option>
              {systemVoices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="section">
          <div className="section-head">
            <h2>Voice</h2>
          </div>
          <p className="small muted" style={{ marginTop: -4, marginBottom: 12 }}>
            The letter badge is Kokoro&rsquo;s own quality grade for that voice. Grade A and B
            voices hold up best over a long book.
          </p>
          <VoicePicker
            engine={settings.engine}
            selectedId={settings.presetId}
            onSelect={(preset) => updateSettings({ presetId: preset.id })}
            deviceVoiceURI={settings.deviceVoiceURI}
            engineReady={engineStatus.state === 'ready'}
            onNeedsEngine={() => {
              kokoroClient.init();
              showToast('The voice model is still downloading. Preview will work once it is ready.');
            }}
          />
        </div>
      </div>
    </div>
  );
}
