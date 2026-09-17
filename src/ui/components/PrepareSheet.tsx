import { useEffect, useState } from 'react';
import { engine } from '../../lib/player/engine';
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
  const { open, settings, player, engineStatus, prepare, startPrepare, stopPrepare } = useApp();
  const [scope, setScope] = useState<'chapter' | 'book'>('chapter');
  const [cached, setCached] = useState<{ cached: number; total: number } | null>(null);
  const [space, setSpace] = useState<{ usage: number; quota: number } | null>(null);

  // The run itself lives in the store, so closing this sheet - or walking off
  // to another screen - leaves it going. Only the reader stops it.
  const running = prepare !== null;
  const progress = prepare ? { done: prepare.done, total: prepare.total } : null;
  const eta = prepare?.etaSec ?? null;
  const background = prepare?.background ?? false;

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
                  {engineStatus.rtf && engineStatus.rtf > 0 ? (
                    <>
                      {' '}
                      This phone generates about{' '}
                      <strong>{engineStatus.rtf.toFixed(1)}x faster than real time</strong>, so
                      expect roughly <strong>{formatDuration(secondsToMake / engineStatus.rtf)}</strong>{' '}
                      of generating.
                    </>
                  ) : null}
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
              <p className="small" style={{ margin: '8px 0 0' }} data-testid="prepare-eta">
                {eta === null
                  ? 'Measuring how fast this phone generates...'
                  : `About ${formatDuration(eta)} left at this phone's current speed.`}
              </p>
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



          <div className="btn-row" style={{ marginTop: 14 }}>
            {running ? (
              <button className="btn btn-block" onClick={stopPrepare}>
                Stop (keep what is done)
              </button>
            ) : (
              <button className="btn btn-primary btn-block" onClick={() => void startPrepare(scope)}>
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
