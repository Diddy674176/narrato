import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type {
  Bookmark,
  CharacterVoice,
  DocContent,
  DocMeta,
  PronunciationRule,
  ReadingPosition,
  Settings,
} from '../types';

/**
 * On-device storage.
 *
 * Narrato is a static site with no server, so IndexedDB *is* the backend:
 * documents, generated audio, positions and settings never leave the device.
 * That is also why the audio cache needs a real eviction policy - we are
 * spending the user's storage quota, not ours.
 */

export interface CachedAudio {
  key: string;
  docId: string;
  chunkIndex: number;
  voiceId: string;
  textHash: string;
  blob: Blob;
  durationSec: number;
  bytes: number;
  createdAt: number;
}

interface NarratoDB extends DBSchema {
  meta: { key: string; value: DocMeta; indexes: { updatedAt: number } };
  content: { key: string; value: DocContent };
  positions: { key: string; value: ReadingPosition };
  audio: {
    key: string;
    value: CachedAudio;
    indexes: { docId: string; createdAt: number };
  };
  bookmarks: { key: string; value: Bookmark; indexes: { docId: string } };
  pronunciation: { key: string; value: PronunciationRule; indexes: { docId: string } };
  characters: { key: string; value: CharacterVoice; indexes: { docId: string } };
  kv: { key: string; value: unknown };
}

const DB_NAME = 'narrato';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<NarratoDB>> | null = null;

function getDb(): Promise<IDBPDatabase<NarratoDB>> {
  if (!dbPromise) {
    dbPromise = openDB<NarratoDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const meta = db.createObjectStore('meta', { keyPath: 'id' });
        meta.createIndex('updatedAt', 'updatedAt');

        db.createObjectStore('content', { keyPath: 'id' });
        db.createObjectStore('positions', { keyPath: 'docId' });

        const audio = db.createObjectStore('audio', { keyPath: 'key' });
        audio.createIndex('docId', 'docId');
        audio.createIndex('createdAt', 'createdAt');

        const bookmarks = db.createObjectStore('bookmarks', { keyPath: 'id' });
        bookmarks.createIndex('docId', 'docId');

        const pron = db.createObjectStore('pronunciation', { keyPath: 'id' });
        pron.createIndex('docId', 'docId');

        const chars = db.createObjectStore('characters', { keyPath: 'id' });
        chars.createIndex('docId', 'docId');

        db.createObjectStore('kv');
      },
    });
  }
  return dbPromise;
}

/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

export async function listDocs(): Promise<DocMeta[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex('meta', 'updatedAt');
  return all.reverse();
}

export async function getDoc(id: string): Promise<DocMeta | undefined> {
  return (await getDb()).get('meta', id);
}

export async function putDoc(meta: DocMeta): Promise<void> {
  await (await getDb()).put('meta', meta);
}

export async function getContent(id: string): Promise<DocContent | undefined> {
  return (await getDb()).get('content', id);
}

export async function putContent(content: DocContent): Promise<void> {
  await (await getDb()).put('content', content);
}

/** Remove a document and everything derived from it. */
export async function deleteDoc(id: string): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db.delete('meta', id),
    db.delete('content', id),
    db.delete('positions', id),
    deleteByIndex('audio', id),
    deleteByIndex('bookmarks', id),
    deleteByIndex('characters', id),
    deleteByIndex('pronunciation', id),
  ]);
}

