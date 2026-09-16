/**
 * Silent WAV clips, built at runtime.
 *
 * Two jobs, both about mobile audio policy rather than sound:
 *
 * - unlocking the audio element inside a user gesture, because a mobile
 *   browser will not let us play anything later on an element that has never
 *   played during a tap;
 * - holding an audio session open while the app has nothing to say, which is
 *   what stops the browser suspending the page when it goes to the background.
 */
export function silentWavUrl(seconds = 0.05): string {
  const sampleRate = 8000;
  const samples = Math.max(1, Math.round(sampleRate * seconds));
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}
