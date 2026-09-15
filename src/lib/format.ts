/** "1:04:12" / "4:12" — omits the hours field when there is none. */
export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor(totalSeconds / 3600);
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** "3 hr 20 min" — for durations shown as a summary rather than a clock. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '—';
  const mins = Math.round(totalSeconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}

/** "just now" / "3 days ago" */
export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  if (diff < min) return 'just now';
  if (diff < 60 * min) return `${Math.floor(diff / min)} min ago`;
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))} hr ago`;
  const days = Math.floor(diff / (24 * 60 * min));
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(ts).toLocaleDateString();
}
