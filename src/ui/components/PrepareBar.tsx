import { useEffect, useState } from 'react';
import { useApp } from '../../state/store';
import { formatDuration } from '../../lib/format';

/**
 * How long a section may take before something is clearly wrong.
 *
 * A section is a few hundred characters - tens of seconds even on a slow
 * phone. Minutes of silence means the work is not running: usually because
 * the operating system suspended the app despite the audio session.
 */
const STALLED_MS = 4 * 60 * 1000;

/**
 * App-wide preparation progress.
 *
 * Preparing a book takes an hour or more on a phone, so the progress cannot
 * live inside the sheet that started it: a reader closes that sheet, carries
 * on reading, locks the phone, and has no way to tell whether anything is
 * still happening. This sits above the mini player wherever they are, shows
 * the measured time remaining, and carries the stop control.
 */
export function PrepareBar(): React.JSX.Element | null {
  const { prepare, stopPrepare } = useApp();

  // Re-render on a timer: "nothing has happened for six minutes" is a
  // statement about elapsed time, so nothing else would prompt it.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!prepare) return;
    const id = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, [prepare]);

  if (!prepare) return null;

  const stalledFor = Date.now() - prepare.lastAdvanceAt;
  const stalled = stalledFor > STALLED_MS;

  const fraction = prepare.total > 0 ? prepare.done / prepare.total : 0;
  const pct = Math.round(fraction * 100);

  return (
    <div className="prepare-bar" data-testid="prepare-bar">
      <div className="prepare-bar-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
      <div className="prepare-bar-row">
        <span className="small">
          {prepare.stopping ? (
            <strong>Finishing the current section, then stopping...</strong>
          ) : stalled ? (
            <strong data-testid="prepare-stalled">
              Nothing generated for {formatDuration(stalledFor / 1000)} - your phone probably
              suspended Narrato. Keep it open, or on screen, to continue.
            </strong>
          ) : (
            <>
              <strong>Preparing {prepare.title}</strong>
              {prepare.total > 0 ? ` · ${pct}%` : ''}
              {prepare.etaSec !== null ? ` · about ${formatDuration(prepare.etaSec)} left` : ''}
            </>
          )}
        </span>
        <button
          className="btn btn-sm"
          onClick={stopPrepare}
          disabled={prepare.stopping}
          aria-label="Stop preparing"
        >
          {prepare.stopping ? 'Stopping' : 'Stop'}
        </button>
      </div>
    </div>
  );
}
