/**
 * Media Session wiring: lock-screen art, titles, transport buttons, and the
 * scrubber position. This is what makes headphone and Bluetooth buttons work
 * and what keeps the notification alive while the screen is off.
 *
 * Every call is feature-detected - Media Session is absent or partial on a lot
 * of browsers, and a missing action handler must never break playback.
 */

export interface MediaHandlers {
  play: () => void;
  pause: () => void;
  stop: () => void;
  seekBackward: () => void;
  seekForward: () => void;
  previousTrack: () => void;
  nextTrack: () => void;
  seekTo?: (time: number) => void;
}

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

/**
 * Generate cover art at runtime.
 *
 * Android's media notification wants a real bitmap; an SVG will not render
 * there. Drawing a small canvas keeps the artwork on-brand without shipping
 * extra image assets.
 */
function makeArtwork(title: string): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, '#6d5cff');
    gradient.addColorStop(1, '#1b1f2e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const initial = (title.trim()[0] ?? 'N').toUpperCase();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '600 260px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, size / 2, size / 2 + 12);

    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

const artworkCache = new Map<string, string>();

export function setMediaMetadata(opts: {
  title: string;
  chapter: string;
  author: string | null;
}): void {
  if (!supported()) return;

  let art = artworkCache.get(opts.title);
  if (art === undefined) {
    art = makeArtwork(opts.title) ?? '';
    artworkCache.set(opts.title, art);
  }

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: opts.chapter || opts.title,
      artist: opts.author ?? 'Narrato',
      album: opts.title,
      artwork: art ? [{ src: art, sizes: '512x512', type: 'image/png' }] : [],
    });
  } catch {
    /* Metadata is cosmetic; never let it break playback. */
  }
}

export function setMediaHandlers(handlers: MediaHandlers): void {
  if (!supported()) return;

  const set = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {
      /* Unsupported action on this browser. */
    }
  };

  set('play', () => handlers.play());
  set('pause', () => handlers.pause());
  set('stop', () => handlers.stop());
  set('seekbackward', () => handlers.seekBackward());
  set('seekforward', () => handlers.seekForward());
  set('previoustrack', () => handlers.previousTrack());
  set('nexttrack', () => handlers.nextTrack());
  set('seekto', (details) => {
    if (handlers.seekTo && typeof details.seekTime === 'number') handlers.seekTo(details.seekTime);
  });
}

export function clearMediaHandlers(): void {
  if (!supported()) return;
  const actions: MediaSessionAction[] = [
    'play', 'pause', 'stop', 'seekbackward', 'seekforward',
    'previoustrack', 'nexttrack', 'seekto',
  ];
  for (const a of actions) {
    try {
      navigator.mediaSession.setActionHandler(a, null);
    } catch {
      /* ignore */
    }
  }
}

export function setPlaybackState(state: 'playing' | 'paused' | 'none'): void {
  if (!supported()) return;
  try {
    navigator.mediaSession.playbackState = state;
  } catch {
    /* ignore */
  }
}

/**
 * Feed the lock-screen scrubber.
 *
 * Chrome throws if duration is not finite or position exceeds it, which is easy
 * to hit mid-chunk-swap, so everything is clamped before it is handed over.
 */
export function setPositionState(duration: number, position: number, rate: number): void {
  if (!supported() || !('setPositionState' in navigator.mediaSession)) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.max(0, Math.min(position, duration)),
      playbackRate: rate > 0 ? rate : 1,
    });
  } catch {
    /* ignore */
  }
}
