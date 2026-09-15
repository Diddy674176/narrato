// In-memory stand-in for the IndexedDB layer.
export interface CachedAudio {
  key: string; docId: string; chunkIndex: number; voiceId: string;
  textHash: string; blob: Blob; durationSec: number; bytes: number; createdAt: number;
}
export const store = new Map<string, CachedAudio>();
export const stats = { reads: 0, writes: 0 };

export function audioKey(p: { docId: string; chunkIndex: number; voiceId: string; textHash: string; modelVersion: string }): string {
  return [p.docId, p.chunkIndex, p.voiceId, p.textHash, p.modelVersion].join('|');
}
export async function getAudio(key: string): Promise<CachedAudio | undefined> {
  stats.reads++;
  return store.get(key);
}
export async function putAudio(entry: CachedAudio): Promise<void> {
  stats.writes++;
  store.set(entry.key, entry);
}
export async function enforceCacheBudget(): Promise<number> { return 0; }

export async function hasAudioKeys(keys: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const k of keys) if (store.has(k)) found.add(k);
  return found;
}
