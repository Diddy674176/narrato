import type { KokoroVoiceId, VoicePreset } from '../../types';

/**
 * Voice catalogue.
 *
 * Presets are friendly names mapped onto concrete engine voices. Some presets
 * share an underlying Kokoro voice but differ in delivery bias (a "Dark Fantasy
 * Narrator" is Fenrir read slower than the plain "Fantasy Narrator"), so the UI
 * always shows the underlying voice id and Kokoro's own quality grade - the
 * labels here are informed guesses from Kokoro's published voice metadata, not
 * from listening, and the grade is what should drive the final choice.
 *
 * All "sultry"/"mature" presets are adult voices.
 */

interface KokoroVoiceInfo {
  grade: string;
  gender: 'male' | 'female';
  accent: 'american' | 'british';
  name: string;
}

/** Straight from kokoro-js VOICES metadata (overallGrade). */
export const KOKORO_VOICE_INFO: Record<KokoroVoiceId, KokoroVoiceInfo> = {
  af_heart: { grade: 'A', gender: 'female', accent: 'american', name: 'Heart' },
  af_bella: { grade: 'A-', gender: 'female', accent: 'american', name: 'Bella' },
  af_nicole: { grade: 'B-', gender: 'female', accent: 'american', name: 'Nicole' },
  af_aoede: { grade: 'C+', gender: 'female', accent: 'american', name: 'Aoede' },
  af_kore: { grade: 'C+', gender: 'female', accent: 'american', name: 'Kore' },
  af_sarah: { grade: 'C+', gender: 'female', accent: 'american', name: 'Sarah' },
  af_nova: { grade: 'C', gender: 'female', accent: 'american', name: 'Nova' },
  af_alloy: { grade: 'C', gender: 'female', accent: 'american', name: 'Alloy' },
  af_sky: { grade: 'C-', gender: 'female', accent: 'american', name: 'Sky' },
  af_jessica: { grade: 'D', gender: 'female', accent: 'american', name: 'Jessica' },
  af_river: { grade: 'D', gender: 'female', accent: 'american', name: 'River' },
  am_fenrir: { grade: 'C+', gender: 'male', accent: 'american', name: 'Fenrir' },
  am_michael: { grade: 'C+', gender: 'male', accent: 'american', name: 'Michael' },
  am_puck: { grade: 'C+', gender: 'male', accent: 'american', name: 'Puck' },
  am_echo: { grade: 'D', gender: 'male', accent: 'american', name: 'Echo' },
  am_eric: { grade: 'D', gender: 'male', accent: 'american', name: 'Eric' },
  am_liam: { grade: 'D', gender: 'male', accent: 'american', name: 'Liam' },
  am_onyx: { grade: 'D', gender: 'male', accent: 'american', name: 'Onyx' },
  am_santa: { grade: 'D-', gender: 'male', accent: 'american', name: 'Santa' },
  am_adam: { grade: 'F+', gender: 'male', accent: 'american', name: 'Adam' },
  bf_emma: { grade: 'B-', gender: 'female', accent: 'british', name: 'Emma' },
  bf_isabella: { grade: 'C', gender: 'female', accent: 'british', name: 'Isabella' },
  bf_alice: { grade: 'D', gender: 'female', accent: 'british', name: 'Alice' },
  bf_lily: { grade: 'D', gender: 'female', accent: 'british', name: 'Lily' },
  bm_george: { grade: 'C', gender: 'male', accent: 'british', name: 'George' },
  bm_fable: { grade: 'C', gender: 'male', accent: 'british', name: 'Fable' },
  bm_lewis: { grade: 'D+', gender: 'male', accent: 'british', name: 'Lewis' },
  bm_daniel: { grade: 'D', gender: 'male', accent: 'british', name: 'Daniel' },
};

/** Sort order for grades, best first. */
const GRADE_ORDER = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F+', 'F'];

export function gradeRank(grade: string | undefined): number {
  if (!grade) return GRADE_ORDER.length;
  const i = GRADE_ORDER.indexOf(grade);
  return i === -1 ? GRADE_ORDER.length : i;
}

function kokoro(
  id: string,
  label: string,
  voice: KokoroVoiceId,
  description: string,
  tags: string[],
  rateBias = 1
): VoicePreset {
  const info = KOKORO_VOICE_INFO[voice];
  return {
    id,
    label,
    engine: 'kokoro',
    kokoroVoice: voice,
    gender: info.gender,
    accent: info.accent,
    description,
    rateBias,
    pitch: 1,
    quality: info.grade,
    tags,
  };
}

