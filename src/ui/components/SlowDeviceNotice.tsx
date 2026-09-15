import { useState } from 'react';
import { useApp } from '../../state/store';

/**
 * Proactive warning for a device that cannot generate speech as fast as it
 * plays it.
 *
 * Measured on a 2-core machine, Kokoro q8 runs at about 0.99x real time - it
 * never builds a buffer, so playback will eventually pause no matter how the
 * queue is tuned. Waiting for that to happen and then apologising is the wrong
 * behaviour; this says so up front and offers the two things that actually
 * help: bank more audio before starting, or switch to the device's own voice.
 */
export function SlowDeviceNotice(): React.JSX.Element | null {
  const { settings, updateSettings, engineStatus, showToast } = useApp();
  const [dismissed, setDismissed] = useState(false);

  const rtf = engineStatus.rtf;
  const slow = settings.engine !== 'device' && rtf !== null && rtf < 1.2;

  // "Smooth" already banks the largest buffer we offer, so there is nothing
  // left to suggest on that front.
  if (!slow || dismissed) return null;

  return (
    <div className="banner banner-warn">
      <span aria-hidden="true">{'\u{1F40C}'}</span>
      <div>
        <strong>This device generates audio about as fast as it plays it.</strong>
        <div className="small" style={{ marginTop: 4 }}>
          Measured at {rtf.toFixed(2)}x real time. Playback will pause now and then unless more
          audio is prepared in advance.
        </div>
        <div className="btn-row" style={{ marginTop: 10 }}>
          {settings.startupMode !== 'smooth' ? (
            <button
              className="btn btn-sm"
              onClick={() => {
                updateSettings({ startupMode: 'smooth' });
                showToast('Smooth start on: Narrato banks more audio before playing.');
              }}
            >
              Buffer more first
            </button>
          ) : null}
          <button
            className="btn btn-sm"
            onClick={() => {
              updateSettings({ engine: 'device', presetId: 'd_default' });
              showToast('Switched to your device voice. Your place is unchanged.');
            }}
          >
            Use device voice
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setDismissed(true)}>
            Dismiss
          </button>
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>
          Preparing a chapter in advance also avoids this entirely.
        </div>
      </div>
    </div>
  );
}
