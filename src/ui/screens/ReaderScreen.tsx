import { useState } from 'react';
import { useApp } from '../../state/store';
import { engine } from '../../lib/player/engine';
import { formatDuration } from '../../lib/format';
import { ReaderView } from '../components/ReaderView';
import { CharacterManager } from '../components/CharacterManager';
import { PronunciationEditor } from '../components/PronunciationEditor';
import { PrepareSheet } from '../components/PrepareSheet';
import { Banner, EmptyState, ProgressBar, Sheet } from '../components/common';

/** The reading surface: text, highlighting, and the per-book tools. */
export function ReaderScreen({
  onBack,
  onOpenVoices,
}: {
  onBack: () => void;
  onOpenVoices: () => void;
}): React.JSX.Element {
  const { open, player, settings, engineStatus, preset, bookmarks, removeBookmark } = useApp();
  const [showCharacters, setShowCharacters] = useState(false);
  const [showPronunciation, setShowPronunciation] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showPrepare, setShowPrepare] = useState(false);

  if (!open) {
    return (
      <div className="screen no-player">
        <div className="topbar">
          <button className="icon-btn" onClick={onBack} aria-label="Back">
            &#8592;
          </button>
          <h1>Reader</h1>
        </div>
        <EmptyState
          icon={'\u{1F4D6}'}
          title="Nothing open"
          body="Choose something from your library to start listening."
        />
      </div>
    );
  }

  const chapter = open.chapters[player.chapterIndex] ?? open.chapters[0]!;
  const activeChunk = open.chunks[player.chunkIndex] ?? null;

  const modelLoading = settings.engine === 'kokoro' && engineStatus.state === 'loading';
  const modelError = settings.engine === 'kokoro' && engineStatus.state === 'error';

  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" onClick={onBack} aria-label="Back to library">
          &#8592;
        </button>
        <h1>{open.meta.title}</h1>
        <button
          className="icon-btn"
          onClick={() => setShowBookmarks(true)}
          aria-label="Bookmarks"
        >
          &#128278;
        </button>
      </div>

      <div className="container">
        {modelLoading ? (
          <div className="card" style={{ margin: '14px 0' }}>
            <strong>Downloading the free AI voice model</strong>
            <p className="small muted" style={{ margin: '6px 0 10px' }}>
              {engineStatus.message}. This is a one-time download that is cached on your
              device - after this, voices work offline.
            </p>
            <ProgressBar value={engineStatus.progress} />
            <div className="small muted" style={{ marginTop: 6 }}>
              {Math.round(engineStatus.progress * 100)}%
            </div>
          </div>
        ) : null}

        {modelError ? (
          <Banner kind="error">
            The AI voice engine could not start ({engineStatus.message}). You can switch to your
            device&rsquo;s built-in voices in{' '}
            <button className="btn btn-sm" onClick={onOpenVoices}>
              Voices
            </button>
          </Banner>
        ) : null}

        <div style={{ margin: '14px 0' }}>
          <div className="spread" style={{ marginBottom: 6 }}>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: 16 }}>{chapter.title}</h2>
              <div className="small muted">
                Chapter {player.chapterIndex + 1} of {open.chapters.length} &middot;{' '}
                {formatDuration(open.meta.estSeconds)} total
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
              <button
                className="icon-btn"
                onClick={() => void engine.previousChapter()}
                aria-label="Previous chapter"
              >
                &#9198;
              </button>
              <button
                className="icon-btn"
                onClick={() => void engine.nextChapter()}
                aria-label="Next chapter"
              >
                &#9197;
              </button>
            </div>
          </div>

          <div className="chip-row">
            <button className="chip" onClick={onOpenVoices}>
              {'\u{1F399}️'} {preset.label}
            </button>
            <button className="chip" onClick={() => setShowCharacters(true)}>
              {'\u{1F3AD}'} Characters
            </button>
            <button className="chip" onClick={() => setShowPronunciation(true)}>
              {'\u{1F5E3}️'} Pronunciation
            </button>
            <button className="chip" onClick={() => setShowPrepare(true)}>
              {'⬇️'} Prepare audio
            </button>
          </div>
        </div>

        <ReaderView
          chapter={chapter}
          chunks={open.chunks}
          activeChunk={activeChunk}
          charOffset={player.charOffset}
          mode={settings.highlight}
          autoScroll={settings.autoScroll}
          onSeekToChunk={(index) => {
            void engine.goToChunk(index).then(() => {
              if (player.status !== 'playing') void engine.play();
            });
          }}
        />
      </div>

      {showCharacters ? <CharacterManager onClose={() => setShowCharacters(false)} /> : null}
      {showPrepare ? <PrepareSheet onClose={() => setShowPrepare(false)} /> : null}
      {showPronunciation ? (
        <PronunciationEditor
          onClose={() => setShowPronunciation(false)}
          docId={open.meta.id}
          docTitle={open.meta.title}
        />
      ) : null}

      {showBookmarks ? (
        <Sheet title="Bookmarks" onClose={() => setShowBookmarks(false)}>
          {bookmarks.length === 0 ? (
            <p className="small muted">
              No bookmarks yet. Open the player and tap the bookmark icon to save your spot.
            </p>
          ) : (
            <div className="stack">
              {bookmarks.map((b) => (
                <div key={b.id} className="card" style={{ padding: 12 }}>
                  <div className="spread">
                    <button
                      onClick={() => {
                        void engine.goToChunk(b.chunkIndex);
                        setShowBookmarks(false);
                      }}
                      style={{
                        background: 'none',
                        border: 0,
                        textAlign: 'left',
                        padding: 0,
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{b.label}</div>
                      <div className="small muted">
                        Chapter {b.chapterIndex + 1}
                      </div>
                      <div className="small muted" style={{ marginTop: 4, fontStyle: 'italic' }}>
                        {b.preview}
                        {b.preview.length >= 130 ? '...' : ''}
                      </div>
                    </button>
                    <button
                      className="icon-btn"
                      onClick={() => void removeBookmark(b.id)}
                      aria-label={`Delete bookmark ${b.label}`}
                    >
                      &#128465;
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Sheet>
      ) : null}
    </div>
  );
}
