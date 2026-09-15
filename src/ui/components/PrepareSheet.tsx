import { useEffect, useRef, useState } from 'react';
import { engine } from '../../lib/player/engine';
import { useApp } from '../../state/store';
import { Banner, ProgressBar, Sheet } from './common';

/**
 * Bulk audio preparation.
 *
 * Generates and caches a chapter or a whole book before you need it, so a
 * flight, a commute underground, or a long locked-screen session never hits a
 * buffering stall. Playback keeps priority throughout.
 */
export function PrepareSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { open, settings, showToast } = useApp();
  const [scope, setScope] = useState<'chapter' | 'book'>('chapter');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [cached, setCached] = useState<{ cached: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

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

  // A half-finished run should stop if the sheet goes away.
  useEffect(() => () => {
    cancelled.current = true;
  }, []);

  const start = async () => {
    setError(null);
    setRunning(true);
    cancelled.current = false;
    setProgress({ done: 0, total: 0 });
    try {
      const result = await engine.prepareRange(
        scope,
        (done, total) => setProgress({ done, total }),
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
      setRunning(false);
      setProgress(null);
    }
  };

  const chapterTitle = open?.chapters[0] ? open.chapters.length : 0;
  const fraction = progress && progress.total > 0 ? progress.done / progress.total : 0;

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
            work with no connection at all.
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
              Whole document{chapterTitle > 1 ? ` (${chapterTitle} chapters)` : ''}
            </button>
          </div>

          {cached && !running ? (
            <p className="small muted">
              {cached.cached} of {cached.total} sections already prepared
              {cached.total > 0 ? ` (${Math.round((cached.cached / cached.total) * 100)}%)` : ''}.
              Already-prepared sections are skipped.
            </p>
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
