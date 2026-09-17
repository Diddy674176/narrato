import type { PronunciationRule } from '../types';

/**
 * Pronunciation rules.
 *
 * Rules rewrite the text sent to the voice engine only. The reader still shows
 * the author's original spelling, so "Kael" stays "Kael" on screen while the
 * narrator says "Kay el".
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CompiledRule {
  re: RegExp;
  to: string;
}

/**
 * Compile rules once per playback session rather than per chunk - a book with
 * 40 fantasy names would otherwise rebuild 40 regexes for every chunk.
 */
export function compileRules(rules: PronunciationRule[]): CompiledRule[] {
  return rules
    .filter((r) => r.from.trim() !== '')
    // Longest first, so "Kael Ardyn" wins over "Kael".
    .slice()
    .sort((a, b) => b.from.length - a.from.length)
    .map((rule) => {
      const body = escapeRegExp(rule.from.trim());
      // \b does not work next to non-word characters, so only apply word
      // boundaries when the term actually starts/ends with a word character.
      const left = rule.wholeWord && /^\w/.test(rule.from.trim()) ? '\\b' : '';
      const right = rule.wholeWord && /\w$/.test(rule.from.trim()) ? '\\b' : '';
      const flags = rule.matchCase ? 'g' : 'gi';
      return { re: new RegExp(`${left}${body}${right}`, flags), to: rule.to };
    });
}

export function applyRules(text: string, compiled: CompiledRule[]): string {
  let out = text;
  for (const rule of compiled) {
    // Escape "$" in the replacement so a pronunciation like "US$" cannot be
    // interpreted as a capture-group reference.
    out = out.replace(rule.re, rule.to.replace(/\$/g, '$$$$'));
  }
  return out;
}

/** Rules that apply to a document: its own rules plus all global rules. */
export function rulesForDoc(all: PronunciationRule[], docId: string): PronunciationRule[] {
  return all.filter((r) => r.docId === null || r.docId === docId);
}
