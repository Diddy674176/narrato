import { useCallback, useEffect, useState } from 'react';
import { AppProvider, useApp } from './state/store';
import { engine } from './lib/player/engine';
import { LibraryScreen } from './ui/screens/LibraryScreen';
import { AddScreen } from './ui/screens/AddScreen';
import { ReaderScreen } from './ui/screens/ReaderScreen';
import { VoicesScreen } from './ui/screens/VoicesScreen';
import { SettingsScreen } from './ui/screens/SettingsScreen';
import { MiniPlayer } from './ui/components/MiniPlayer';
import { PlayerSheet } from './ui/components/PlayerSheet';
import './styles.css';

type Tab = 'library' | 'reader' | 'voices' | 'settings';

/**
 * Hash routing.
 *
 * A real router would be overkill here, and hash routes have a practical
 * advantage for a GitHub Pages sub-path deployment: no server rewrite rules are
 * needed, and the phone's back button still moves between tabs.
 */
function useHashTab(): [Tab, (tab: Tab) => void] {
  const read = (): Tab => {
    const raw = window.location.hash.replace(/^#\/?/, '');
    if (raw === 'reader' || raw === 'voices' || raw === 'settings') return raw;
    return 'library';
  };

  const [tab, setTab] = useState<Tab>(read);

  useEffect(() => {
    const onHash = () => setTab(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((next: Tab) => {
    window.location.hash = `/${next}`;
    setTab(next);
  }, []);

  return [tab, go];
}

const TABS: Array<{ id: Tab; icon: string; label: string }> = [
  { id: 'library', icon: '\u{1F4DA}', label: 'Library' },
  { id: 'reader', icon: '\u{1F4D6}', label: 'Reader' },
  { id: 'voices', icon: '\u{1F399}️', label: 'Voices' },
  { id: 'settings', icon: '⚙️', label: 'Settings' },
];

function Shell(): React.JSX.Element {
  const { ready, open, openDoc, toast, settings } = useApp();
  const [tab, setTab] = useHashTab();
  const [adding, setAdding] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);

  const handleOpen = useCallback(
    async (id: string) => {
      await openDoc(id);
      setTab('reader');
    },
    [openDoc, setTab]
  );

  // Desktop keyboard shortcuts. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!open) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          engine.toggle();
          break;
        case 'ArrowLeft':
          void engine.skip(-settings.skipSeconds);
          break;
        case 'ArrowRight':
          void engine.skip(settings.skipSeconds);
          break;
        case '[':
          void engine.previousChapter();
          break;
        case ']':
          void engine.nextChapter();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, settings.skipSeconds]);

  if (!ready) {
    return (
      <div className="app" style={{ display: 'grid', placeItems: 'center' }}>
        <div className="spinner" />
      </div>
    );
  }

  if (adding) {
    return (
      <div className="app">
        <AddScreen
          onBack={() => setAdding(false)}
          onImported={(id) => {
            setAdding(false);
            void handleOpen(id);
          }}
        />
        {toast ? <Toast message={toast} /> : null}
      </div>
    );
  }

  return (
    <div className="app">
      {tab === 'library' ? (
        <LibraryScreen onOpen={(id) => void handleOpen(id)} onAdd={() => setAdding(true)} />
      ) : null}
      {tab === 'reader' ? (
        <ReaderScreen onBack={() => setTab('library')} onOpenVoices={() => setTab('voices')} />
      ) : null}
      {tab === 'voices' ? <VoicesScreen onBack={() => setTab('library')} /> : null}
      {tab === 'settings' ? <SettingsScreen /> : null}

      <MiniPlayer onExpand={() => setPlayerOpen(true)} />
      {playerOpen ? <PlayerSheet onClose={() => setPlayerOpen(false)} /> : null}

      <nav className="nav" aria-label="Main">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
          >
            <span className="nav-icon" aria-hidden="true">
              {t.icon}
            </span>
            {t.label}
          </button>
        ))}
      </nav>

      {toast ? <Toast message={toast} /> : null}
    </div>
  );
}

function Toast({ message }: { message: string }): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: 16,
        right: 16,
        bottom: 'calc(var(--nav-h) + var(--player-h) + var(--safe-bottom) + 16px)',
        zIndex: 80,
        margin: '0 auto',
        maxWidth: 480,
        padding: '12px 16px',
        borderRadius: 'var(--radius)',
        background: 'var(--surface-3)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow)',
        fontSize: 13.5,
      }}
    >
      {message}
    </div>
  );
}

export default function App(): React.JSX.Element {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
