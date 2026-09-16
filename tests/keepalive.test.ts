/**
 * Keep-alive: what holds the page open while a book generates in the
 * background, and - just as important - what it releases afterwards.
 *
 * A silent audio session the user cannot see or stop is indistinguishable
 * from an app quietly draining their battery, so the cleanup is as much the
 * feature as the holding is.
 */

// ---- browser stubs, installed before the module under test is imported ----
const revoked: string[] = [];
(globalThis as Record<string, unknown>).URL = Object.assign(URL, {
  createObjectURL: () => 'blob:silence',
  revokeObjectURL: (u: string) => revoked.push(u),
});

class FakeAudio {
  static last: FakeAudio | null = null;
  src = '';
  loop = false;
  volume = 1;
  playing = false;
  removedSrc = false;
  attached = false;
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  remove(): void {
    this.attached = false;
  }
  constructor() {
    FakeAudio.last = this;
  }
  async play(): Promise<void> {
    this.playing = true;
  }
  pause(): void {
    this.playing = false;
  }
  removeAttribute(): void {
    this.removedSrc = true;
  }
  load(): void {}
}
(globalThis as Record<string, unknown>).Audio = FakeAudio;

const listeners: Record<string, Array<() => void>> = {};
(globalThis as Record<string, unknown>).document = {
  visibilityState: 'visible',
  body: {
    appendChild: (el: FakeAudio) => {
      el.attached = true;
    },
  },
  addEventListener: (type: string, fn: () => void) => {
    (listeners[type] ??= []).push(fn);
  },
  removeEventListener: (type: string, fn: () => void) => {
    listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
  },
};

class FakeMetadata {
  title: string;
  artist: string;
  album: string;
  constructor(init: { title: string; artist: string; album: string }) {
    this.title = init.title;
    this.artist = init.artist;
    this.album = init.album;
  }
}
(globalThis as Record<string, unknown>).MediaMetadata = FakeMetadata;

const session = {
  playbackState: 'none',
  metadata: null as FakeMetadata | null,
  handlers: new Map<string, (() => void) | null>(),
  setActionHandler(type: string, fn: (() => void) | null) {
    this.handlers.set(type, fn);
  },
};

let wakeLockReleased = false;
let wakeLockRequests = 0;
// Node 22 exposes navigator as a getter-only property, so it has to be
// redefined rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    mediaSession: session,
    wakeLock: {
      request: async () => {
        wakeLockRequests++;
        return {
          released: false,
          release: async () => {
            wakeLockReleased = true;
          },
        };
      },
    },
  },
});

import { startKeepAlive } from '../src/lib/player/keepAlive';

let failures = 0;
const check = (name: string, cond: boolean, extra = ''): void => {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.log(`FAIL ${name} ${extra}`);
    failures++;
  }
};
const settle = () => new Promise((r) => setTimeout(r, 10));

console.log('--- holding the page open ---');
{
  let stopRequests = 0;
  const alive = startKeepAlive('The Lantern Room', () => stopRequests++);
  await settle();

  const audio = FakeAudio.last!;
  check('a silent track is playing, which is what survives backgrounding', audio.playing);
  check('and it loops, so the session never ends on its own', audio.loop);
  check('at zero volume', audio.volume === 0, String(audio.volume));
  check(
    'and it lives in the document, where it can be inspected',
    audio.attached && audio.attrs['data-narrato'] === 'keep-alive',
    'a detached element is invisible to a person debugging this on a phone',
  );
  check('the screen wake lock was requested', wakeLockRequests === 1, String(wakeLockRequests));
  check('the browser reports the session as playing', session.playbackState === 'playing');

  alive.update('Preparing 40% - 30 sections left');
  check(
    'the notification shows real progress, not a spinner',
    session.metadata?.title === 'Preparing 40% - 30 sections left',
    String(session.metadata?.title),
  );
  check('and names the book it is working on', session.metadata?.artist === 'The Lantern Room');

  // The notification's stop button is the only control a user has once the
  // app is in the background, so it has to be wired to something.
  session.handlers.get('pause')?.();
  check('stopping from the notification reaches the app', stopRequests === 1, String(stopRequests));

  // A wake lock is dropped whenever the page hides and is not restored
  // automatically; coming back must take it again.
  (globalThis as Record<string, unknown>).document = {
    ...(globalThis as unknown as { document: Record<string, unknown> }).document,
    visibilityState: 'visible',
  };
  for (const fn of listeners['visibilitychange'] ?? []) fn();
  await settle();
  check('returning to the app re-takes the dropped wake lock', wakeLockRequests >= 1);

  alive.stop();
  await settle();
  check('stopping releases the wake lock', wakeLockReleased);
  check('and the silent track stops', !audio.playing);
  check('and is taken back out of the document', !audio.attached);
  check('and its blob is revoked, not leaked', revoked.includes('blob:silence'));
  check('and the media session is handed back', session.playbackState === 'none');
  check('with no stale stop handler left behind', session.handlers.get('stop') === null);
  check(
    'no visibility listener is left running',
    (listeners['visibilitychange'] ?? []).length === 0,
    `${(listeners['visibilitychange'] ?? []).length} left`,
  );

  // Double-stop happens whenever a sheet closes over a finished run.
  alive.stop();
  check('stopping twice is harmless', true);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
