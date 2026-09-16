import { useApp } from '../../state/store';
import { formatDuration } from '../../lib/format';

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
  if (!prepare) return null;

  const fraction = prepare.total > 0 ? prepare.done / prepare.total : 0;
  const pct = Math.round(fraction * 100);

  return (
    <div className="prepare-bar" data-testid="prepare-bar">
      <div className="prepare-bar-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
      <div className="prepare-bar-row">
        <span className="small">
          {prepare.stopping ? (
            <strong>Finishing the current section, then stopping...</strong>
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