/**
 * Kokoro presets, ordered so the highest-graded voices appear first. The order
 * matters: it is what most users will pick from without previewing.
 */
export const KOKORO_PRESETS: VoicePreset[] = [
  kokoro('k_audiobook_f', 'Audiobook Narrator (Female)', 'af_bella', 'Warm, steady long-form narration.', ['narrator', 'female']),
  kokoro('k_soft_f', 'Soft Female', 'af_heart', 'Gentle and close; Kokoro’s best-rated voice.', ['soft', 'female']),
  kokoro('k_narrator_f', 'Female Narrator', 'af_heart', 'Clear, neutral storytelling.', ['narrator', 'female'], 0.98),
  kokoro('k_sultry_f', 'Adult Sultry Female', 'af_nicole', 'Low, intimate adult delivery.', ['mature', 'female']),
  kokoro('k_british_f', 'British Female', 'bf_emma', 'Received-pronunciation English.', ['british', 'female']),
  kokoro('k_elegant_f', 'Elegant Adult Female', 'af_aoede', 'Poised and measured.', ['elegant', 'female'], 0.96),
  kokoro('k_mysterious_f', 'Mysterious Female', 'af_kore', 'Quieter, suspenseful pacing.', ['mystery', 'female'], 0.92),
  kokoro('k_calm_f', 'Calm Female', 'af_sarah', 'Even and unhurried.', ['calm', 'female'], 0.96),
  kokoro('k_energetic_f', 'Energetic Female', 'af_nova', 'Brighter, faster delivery.', ['energetic', 'female'], 1.08),
  kokoro('k_powerful_f', 'Powerful Female', 'af_alloy', 'Firm and projecting.', ['powerful', 'female']),
  kokoro('k_young_f', 'Young Adult Female', 'af_sky', 'Lighter, youthful adult tone.', ['young', 'female']),
  kokoro('k_villain_f', 'Villain Female', 'af_river', 'Cold and deliberate.', ['villain', 'female'], 0.9),
  kokoro('k_older_f', 'Older Female', 'af_jessica', 'Slower, weathered delivery.', ['older', 'female'], 0.92),
  kokoro('k_british_elegant_f', 'Elegant British Female', 'bf_isabella', 'Formal British narration.', ['british', 'female'], 0.97),
  kokoro('k_british_bright_f', 'Bright British Female', 'bf_lily', 'Lighter British tone.', ['british', 'female']),
  kokoro('k_british_warm_f', 'Warm British Female', 'bf_alice', 'Softer British tone.', ['british', 'female'], 0.97),

  kokoro('k_narrator_m', 'Male Narrator', 'am_michael', 'Balanced, readable male narration.', ['narrator', 'male']),
  kokoro('k_fantasy_m', 'Fantasy Narrator', 'am_fenrir', 'Weightier tone for fiction.', ['fantasy', 'male']),
  kokoro('k_darkfantasy_m', 'Dark Fantasy Narrator', 'am_fenrir', 'Fenrir, slowed for grim scenes.', ['fantasy', 'male'], 0.88),
  kokoro('k_young_m', 'Young Adult Male', 'am_puck', 'Lighter, youthful adult tone.', ['young', 'male']),
  kokoro('k_audiobook_m', 'Audiobook Narrator (Male)', 'am_michael', 'Steady long-form pacing.', ['narrator', 'male'], 0.97),
  kokoro('k_epic_m', 'Epic Storyteller', 'bm_fable', 'Theatrical British storytelling.', ['epic', 'male'], 0.95),
  kokoro('k_british_m', 'British Male', 'bm_george', 'Measured British narration.', ['british', 'male']),
  kokoro('k_deep_m', 'Deep Male', 'am_onyx', 'Lower register.', ['deep', 'male'], 0.95),
  kokoro('k_calm_m', 'Calm Male', 'am_echo', 'Even and unhurried.', ['calm', 'male'], 0.96),
  kokoro('k_mysterious_m', 'Mysterious Male', 'am_eric', 'Quieter, withholding delivery.', ['mystery', 'male'], 0.92),
  kokoro('k_soft_m', 'Soft Male', 'am_liam', 'Gentle male tone.', ['soft', 'male'], 0.97),
  kokoro('k_villain_m', 'Villain Male', 'bm_lewis', 'Cold, precise British menace.', ['villain', 'male'], 0.9),
  kokoro('k_documentary_m', 'Documentary Narrator', 'bm_daniel', 'Factual, level British delivery.', ['documentary', 'male'], 0.95),
  kokoro('k_powerful_m', 'Powerful Male', 'am_adam', 'Forceful delivery. Low Kokoro grade.', ['powerful', 'male']),
  kokoro('k_older_m', 'Older Male', 'am_santa', 'Warm, older male character voice.', ['older', 'male'], 0.93),
];

