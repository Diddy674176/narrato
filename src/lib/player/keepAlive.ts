/**
 * Keeping generation alive when the app is not in front of you.
 *
 * What the web platform actually allows, stated plainly, because the shape of
 * this feature is dictated by it:
 *
 * - With the tab or installed app **closed**, nothing runs. A service worker
 *   cannot host a neural network for half an hour; it is killed in seconds.
 *   No amount of code makes "closed" work, so the UI must not promise it.
 * - With the app **backgrounded or the screen locked**, a page is suspended -
 *   *unless* it holds an audio session. That is the same mechanism that keeps
 *   music playing when you switch apps, and it is available to us because this
 *   is an audio app. A silent looping track holds the session open while the
 *   model works.
 * - A **screen wake lock** covers the other case: phone face-up on the table,
 *   nobody touching it, screen would otherwise sleep.
 *
 * So: put the phone down, switch apps, lock it, go and eat - the book keeps
 * generating. Swipe the app away and it stops, and the UI says so.
 *
 * The media notification shows real progress and carries a stop button, since
 * a silent session the user cannot see or cancel would be indistinguishable
 * from an app quietly eating their battery.
 */
import { silentWavUrl } from './silence';

interface WakeLock {
  release: () => Promise<void>;
  released: boolean;
}

export interface KeepAlive {
  /** Update the text shown in the media notification. */
  update(status: string): void;
  stop(): void;
  /** False when the browser refused the audio session; work still proceeds. */
  readonly holding: boolean;
}

function mediaSession(): MediaSession | null {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return null;
  return navigator.mediaSession;
}

/**
 * Start holding the page open.
 *
 * Must be called inside the user gesture that starts the work: playing even a
 * silent track is subject to autoplay policy, and a promise resolved later has
 * already lost the gesture.
 */
export function startKeepAlive(title: string, onStop: () => void): KeepAlive {
  let stopped = false;
  let holding = false;
  let wakeLock: WakeLock | null = null;

  const url = silentWavUrl(1);
  const audio = new Audio();
  audio.src = url;
  audio.loop = true;
  // Silent already, but an explicit zero survives a browser that decides to
  // resample or normalise the clip.
  audio.volume = 0;
  // In the document rather than floating free: an attached element is one a
  // person can inspect, and one a test can find. A detached `new Audio()` is
  // invisible to everything except the code holding the reference.
  audio.setAttribute('data-narrato', 'keep-alive');
  audio.setAttribute('aria-hidden', 'true');
  audio.style.display = 'none';
  document.body.appendChild(audio);

  void audio
    .play()
    .then(() => {
      holding = true;
    })
    .catch(() => {
      // Autoplay refused: generation still runs while the app is in front,
      // it simply will not survive being backgrounded.
      holding = false;
    });

  const session = mediaSession();
  if (session) {
    try {
      session.playbackState = 'playing';
      session.setActionHandler('pause', onStop);
      session.setActionHandler('stop', onStop);
    } catch {
      /* partial Media Session support: the notification is cosmetic anyway */
    }
  }

  const requestWakeLock = async (): Promise<void> => {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLock> };
    };
    if (!nav.wakeLock || stopped) return;
    try {
      wakeLock = await nav.wakeLock.request('screen');
    } catch {
      /* denied, or the document is hidden: not fatal */
    }
  };
  void requestWakeLock();

  // A wake lock is dropped whenever the page is hidden, and is not restored
  // automatically - so take it again each time the app comes back.
  const onVisibility = (): void => {
    if (!stopped && document.visibilityState === 'visible' && (!wakeLock || wakeLock.released)) {
      void requestWakeLock();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  const update = (status: string): void => {
    const s = mediaSession();
    if (!s || stopped) return;
    try {
      s.metadata = new MediaMetadata({
        title: status,
        artist: title,
        album: 'Narrato is preparing this book',
      });
    } catch {
      /* metadata is a nicety, never a requirement */
    }
  };
  update('Preparing audio');

  return {
    update,
    get holding() {
      return holding;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        audio.remove();
      } catch {
        /* already gone */
      }
      URL.revokeObjectURL(url);
      void wakeLock?.release().catch(() => undefined);
      const s = mediaSession();
      if (s) {
        try {
          s.setActionHandler('pause', null);
          s.setActionHandler('stop', null);
          s.playbackState = 'none';
        } catch {
          /* nothing to clear */
        }
      }
    },
  };
}
