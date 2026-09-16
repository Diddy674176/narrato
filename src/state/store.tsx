import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type {
  Bookmark,
  CharacterVoice,
  Chapter,
  DocMeta,
  EngineStatus,
  PronunciationRule,
  ReadingPosition,
  Settings,
  TextChunk,
  VoicePreset,
} from '../types';
import * as db from '../lib/db';
import { chapterStartChunks, chunkOptionsForSpeed, planChunks } from '../lib/chunker';
import { detectCharacters } from '../lib/dialogue';
import { applyRules, compileRules } from '../lib/pronunciation';
import { makeId } from '../lib/hash';
import { engine } from '../lib/player/engine';
import type { PlayerSnapshot } from '../lib/player/engine';
import { kokoroClient } from '../lib/tts/kokoro/client';
import { DEFAULT_PRESET_ID, getPreset } from '../lib/tts/voices';

/**
 * Application state.
 *
 * Deliberately one small provider rather than a state library: the app has a
 * handful of genuinely global concerns (settings, the library, the open book,
 * the player) and everything else is local to a screen.
 */

export const DEFAULT_SETTINGS: Settings = {
  engine: 'kokoro',
  presetId: DEFAULT_PRESET_ID,
  rate: 1,
  volume: 1,
  theme: 'system',
  highlight: 'sentence',
  startupMode: 'balanced',
  skipSeconds: 15,
  fontScale: 1,
  lineHeight: 1.65,
  readingWidth: 1,
  autoScroll: true,
  batterySaver: false,
  characterVoices: false,
  showDiagnostics: false,
  deviceVoiceURI: null,
  kokoroDevice: 'auto',
  kokoroDtype: 'auto',
  cacheBudgetGb: 10,
};

export interface OpenDoc {
  meta: DocMeta;
  chapters: Chapter[];
  chunks: TextChunk[];
  chapterStarts: number[];
  position: ReadingPosition;
}

interface AppValue {
  ready: boolean;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;

  library: DocMeta[];
  refreshLibrary: () => Promise<void>;
  removeDoc: (id: string) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  toggleKeepOffline: (id: string) => Promise<void>;

  open: OpenDoc | null;
  openDoc: (id: string) => Promise<void>;
  closeDoc: () => void;
  reloadOpenDoc: () => Promise<void>;

  player: PlayerSnapshot;
  engineStatus: EngineStatus;
  preset: VoicePreset;

  characters: CharacterVoice[];
  detectDocCharacters: () => Promise<void>;
  setCharacterVoice: (id: string, presetId: string | null) => Promise<void>;
  addCharacter: (name: string) => Promise<void>;
  removeCharacter: (id: string) => Promise<void>;

  bookmarks: Bookmark[];
  addBookmark: (label: string) => Promise<void>;
  removeBookmark: (id: string) => Promise<void>;

  rules: PronunciationRule[];
  addRule: (rule: Omit<PronunciationRule, 'id'>) => Promise<void>;
  removeRule: (id: string) => Promise<void>;

  toast: string | null;
  showToast: (message: string) => void;
}

const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}

/** Resolve theme setting to the attribute the stylesheet reads. */
function applyTheme(theme: Settings['theme']): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);

  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0a0c12' : '#f6f7fb');
}