/**
 * Device-TTS presets.
 *
 * The system voice list differs on every OS and browser, so these carry a hint
 * string matched against available voices at runtime rather than a fixed id.
 */
function device(
  id: string,
  label: string,
  gender: 'male' | 'female',
  hint: string,
  pitch: number,
  rateBias: number,
  description: string
): VoicePreset {
  return {
    id,
    label,
    engine: 'device',
    deviceHint: hint,
    gender,
    accent: 'american',
    description,
    rateBias,
    pitch,
    tags: ['device', gender],
  };
}

export const DEVICE_PRESETS: VoicePreset[] = [
  device('d_default', 'Device Default', 'female', '', 1, 1, 'Your system’s default voice.'),
  device('d_narrator_f', 'Device Female Narrator', 'female', 'female', 1, 0.98, 'System female voice.'),
  device('d_narrator_m', 'Device Male Narrator', 'male', 'male', 0.95, 0.98, 'System male voice.'),
  device('d_deep_m', 'Device Deep Male', 'male', 'male', 0.7, 0.95, 'System male voice, lowered pitch.'),
  device('d_bright_f', 'Device Bright Female', 'female', 'female', 1.2, 1.05, 'System female voice, raised pitch.'),
  device('d_british_f', 'Device British Female', 'female', 'en-GB', 1, 0.98, 'System British voice if installed.'),
  device('d_british_m', 'Device British Male', 'male', 'en-GB', 0.95, 0.98, 'System British voice if installed.'),
];

export const ALL_PRESETS: VoicePreset[] = [...KOKORO_PRESETS, ...DEVICE_PRESETS];

export const DEFAULT_PRESET_ID = 'k_audiobook_f';

export function getPreset(id: string): VoicePreset {
  return ALL_PRESETS.find((p) => p.id === id) ?? KOKORO_PRESETS[0]!;
}

export function presetsForEngine(engine: string): VoicePreset[] {
  if (engine === 'device') return DEVICE_PRESETS;
  if (engine === 'premium') return KOKORO_PRESETS;
  return KOKORO_PRESETS;
}

/**
 * Pick the best available system voice for a device preset.
 * Falls back to the first English voice, then to whatever exists.
 */
export function matchSystemVoice(
  preset: VoicePreset,
  voices: SpeechSynthesisVoice[],
  preferredURI: string | null
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;

  if (preferredURI) {
    const exact = voices.find((v) => v.voiceURI === preferredURI);
    if (exact) return exact;
  }

  const hint = preset.deviceHint?.toLowerCase() ?? '';
  if (hint.startsWith('en-')) {
    const byLang = voices.find((v) => v.lang.toLowerCase() === hint);
    if (byLang) return byLang;
  }

  if (hint === 'female' || hint === 'male') {
    // Voice names rarely expose gender, so match on the common naming patterns
    // used by the major platforms.
    const femaleNames = /(female|samantha|victoria|karen|moira|tessa|zira|susan|fiona|anna|joana|amelie|google uk english female)/i;
    const maleNames = /(male|alex|daniel|fred|thomas|david|oliver|rishi|google uk english male)/i;
    const re = hint === 'female' ? femaleNames : maleNames;
    const match = voices.find((v) => re.test(v.name) && v.lang.startsWith('en'));
    if (match) return match;
  }

  return voices.find((v) => v.lang.startsWith('en') && v.default) ??
    voices.find((v) => v.lang.startsWith('en')) ??
    voices[0]!;
}

/** Short sample used by every preview button. */
export const PREVIEW_TEXT =
  'The lantern guttered once, then held. She turned the page and began to read aloud.';
