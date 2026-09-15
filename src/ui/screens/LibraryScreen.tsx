import { useEffect, useMemo, useState } from 'react';
import type { DocMeta, ReadingPosition } from '../../types';
import { useApp } from '../../state/store';
import * as db from '../../lib/db';
import { formatDuration, formatRelative, formatCount } from '../../lib/format';
import { EmptyState, Sheet } from '../components/common';

type Filter = 'all' | 'reading' | 'finished' | 'favorites';

/** Home / library: continue where you left off, then everything else. */
export function LibraryScreen({
  onOpen,
  onAdd,
}: {
  onOpen: (id: string) => void;
  onAdd: () => void;
}): React.JSX.Element {
  const { library, refreshLibrary, removeDoc, toggleFavorite } = useApp();
  const [positions, setPositions] = useState<Record<string, ReadingPosition>>({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [menuFor, setMenuFor] = useState<DocMeta | null>(null);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  // Progress lives with the position record, not the metadata, so fetch it
  // for the visible library once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        library.map(async (doc) => [doc.id, await db.getPosition(doc.id)] as const)
      );
      if (cancelled) return;
      const map: Record<string, ReadingPosition> = {};
      for (const [id, pos] of entries) if (pos) map[id] = pos;
      setPositions(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [library]);

  const continueDoc = useMemo(() => {
    const started = library
      .filter((d) => (positions[d.id]?.progress ?? 0) > 0.001 && !d.finished)
      .sort((a, b) => (positions[b.id]?.updatedAt ?? 0) - (positions[a.id]?.updatedAt ?? 0));
    return started[0] ?? null;
  }, [library, positions]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return library.filter((doc) => {
      if (q !== '' && !doc.title.toLowerCase().includes(q)) {
        if (!(doc.description ?? '').toLowerCase().includes(q)) return false;
      }
      const progress = positions[doc.id]?.progress ?? 0;
      if (filter === 'reading') return progress > 0.001 && !doc.finished;
      if (filter === 'finished') return doc.finished || progress > 0.98;
      if (filter === 'favorites') return doc.favorite;
      return true;
    });
  }, [library, query, filter, positions]);

  const card = (doc: DocMeta) => {
    const progress = positions[doc.id]?.progress ?? 0;
    return (
      <div key={doc.id} style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
        <button className="doc-card" onClick={() => onOpen(doc.id)} style={{ flex: 1 }}>
          <div className="doc-cover" aria-hidden="true">
            {doc.coverEmoji}
          </div>
          <div className="doc-info">
            <div className="doc-title">
              {doc.favorite ? '★ ' : ''}
              {doc.title}
            </div>
            <div className="doc-meta">
              {formatCount(doc.wordCount)} words &middot; {formatDuration(doc.estSeconds)}
              {doc.chapterCount > 1 ? ` · ${doc.chapterCount} chapters` : ''}
            </div>
            {progress > 0.001 ? (
              <>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
                </div>
                <div className="doc-meta" style={{ marginTop: 4 }}>
                  {Math.round(progress * 100)}% &middot;{' '}
                  {formatRelative(positions[doc.id]?.updatedAt ?? doc.updatedAt)}
                </div>
              </>
            ) : null}
          </div>
        </button>
        <button
          className="icon-btn"
          onClick={() => setMenuFor(doc)}
          aria-label={`Options for ${doc.title}`}
          style={{ alignSelf: 'center' }}
        >
          &#8942;
        </button>
      </div>
    );
  };

  return (
    <div className="screen">
      <div className="topbar">
        <h1>Narrato</h1>
        <button className="btn btn-primary btn-sm" onClick={onAdd}>
          + Add
        </button>
      </div>

      <div className="container">
        {library.length === 0 ? (
          <EmptyState
            icon={'\u{1F3A7}'}
            title="Nothing to listen to yet"
            body="Add a book, PDF, article, photo of a page, or just paste some text. Narrato reads it aloud with natural voices and keeps your place."
            action={
              <button className="btn btn-primary" onClick={onAdd}>
                Add something to read
              </button>
            }
          />
        ) : (
          <>
            {continueDoc ? (
              <div className="section">
                <div className="section-head">
                  <h2>Continue listening</h2>
                </div>
                <button
                  className="doc-card"
                  onClick={() => onOpen(continueDoc.id)}
                  style={{ borderColor: 'var(--accent)' }}
                >
                  <div className="doc-cover" aria-hidden="true">
                    {continueDoc.coverEmoji}
                  </div>
                  <div className="doc-info">
                    <div className="doc-title">{continueDoc.title}</div>
                    <div className="doc-meta">
                      Chapter {(positions[continueDoc.id]?.chapterIndex ?? 0) + 1} of{' '}
                      {continueDoc.chapterCount}
                    </div>
                    <div className="progress-track">
                      <div
                        className="progress-fill"
                        style={{ width: `${(positions[continueDoc.id]?.progress ?? 0) * 100}%` }}
                      />
                    </div>
                  </div>
                  <span style={{ fontSize: 22, color: 'var(--accent)' }} aria-hidden="true">
                    &#9654;
                  </span>
                </button>
              </div>
            ) : null}

            <div className="field" style={{ marginTop: 18 }}>
              <input
                className="input"
                type="search"
                value={query}
                placeholder="Search your library"
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search library"
              />
            </div>

            <div className="chip-row" style={{ marginBottom: 14 }}>
              {(
                [
                  ['all', 'All'],
                  ['reading', 'Reading'],
                  ['finished', 'Finished'],
                  ['favorites', 'Favourites'],
                ] as Array<[Filter, string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={`chip${filter === value ? ' active' : ''}`}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>

            {visible.length === 0 ? (
              <p className="small muted" style={{ textAlign: 'center', padding: '24px 0' }}>
                Nothing matches that.
              </p>
            ) : (
              <div className="stack">{visible.map(card)}</div>
            )}
          </>
        )}
      </div>

      {menuFor ? (
        <Sheet title={menuFor.title} onClose={() => setMenuFor(null)}>
          <p className="small muted">
            {formatCount(menuFor.wordCount)} words &middot; added{' '}
            {formatRelative(menuFor.createdAt)}
            {menuFor.sourceRef ? ` · ${menuFor.sourceRef}` : ''}
          </p>
          <div className="stack">
            <button
              className="btn btn-block"
              onClick={() => {
                void toggleFavorite(menuFor.id);
                setMenuFor(null);
              }}
            >
              {menuFor.favorite ? 'Remove from favourites' : 'Add to favourites'}
            </button>
            <button
              className="btn btn-block"
              onClick={() => {
                void db.clearAudioForDoc(menuFor.id);
                setMenuFor(null);
              }}
            >
              Delete cached audio only
            </button>
            <button
              className="btn btn-danger btn-block"
              onClick={() => {
                void removeDoc(menuFor.id);
                setMenuFor(null);
              }}
            >
              Delete document and audio
            </button>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
