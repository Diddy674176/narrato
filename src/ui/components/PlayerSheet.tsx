import { useState } from 'react';
import { useApp } from '../../state/store';
import { engine } from '../../lib/player/engine';
import { formatTime } from '../../lib/format';
import { Sheet } from './common';

/**
 * Full-screen player.
 *
 * The transport row is the one thing that must work perfectly with a thumb, so
 * it sits low on the screen with oversized targets.
 */

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SLEEP_OPTIONS: Array<{ label: string; value: number | 'chapter' }> = [
  { label: '5 min', value: 5 },
  { label: '10 min', value: 10 },
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '45 min', value: 45 },
  { label: '60 min', value: 60 },
  { label: 'End of chapter', value: 'chapter' },
];

export function PlayerSheet({ onClose }: { onClose: () => void }): React.JSX.Element | null {
  const { open, player, settings, updateSettings, addBookmark, engineStatus, showToast } =
    useApp();
  const [showChapters, setShowChapters] = useState(false);
  const [showSleep, setShowSleep] = useState(false);
  const [bookmarkLabel, setBookmarkLabel] = useState('');
  const [showBookmark, setShowBookmark] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);

  if (!open) return null;

  const chapter = open.chapters[player.chapterIndex];
  const elapsed = scrub ?? player.elapsedSec;
  const total = Math.max(player.totalSec, 1);
  const busy = player.status === 'buffering';

  const bufferRatio = player.bufferTargetSec > 0 ? player.bufferedSec / player.bufferTargetSec : 0;
  const bufferClass = busy ? 'bad pulse' : bufferRatio < 0.35 ? 'warn' : '';

  return (
    <div className="player-sheet">
      <div className="topbar" style={{ background: 'transparent', border: 0 }}>
        <button className="icon-btn" onClick={onClose} aria-label="Close player">
          &#9660;
        </button>
        <h1 style={{ fontSize: 15, textAlign: 'center' }}>{open.meta.title}</h1>
        <button
          className="icon-btn"
          onClick={() => setShowBookmark(true)}
          aria-label="Add bookmark"
        >
          &#128278;
        </button>
      </div>

      <div className="player-body">
        <div className="player-art" aria-hidden="true">
          {open.meta.coverEmoji}
        </div>

        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>{chapter?.title ?? open.meta.title}</h2>
          <div className="small muted">
            Chapter {player.chapterIndex + 1} of {open.chapters.length}
          </div>
        </div>

        <input
          type="range"
          min={0}
          max={total}
          step={1}
          value={Math.min(elapsed, total)}
          onChange={(e) => setScrub(Number(e.target.value))}
          onPointerUp={() => {
            if (scrub !== null) {
              void engine.seekToAbsolute(scrub);
              setScrub(null);
            }
          }}
          onKeyUp={() => {
            if (scrub !== null) {
              void engine.seekToAbsolute(scrub);
              setScrub(null);
            }
          }}
          aria-label="Seek through document"
        />
        <div className="time-row">
          <span>{formatTime(elapsed)}</span>
          <span>-{formatTime(Math.max(0, total - elapsed))}</span>
        </div>

        <div className="transport">
          <button
            className="icon-btn"
            onClick={() => void engine.previousChapter()}
            aria-label="Previous chapter"
          >
            &#9198;
          </button>
          <button
            className="icon-btn"
            onClick={() => void engine.skip(-settings.skipSeconds)}
            aria-label={`Back ${settings.skipSeconds} seconds`}
            style={{ fontSize: 15, fontWeight: 600 }}
          >
            &#8630;{settings.skipSeconds}
          </button>

          <button
            className="play-btn"
            onClick={() => engine.toggle()}
            aria-label={player.status === 'playing' ? 'Pause' : 'Play'}
          >
            {busy ? (
              <span className="spinner" style={{ borderTopColor: '#fff' }} />
            ) : player.status === 'playing' ? (
              <>&#10074;&#10074;</>
            ) : (
              <>&#9654;</>
            )}
          </button>

          <button
            className="icon-btn"
            onClick={() => void engine.skip(settings.skipSeconds)}
            aria-label={`Forward ${settings.skipSeconds} seconds`}
            style={{ fontSize: 15, fontWeight: 600 }}
          >
            &#8631;{settings.skipSeconds}
          </button>
          <button
            className="icon-btn"
            onClick={() => void engine.nextChapter()}
            aria-label="Next chapter"
          >
            &#9197;
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
          <span className="buffer-pill">
            <span className={`dot ${bufferClass}`} />
            {busy
              ? 'Generating more audio...'
              : settings.engine === 'device'
                ? 'Device voice'
                : `Buffered ${Math.round(player.bufferedSec)}s`}
            {engineStatus.device ? ` · ${engineStatus.device.toUpperCase()}` : ''}
          </span>
        </div>

        {player.error ? (
          <div className="banner banner-error">
            <span aria-hidden="true">{'⚠️'}</span>
            <div>
              {player.error}
              {settings.engine !== 'device' ? (
                <div className="btn-row" style={{ marginTop: 10 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      // Keeps the exact listening position; only the voice changes.
                      updateSettings({ engine: 'device', presetId: 'd_default' });
                      showToast('Switched to your device voice. Your place is unchanged.');
                    }}
                  >
                    Use device voice
                  </button>
                  <button className="btn btn-sm" onClick={() => void engine.play()}>
                    Retry
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="speed">Speed &middot; {settings.rate.toFixed(2)}x</label>
          <div className="chip-row" style={{ marginBottom: 8 }}>
            {SPEEDS.map((s) => (
              <button
                key={s}
                className={`chip${Math.abs(settings.rate - s) < 0.001 ? ' active' : ''}`}
                onClick={() => updateSettings({ rate: s })}
              >
                {s}x
              </button>
            ))}
          </div>
          <input
            id="speed"
            type="range"
            min={0.5}
            max={3}
            step={0.05}
            value={settings.rate}
            onChange={(e) => updateSettings({ rate: Number(e.target.value) })}
          />
        </div>

        <div className="field">
          <label htmlFor="vol">Volume</label>
          <input
            id="vol"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={settings.volume}
            onChange={(e) => updateSettings({ volume: Number(e.target.value) })}
          />
        </div>

        <div className="btn-row">
          <button className="btn" onClick={() => setShowChapters(true)}>
            &#9776; Chapters
          </button>
          <button className="btn" onClick={() => setShowSleep(true)}>
            &#9203; Sleep
            {player.sleepTimerEndsAt
              ? ` · ${Math.max(0, Math.round((player.sleepTimerEndsAt - Date.now()) / 60000))}m`
              : ''}
          </button>
        </div>
      </div>

      {showChapters ? (
        <Sheet title="Chapters" onClose={() => setShowChapters(false)}>
          <div className="stack">
            {open.chapters.map((ch) => (
              <button
                key={ch.index}
                className="doc-card"
                onClick={() => {
                  void engine.goToChapter(ch.index);
                  setShowChapters(false);
                }}
                style={{
                  borderColor:
                    ch.index === player.chapterIndex ? 'var(--accent)' : 'var(--border)',
                }}
              >
                <div className="doc-cover" style={{ width: 34, height: 34, fontSize: 13 }}>
                  {ch.index + 1}
                </div>
                <div className="doc-info">
                  <div className="doc-title">{ch.title}</div>
                  <div className="doc-meta">
                    {Math.max(1, Math.round(ch.text.length / 1000))}k characters
                  </div>
                </div>
              </button>
            ))}
          </div>
        </Sheet>
      ) : null}

      {showSleep ? (
        <Sheet title="Sleep timer" onClose={() => setShowSleep(false)}>
          <p className="small muted">
            Playback fades out gently over the last few seconds rather than cutting off.
          </p>
          <div className="grid-2">
            {SLEEP_OPTIONS.map((opt) => (
              <button
                key={String(opt.value)}
                className="btn"
                onClick={() => {
                  engine.setSleepTimer(opt.value);
                  setShowSleep(false);
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            className="btn btn-block"
            style={{ marginTop: 10 }}
            onClick={() => {
              engine.setSleepTimer(null);
              setShowSleep(false);
            }}
          >
            Turn timer off
          </button>
        </Sheet>
      ) : null}

      {showBookmark ? (
        <Sheet title="Add bookmark" onClose={() => setShowBookmark(false)}>
          <div className="field">
            <label htmlFor="bm">Name</label>
            <input
              id="bm"
              className="input"
              value={bookmarkLabel}
              placeholder="Important for test"
              onChange={(e) => setBookmarkLabel(e.target.value)}
            />
          </div>
          <button
            className="btn btn-primary btn-block"
            onClick={() => {
              void addBookmark(bookmarkLabel);
              setBookmarkLabel('');
              setShowBookmark(false);
            }}
          >
            Save bookmark
          </button>
        </Sheet>
      ) : null}
    </div>
  );
}
