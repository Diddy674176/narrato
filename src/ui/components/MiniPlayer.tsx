import { useApp } from '../../state/store';
import { engine } from '../../lib/player/engine';
import { formatTime } from '../../lib/format';

/** Persistent bottom bar so playback is always one tap away. */
export function MiniPlayer({ onExpand }: { onExpand: () => void }): React.JSX.Element | null {
  const { open, player, settings } = useApp();
  if (!open) return null;

  const chapter = open.chapters[player.chapterIndex];
  const busy = player.status === 'buffering';

  return (
    <div className="mini-player">
      <button
        className="doc-cover"
        onClick={onExpand}
        aria-label="Open player"
        style={{ border: 0, cursor: 'pointer' }}
      >
        {open.meta.coverEmoji}
      </button>

      <button
        className="mini-info"
        onClick={onExpand}
        style={{ background: 'none', border: 0, textAlign: 'left', padding: 0 }}
        aria-label="Open player"
      >
        <div className="mini-title">{open.meta.title}</div>
        <div className="mini-sub">
          {busy
            ? 'Generating more audio...'
            : `${chapter?.title ?? ''} · ${formatTime(player.elapsedSec)}`}
        </div>
      </button>

      <button
        className="icon-btn"
        onClick={() => void engine.skip(-settings.skipSeconds)}
        aria-label={`Back ${settings.skipSeconds} seconds`}
        style={{ fontSize: 14, fontWeight: 600 }}
      >
        &#8630;
      </button>

      <button
        className="icon-btn"
        onClick={() => engine.toggle()}
        aria-label={player.status === 'playing' ? 'Pause' : 'Play'}
        style={{ background: 'var(--accent)', color: '#fff' }}
      >
        {busy ? (
          <span className="spinner" style={{ borderTopColor: '#fff' }} />
        ) : player.status === 'playing' ? (
          <>&#10074;&#10074;</>
        ) : (
          <>&#9654;</>
        )}
      </button>
    </div>
  );
}