async function deleteByIndex(
  store: 'audio' | 'bookmarks' | 'characters' | 'pronunciation',
  docId: string
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(store, 'readwrite');
  const index = tx.store.index('docId');
  let cursor = await index.openCursor(IDBKeyRange.only(docId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

/* ------------------------------------------------------------------ *
 * Reading position
 * ------------------------------------------------------------------ */

export async function getPosition(docId: string): Promise<ReadingPosition | undefined> {
  return (await getDb()).get('positions', docId);
}

export async function putPosition(pos: ReadingPosition): Promise<void> {
  await (await getDb()).put('positions', pos);
}

/* ------------------------------------------------------------------ *
 * Audio cache
 * ------------------------------------------------------------------ */

/**
 * Cache key. Everything that can change the waveform goes in, so switching
 * voices creates a parallel cache instead of invalidating the old one.
 */
export function audioKey(parts: {
  docId: string;
  chunkIndex: number;
  voiceId: string;
  textHash: string;
  modelVersion: string;
}): string {
  return [parts.docId, parts.chunkIndex, parts.voiceId, parts.textHash, parts.modelVersion].join('|');
}

export async function getAudio(key: string): Promise<CachedAudio | undefined> {
  return (await getDb()).get('audio', key);
}

export async function putAudio(entry: CachedAudio): Promise<void> {
  await (await getDb()).put('audio', entry);
}

/** Which of these keys are already cached (used to show chapter readiness). */
export async function hasAudioKeys(keys: string[]): Promise<Set<string>> {
  const db = await getDb();
  const tx = db.transaction('audio');
  const found = new Set<string>();
  await Promise.all(
    keys.map(async (k) => {
      const hit = await tx.store.getKey(k);
      if (hit !== undefined) found.add(k);
    })
  );
  await tx.done;
  return found;
}

export async function audioStats(): Promise<{ count: number; bytes: number }> {
  const db = await getDb();
  let count = 0;
  let bytes = 0;
  let cursor = await db.transaction('audio').store.openCursor();
  while (cursor) {
    count += 1;
    bytes += cursor.value.bytes;
    cursor = await cursor.continue();
  }
  return { count, bytes };
}

export async function clearAudioForDoc(docId: string): Promise<void> {
  await deleteByIndex('audio', docId);
}

export async function clearAllAudio(): Promise<void> {
  const db = await getDb();
  await db.clear('audio');
}

/** Bytes of cached audio per second of speech: 24 kHz, 16-bit mono WAV. */
export const AUDIO_BYTES_PER_SEC = 24_000 * 2;

/**
 * How much cached audio we allow.
 *
 * A flat cap is the wrong shape here: six hours of narration - an ordinary
 * novel - is about 1 GB, so any fixed number small enough to feel polite is
 * also too small to hold one book. Instead we take a share of what the browser
 * actually offers this origin, which on a phone with free space is plenty.
 */
export async function cacheBudgetBytes(): Promise<number> {
  const MIN = 512 * 1024 * 1024;
  const MAX = 8 * 1024 * 1024 * 1024;
  const est = await storageEstimate();
  if (!est || est.quota <= 0) return MIN;
  return Math.max(MIN, Math.min(MAX, Math.floor(est.quota * 0.6)));
}

export interface EvictionResult {
  freed: number;
  /** True when the cache is still over budget after evicting everything we may. */
  stillOver: boolean;
}

/**
 * Keep the cache under budget by evicting the oldest entries first.
 *
 * The document being listened to is protected, so a long book is never caught
 * deleting its own buffer mid-sentence. The consequence is that one very large
 * book can still exceed the budget on its own - `stillOver` reports that,
 * rather than letting the caller assume the eviction succeeded.
 */
export async function enforceCacheBudget(
  budgetBytes: number,
  protectDocId: string | null
): Promise<EvictionResult> {
  const db = await getDb();
  const { bytes } = await audioStats();
  if (bytes <= budgetBytes) return { freed: 0, stillOver: false };

  let toFree = bytes - budgetBytes;
  let freed = 0;
  const tx = db.transaction('audio', 'readwrite');
  let cursor = await tx.store.index('createdAt').openCursor();

  while (cursor && toFree > 0) {
    if (cursor.value.docId !== protectDocId) {
      toFree -= cursor.value.bytes;
      freed += cursor.value.bytes;
      await cursor.delete();
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return { freed, stillOver: toFree > 0 };
}

/** True when a failed write was the browser refusing on storage grounds. */
export function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    /quota|storage|disk/i.test(err.message)
  );
}

/* ------------------------------------------------------------------ *
 * Bookmarks / characters / pronunciation
 * ------------------------------------------------------------------ */

export async function listBookmarks(docId: string): Promise<Bookmark[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex('bookmarks', 'docId', IDBKeyRange.only(docId));
  return all.sort((a, b) => a.chunkIndex - b.chunkIndex);
}

export async function putBookmark(b: Bookmark): Promise<void> {
  await (await getDb()).put('bookmarks', b);
}

export async function deleteBookmark(id: string): Promise<void> {
  await (await getDb()).delete('bookmarks', id);
}

export async function listCharacters(docId: string): Promise<CharacterVoice[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex('characters', 'docId', IDBKeyRange.only(docId));
  return all.sort((a, b) => b.lineCount - a.lineCount);
}

export async function putCharacter(c: CharacterVoice): Promise<void> {
  await (await getDb()).put('characters', c);
}

export async function deleteCharacter(id: string): Promise<void> {
  await (await getDb()).delete('characters', id);
}

/** Global rules plus any belonging to this document. */
export async function listPronunciation(docId: string | null): Promise<PronunciationRule[]> {
  const db = await getDb();
  const all = await db.getAll('pronunciation');
  return all.filter((r) => r.docId === null || (docId !== null && r.docId === docId));
}

export async function listAllPronunciation(): Promise<PronunciationRule[]> {
  return (await getDb()).getAll('pronunciation');
}

export async function putPronunciation(rule: PronunciationRule): Promise<void> {
  await (await getDb()).put('pronunciation', rule);
}

export async function deletePronunciation(id: string): Promise<void> {
  await (await getDb()).delete('pronunciation', id);
}

/* ------------------------------------------------------------------ *
 * Settings + misc key/value
 * ------------------------------------------------------------------ */

const SETTINGS_KEY = 'settings';

export async function loadSettings(): Promise<Partial<Settings> | undefined> {
  return (await getDb()).get('kv', SETTINGS_KEY) as Promise<Partial<Settings> | undefined>;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await (await getDb()).put('kv', settings, SETTINGS_KEY);
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  return (await getDb()).get('kv', key) as Promise<T | undefined>;
}

export async function setKv(key: string, value: unknown): Promise<void> {
  await (await getDb()).put('kv', value, key);
}

/** Best-effort persistent-storage grant, so a long book is not evicted by the OS. */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}
