import { useEffect, useRef, useState } from 'react';
import { engine } from '../../lib/player/engine';
import { startKeepAlive } from '../../lib/player/keepAlive';
import type { KeepAlive } from '../../lib/player/keepAlive';
import { useApp } from '../../state/store';
import { AUDIO_BYTES_PER_SEC, storageEstimate } from '../../lib/db';
import { formatDuration } from '../../lib/format';
import { Banner, ProgressBar, Sheet } from './common';

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * Bulk audio preparation.
 *
 * Generates and caches a chapter or a whole book before you need it, so a
 * flight, a commute underground, or a long locked-screen session never hits a
 * buffering stall. Playback keeps priority throughout.
 */
export function PrepareSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { open, settings, showToast, player } = useApp();
  const [scope, setScope] = useState<'chapter' | 'book'>('chapter');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [cached, setCached] = useState<{ cached: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [space, setSpace] = useState<{ usage: number; quota: number } | null>(null);
  const [background, setBackground] = useState(false);
  const cancelled = useRef(false);
  const keepAlive = useRef<KeepAlive | null>(null);

  useEffect(() => {
    void storageEstimate().then(setSpace);
  }, [running]);

  // Show how much of the selected scope is already on disk.
  useEffect(() => {
    let alive = true;
    setCached(null);
    void engine.cachedCount(scope).then((c) => {
      if (alive) setCached(c);
    });
    return () => {
      alive = false;
    };
  }, [scope, running]);

  // A half-finished run should stop if the sheet goes away - and must never
  // leave a silent audio session holding the page open behind it.
  useEffect(() => () => {
    cancelled.current = true;
    keepAlive.current?.stop();
    keepAlive.current = null;
  }, []);

  const start = async () => {
    setError(null);
    setRunning(true);
    cancelled.current = false;
    setProgress({ done: 0, total: 0 });

    // Must be taken inside the tap: playing even a silent track is subject to
    // autoplay policy, and after the first await the gesture is gone. Skipped
    // while something is already playing, because that audio is already
    // holding the page open and the notification belongs to the book.
    if (player.status !== 'playing' && open) {
      keepAlive.current = startKeepAlive(open.meta.title, () => {
        cancelled.current = true;
      });
      setBackground(keepAlive.current.holding);
    }

    try {
      const result = await engine.prepareRange(
        scope,
        (done, total) => {
          setProgress({ done, total });
          if (total > 0) {
            keepAlive.current?.update(
              `Preparing ${Math.round((done / total) * 100)}% - ${total - done} sections left`
            );
          }
        },
        () => cancelled.current
      );
      if (cancelled.current) {
        showToast('Stopped. Everything generated so far is saved.');
      } else if (result.failed > 0) {
        setError(
          `${result.failed} of ${result.total} sections could not be generated. The rest are saved and will play normally.`
        );
      } else {
        showToast(
          scope === 'chapter' ? 'Chapter ready to play offline.' : 'Whole book ready to play offline.'
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preparation failed.');
    } finally {
      keepAlive.current?.stop();
      keepAlive.current = null;
      setBackground(false);
      setRunning(false);
      setProgress(null);
    }
  };

  const chapterCount = open?.chapters.length ?? 0;
  const fraction = progress && progress.total > 0 ? progress.done / progress.total : 0;

  // Six hours of narration is about a gigabyte, so telling the user the size
  // before they start is the difference between a working offline copy and a
  // half-finished one that ran out of room.
  const remaining = cached ? cached.total - cached.cached : 0;
  const secondsToMake =
    open && cached && cached.total > 0
      ? (open.meta.estSeconds * (scope === 'book' ? 1 : 1 / Math.max(1, chapterCount))) *
        (remaining / cached.total)
      : 0;
  const estimatedBytes = secondsToMake * AUDIO_BYTES_PER_SEC;
  const freeBytes = space ? Math.max(0, space.quota - space.usage) : null;
  const willNotFit = freeBytes !== null && estimatedBytes > freeBytes * 0.9;

  return (
    <Sheet title="Prepare audio" onClose={onClose}>
      {settings.engine === 'device' ? (
        <Banner kind="warn">
          Device voices are spoken as they play, so there is nothing to prepare in advance.
          Switch to Kokoro AI in Voices to generate audio ahead of time.
        </Banner>
      ) : (
        <>
          <p className="small muted">
            Generate audio now and keep it on this device. Prepared sections play instantly and
            work with no connection at all. Start a whole document, then lock the phone or go
            and do something else - it keeps generating in the background.
          </p>

          <div className="chip-row" style={{ margin: '12px 0' }}>
            <button
              className={`chip${scope === 'chapter' ? ' active' : ''}`}
              onClick={() => setScope('chapter')}
              disabled={running}
            >
              This chapter
            </button>
            <button
              className={`chip${scope === 'book' ? ' active' : ''}`}
              onClick={() => setScope('book')}
              disabled={running}
            >
              Whole document{chapterCount > 1 ? ` (${chapterCount} chapters)` : ''}
            </button>
          </div>

          {cached && !running ? (
            <p className="small muted">
              {cached.cached} of {cached.total} sections already prepared
              {cached.total > 0 ? ` (${Math.round((cached.cached / cached.total) * 100)}%)` : ''}.
              Already-prepared sections are skipped.
              {estimatedBytes > 0 ? (
                <>
                  {' '}
                  The rest is roughly <strong>{formatBytes(estimatedBytes)}</strong> of audio
                  ({formatDuration(secondsToMake)} of listening)
                  {freeBytes !== null ? `, and this device has about ${formatBytes(freeBytes)} free` : ''}
                  .
                </>
              ) : null}
            </p>
          ) : null}

          {willNotFit ? (
            <Banner kind="warn">
              This may not fit in the space your browser allows. Prepare a chapter at a time,
              or free space by clearing cached audio for books you have finished
              (Settings &rarr; Storage).
            </Banner>
          ) : null}

          {player.storageFull ? (
            <Banner kind="error">
              The browser stopped saving generated audio - storage is full. Playback still
              works, but sections are not being kept for offline use. Clear cached audio for
              other books in Settings &rarr; Storage, then try again.
            </Banner>
          ) : null}

          {running && progress ? (
            <div className="card" style={{ margin: '12px 0' }}>
              <div className="spread" style={{ marginBottom: 8 }}>
                <strong>Generating</strong>
                <span className="small muted">
                  {progress.done} / {progress.total} ({Math.round(fraction * 100)}%)
                </span>
              </div>
              <ProgressBar value={fraction} />
              <p className="small muted" style={{ margin: '8px 0 0' }}>
                You can keep listening while this runs. Playback always takes priority.
              </p>
              {background ? (
                <p className="small" style={{ margin: '8px 0 0', color: 'var(--accent)' }}>
                  Safe to put the phone down, lock it, or switch apps - this keeps going, and
                  shows progress in your notifications. Closing Narrato completely stops it;
                  reopening picks up where it left off.
                </p>
              ) : null}
            </div>
          ) : null}

          {error ? <Banner kind="error">{error}</Banner> : null}

          <div className="btn-row" style={{ marginTop: 14 }}>
            {running ? (
              <button
                className="btn btn-block"
                onClick={() => {
                  cancelled.current = true;
                }}
              >
                Stop (keep what is done)
              </button>
            ) : (
              <button className="btn btn-primary btn-block" onClick={() => void start()}>
                {scope === 'chapter' ? 'Prepare this chapter' : 'Prepare whole document'}
              </button>
            )}
          </div>

          <p className="small muted" style={{ marginTop: 12 }}>
            Preparing a long book generates a lot of audio and will use battery and storage.
            Storage usage is shown in Settings.
          </p>
        </>
      )}
    </Sheet>
  );
}
