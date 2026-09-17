/**
 * Storage-layer tests against the real IndexedDB code, backed by
 * fake-indexeddb.
 *
 * The behaviour under test is the one whose failure is silent and painful:
 * preparing a new book must not delete the books already prepared for a trip.
 */
import 'fake-indexeddb/auto';

// effectiveCacheBudget consults navigator.storage; provide a controllable one.
// Node 22 exposes `navigator` as a getter-only global, so it must be redefined
// rather than assigned.
let fakeQuota = 20 * 1024 * 1024 * 1024;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    storage: {
      estimate: async () => ({ usage: 0, quota: fakeQuota }),
      persisted: async () => true,
      persist: async () => true,
    },
  },
});

import {
  audioStats,
  audioStatsByDoc,
  clearAllAudio,
  effectiveCacheBudget,
  enforceCacheBudget,
  isQuotaError,
  putAudio,
  MAX_CACHE_BUDGET_GB,
} from '../src/lib/db';

let failures = 0;
const check = (name: string, cond: boolean, extra = ''): void => {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.log(`FAIL ${name} ${extra}`);
    failures++;
  }
};

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Seed one cached chunk. `age` orders eviction: lower = older. */
async function seed(docId: string, index: number, bytes: number, age: number): Promise<void> {
  await putAudio({
    key: `${docId}|${index}`,
    docId,
    chunkIndex: index,
    voiceId: 'v',
    textHash: 'h',
    blob: new Blob([new Uint8Array(8)]),
    durationSec: 30,
    bytes,
    createdAt: age,
  });
}

async function docIds(): Promise<string[]> {
  return [...(await audioStatsByDoc()).keys()].sort();
}

/* ------------------------------------------------------------------ */
console.log('--- eviction protects the books you chose to keep ---');
{
  await clearAllAudio();
  // Oldest first: an old finished book, two books pinned for a trip, and the
  // book currently playing.
  await seed('old_finished', 0, 100 * MB, 1);
  await seed('trip_a', 0, 100 * MB, 2);
  await seed('trip_b', 0, 100 * MB, 3);
  await seed('now_playing', 0, 100 * MB, 4);

  const before = await audioStats();
  check('seeded four books', before.bytes === 400 * MB, `${before.bytes / MB} MB`);

  // Budget forces roughly one book's worth to go.
  const result = await enforceCacheBudget(
    320 * MB,
    'now_playing',
    new Set(['trip_a', 'trip_b'])
  );

  const left = await docIds();
  check('something was evicted', result.freed > 0, `freed=${result.freed / MB} MB`);
  check(
    'the unpinned, oldest book is the one deleted',
    !left.includes('old_finished'),
    `left=${left.join(',')}`,
  );
  check('a book kept for offline survives', left.includes('trip_a'));
  check('the other kept book survives too', left.includes('trip_b'));
  check('the book being listened to survives', left.includes('now_playing'));
  check('eviction reports it got under budget', result.stillOver === false);
}

console.log('\n--- nothing evictable is reported, not hidden ---');
{
  await clearAllAudio();
  await seed('trip_a', 0, 400 * MB, 1);
  await seed('now_playing', 0, 400 * MB, 2);

  // Everything present is protected, so the budget cannot be met.
  const result = await enforceCacheBudget(100 * MB, 'now_playing', new Set(['trip_a']));
  const left = await docIds();

  check('protected books are not deleted to hit a budget', left.length === 2, left.join(','));
  check(
    'being unable to free space is reported',
    result.stillOver === true,
    'otherwise the caller assumes the cache is healthy',
  );
}

console.log('\n--- eviction is a no-op below budget ---');
{
  await clearAllAudio();
  await seed('a', 0, 50 * MB, 1);
  const result = await enforceCacheBudget(10 * GB, null, new Set());
  check('nothing is touched when under budget', result.freed === 0 && !result.stillOver);
  check('the book is still there', (await docIds()).length === 1);
}

console.log('\n--- per-book usage powers the storage screen ---');
{
  await clearAllAudio();
  await seed('a', 0, 10 * MB, 1);
  await seed('a', 1, 15 * MB, 2);
  await seed('b', 0, 5 * MB, 3);

  const stats = await audioStatsByDoc();
  check('book A totals its sections', stats.get('a')?.bytes === 25 * MB, String(stats.get('a')?.bytes));
  check('book A counts its sections', stats.get('a')?.count === 2);
  check('book B is separate', stats.get('b')?.bytes === 5 * MB);
}

/* ------------------------------------------------------------------ */
console.log('\n--- the budget respects both the user and the browser ---');
{
  fakeQuota = 20 * GB;
  const roomy = await effectiveCacheBudget(10);
  check('a 10 GB request is granted when there is room', roomy.budget === 10 * GB,
    `${roomy.budget / GB} GB`);
  check('and is not flagged as limited', roomy.quotaLimited === false);

  // A phone that will only grant 3 GB cannot honour a 10 GB preference.
  fakeQuota = 3 * GB;
  const tight = await effectiveCacheBudget(10);
  check('a small quota caps the budget', tight.budget < 10 * GB, `${tight.budget / GB} GB`);
  check('the cap leaves headroom for documents and the model', tight.budget <= 3 * GB * 0.85 + 1);
  check(
    'the user is told the browser is the binding limit',
    tight.quotaLimited === true,
    'otherwise the setting silently lies',
  );
  check('the requested amount is still reported', tight.requested === 10 * GB);

  // A smaller preference is honoured as-is.
  fakeQuota = 20 * GB;
  const modest = await effectiveCacheBudget(2);
  check('a modest preference is used verbatim', modest.budget === 2 * GB);
  check('and is not flagged as limited', modest.quotaLimited === false);

  const clamped = await effectiveCacheBudget(999);
  check(
    `a request beyond ${MAX_CACHE_BUDGET_GB} GB is clamped`,
    clamped.budget === MAX_CACHE_BUDGET_GB * GB,
    `${clamped.budget / GB} GB`,
  );
}

console.log('\n--- quota errors are recognised ---');
{
  const quota = new Error('nope');
  quota.name = 'QuotaExceededError';
  check('a QuotaExceededError is recognised', isQuotaError(quota));
  check('a message about storage is recognised', isQuotaError(new Error('disk is full')));
  check('an unrelated error is not', isQuotaError(new Error('network down')) === false);
  check('a non-error is not', isQuotaError('oops') === false);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