export function AppProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [library, setLibrary] = useState<DocMeta[]>([]);
  const [open, setOpen] = useState<OpenDoc | null>(null);
  const [player, setPlayer] = useState<PlayerSnapshot>(() => engine.snapshot());
  const [engineStatus, setEngineStatus] = useState<EngineStatus>(() => kokoroClient.getStatus());
  const [characters, setCharacters] = useState<CharacterVoice[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [rules, setRules] = useState<PronunciationRule[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3800);
  }, []);

  /* ---------------- boot ---------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [stored, docs, allRules] = await Promise.all([
        db.loadSettings(),
        db.listDocs(),
        db.listAllPronunciation(),
      ]);
      if (cancelled) return;
      const merged = { ...DEFAULT_SETTINGS, ...stored };
      setSettings(merged);
      setLibrary(docs);
      setRules(allRules);
      applyTheme(merged.theme);
      setReady(true);
      // Ask for durable storage so a long book's audio is not evicted.
      void db.requestPersistentStorage();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------- subscriptions ---------------- */

  useEffect(() => engine.subscribe(setPlayer), []);
  useEffect(() => kokoroClient.subscribe(setEngineStatus), []);

  // Follow the OS theme when the user has chosen "system".
  useEffect(() => {
    applyTheme(settings.theme);
    if (settings.theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [settings.theme]);

  // Reader typography is driven by CSS custom properties.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--font-scale', String(settings.fontScale));
    root.style.setProperty('--line-height', String(settings.lineHeight));
    root.style.setProperty('--reading-width', String(settings.readingWidth));
  }, [settings.fontScale, settings.lineHeight, settings.readingWidth]);

  // Start loading the voice model as soon as Kokoro is the selected engine.
  useEffect(() => {
    if (!ready) return;
    if (settings.engine === 'kokoro') {
      kokoroClient.init({ device: settings.kokoroDevice, dtype: settings.kokoroDtype });
    }
  }, [ready, settings.engine, settings.kokoroDevice, settings.kokoroDtype]);

  const preset = useMemo(() => {
    const chosen = getPreset(settings.presetId);
    // Guard against a preset that belongs to a different engine.
    if (chosen.engine !== settings.engine && settings.engine !== 'premium') {
      return getPreset(settings.engine === 'device' ? 'd_default' : DEFAULT_PRESET_ID);
    }
    return chosen;
  }, [settings.presetId, settings.engine]);

  // Books the user pinned for offline listening, so eviction can skip them.
  const keptOffline = useMemo(
    () => new Set(library.filter((d) => d.keepOffline).map((d) => d.id)),
    [library]
  );

  const characterPresets = useMemo(() => {
    const map = new Map<string, VoicePreset>();
    for (const c of characters) {
      if (c.presetId) map.set(c.name, getPreset(c.presetId));
    }
    return map;
  }, [characters]);

  // Push configuration into the engine whenever it changes.
  useEffect(() => {
    engine.configure({
      preset,
      mode: settings.engine,
      rate: settings.rate,
      volume: settings.volume,
      startupMode: settings.batterySaver ? 'smooth' : settings.startupMode,
      skipSeconds: settings.skipSeconds,
      deviceVoiceURI: settings.deviceVoiceURI,
      characterPresets,
      cacheBudgetGb: settings.cacheBudgetGb,
      keepOffline: keptOffline,
    });
  }, [
    preset,
    settings.engine,
    settings.rate,
    settings.volume,
    settings.startupMode,
    settings.skipSeconds,
    settings.deviceVoiceURI,
    settings.batterySaver,
    settings.cacheBudgetGb,
    characterPresets,
    keptOffline,
  ]);

  /* ---------------- settings ---------------- */

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void db.saveSettings(next);
      return next;
    });
  }, []);

  /* ---------------- library ---------------- */

  const refreshLibrary = useCallback(async () => {
    setLibrary(await db.listDocs());
  }, []);

  const removeDoc = useCallback(
    async (id: string) => {
      if (open?.meta.id === id) {
        engine.stop();
        setOpen(null);
      }
      await db.deleteDoc(id);
      await refreshLibrary();
    },
    [open, refreshLibrary]
  );

  const toggleFavorite = useCallback(
    async (id: string) => {
      const meta = await db.getDoc(id);
      if (!meta) return;
      await db.putDoc({ ...meta, favorite: !meta.favorite });
      await refreshLibrary();
    },
    [refreshLibrary]
  );

  /* ---------------- opening a document ---------------- */

  /**
   * Build the chunk plan for a document.
   *
   * Chunks are derived, never stored: the plan depends on the current
   * pronunciation rules, whether character voices are on, and how fast this
   * device generates. Recomputing is a few milliseconds of string work and
   * avoids an entire class of stale-cache bugs.
   */
  const prepareChunks = useCallback(
    (chapters: Chapter[], docId: string, allRules: PronunciationRule[]): TextChunk[] => {
      const options = chunkOptionsForSpeed(engineStatus.rtf, settings.characterVoices);
      const planned = planChunks(chapters, options);
      const compiled = compileRules(
        allRules.filter((r) => r.docId === null || r.docId === docId)
      );
      if (compiled.length === 0) return planned;
      // Spoken text diverges from displayed text only here.
      return planned.map((chunk) => ({
        ...chunk,
        text: applyRules(chunk.displayText, compiled),
      }));
    },
    [engineStatus.rtf, settings.characterVoices]
  );

  const loadIntoEngine = useCallback(
    async (meta: DocMeta, chapters: Chapter[], allRules: PronunciationRule[]) => {
      const chunks = prepareChunks(chapters, meta.id, allRules);
      const starts = chapterStartChunks(chunks, chapters.length);
      const stored = await db.getPosition(meta.id);
      const position: ReadingPosition = stored ?? {
        docId: meta.id,
        chunkIndex: 0,
        chapterIndex: 0,
        offsetSec: 0,
        updatedAt: Date.now(),
        listenedSec: 0,
        progress: 0,
      };

      setOpen({ meta, chapters, chunks, chapterStarts: starts, position });

      engine.onSavePosition((chunkIndex, offsetSec) => {
        const chapterIndex = chunks[chunkIndex]?.chapterIndex ?? 0;
        const next: ReadingPosition = {
          docId: meta.id,
          chunkIndex,
          chapterIndex,
          offsetSec,
          updatedAt: Date.now(),
          listenedSec: position.listenedSec,
          progress: chunks.length > 0 ? chunkIndex / chunks.length : 0,
        };
        void db.putPosition(next);
        void db.putDoc({ ...meta, updatedAt: Date.now() });
      });

      await engine.load({
        doc: meta,
        chapters,
        chunks,
        chapterStarts: starts,
        startChunk: Math.min(position.chunkIndex, Math.max(0, chunks.length - 1)),
        startOffset: position.offsetSec,
      });
    },
    [prepareChunks]
  );

  const toggleKeepOffline = useCallback(
    async (id: string) => {
      const meta = await db.getDoc(id);
      if (!meta) return;
      await db.putDoc({ ...meta, keepOffline: !meta.keepOffline });
      await refreshLibrary();
    },
    [refreshLibrary]
  );

  const openDoc = useCallback(
    async (id: string) => {
      const [meta, content, docRules, docChars, docMarks] = await Promise.all([
        db.getDoc(id),
        db.getContent(id),
        db.listPronunciation(id),
        db.listCharacters(id),
        db.listBookmarks(id),
      ]);
      if (!meta || !content) {
        showToast('That document could not be opened.');
        return;
      }
      setCharacters(docChars);
      setBookmarks(docMarks);
      setRules(await db.listAllPronunciation());
      await loadIntoEngine(meta, content.chapters, docRules);
    },
    [loadIntoEngine, showToast]
  );

  const reloadOpenDoc = useCallback(async () => {
    if (!open) return;
    await loadIntoEngine(open.meta, open.chapters, await db.listPronunciation(open.meta.id));
  }, [open, loadIntoEngine]);

  const closeDoc = useCallback(() => {
    engine.stop();
    setOpen(null);
    setCharacters([]);
    setBookmarks([]);
  }, []);

  /* ---------------- characters ---------------- */

  const detectDocCharacters = useCallback(async () => {
    if (!open) return;
    const found = detectCharacters(open.chapters);
    const existing = await db.listCharacters(open.meta.id);
    const byName = new Map(existing.map((c) => [c.name, c]));

    for (const { name, lineCount } of found) {
      const prior = byName.get(name);
      await db.putCharacter({
        id: prior?.id ?? makeId('chr'),
        docId: open.meta.id,
        name,
        presetId: prior?.presetId ?? null,
        lineCount,
        manual: prior?.manual ?? false,
      });
    }
    setCharacters(await db.listCharacters(open.meta.id));
    showToast(
      found.length === 0
        ? 'No recurring speakers were detected in this document.'
        : `Found ${found.length} character${found.length === 1 ? '' : 's'}.`
    );
  }, [open, showToast]);

  const setCharacterVoice = useCallback(
    async (id: string, presetId: string | null) => {
      const current = characters.find((c) => c.id === id);
      if (!current) return;
      await db.putCharacter({ ...current, presetId });
      setCharacters(await db.listCharacters(current.docId));
    },
    [characters]
  );

  const addCharacter = useCallback(
    async (name: string) => {
      if (!open || name.trim() === '') return;
      await db.putCharacter({
        id: makeId('chr'),
        docId: open.meta.id,
        name: name.trim(),
        presetId: null,
        lineCount: 0,
        manual: true,
      });
      setCharacters(await db.listCharacters(open.meta.id));
    },
    [open]
  );

  const removeCharacter = useCallback(
    async (id: string) => {
      const current = characters.find((c) => c.id === id);
      await db.deleteCharacter(id);
      if (current) setCharacters(await db.listCharacters(current.docId));
    },
    [characters]
  );

  /* ---------------- bookmarks ---------------- */

  const addBookmark = useCallback(
    async (label: string) => {
      if (!open) return;
      const chunk = open.chunks[player.chunkIndex];
      await db.putBookmark({
        id: makeId('bm'),
        docId: open.meta.id,
        chunkIndex: player.chunkIndex,
        chapterIndex: chunk?.chapterIndex ?? 0,
        label: label.trim() || 'Bookmark',
        preview: (chunk?.displayText ?? '').slice(0, 130),
        createdAt: Date.now(),
      });
      setBookmarks(await db.listBookmarks(open.meta.id));
      showToast('Bookmark saved.');
    },
    [open, player.chunkIndex, showToast]
  );

  const removeBookmark = useCallback(
    async (id: string) => {
      if (!open) return;
      await db.deleteBookmark(id);
      setBookmarks(await db.listBookmarks(open.meta.id));
    },
    [open]
  );

  /* ---------------- pronunciation ---------------- */

  const addRule = useCallback(
    async (rule: Omit<PronunciationRule, 'id'>) => {
      await db.putPronunciation({ ...rule, id: makeId('pr') });
      setRules(await db.listAllPronunciation());
      showToast('Pronunciation saved. It applies to newly generated audio.');
    },
    [showToast]
  );

  const removeRule = useCallback(
    async (id: string) => {
      await db.deletePronunciation(id);
      setRules(await db.listAllPronunciation());
    },
    []
  );

  /* ---------------- persistence on background ---------------- */

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') engine.savePositionNow();
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
    };
  }, []);

  const value: AppValue = {
    ready,
    settings,
    updateSettings,
    library,
    refreshLibrary,
    removeDoc,
    toggleFavorite,
    toggleKeepOffline,
    open,
    openDoc,
    closeDoc,
    reloadOpenDoc,
    player,
    engineStatus,
    preset,
    characters,
    detectDocCharacters,
    setCharacterVoice,
    addCharacter,
    removeCharacter,
    bookmarks,
    addBookmark,
    removeBookmark,
    rules,
    addRule,
    removeRule,
    toast,
    showToast,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
