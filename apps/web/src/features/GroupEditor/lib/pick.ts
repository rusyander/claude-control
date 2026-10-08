import type { LocalizedLine } from '@agentdeck/contracts';

export function pick(line: LocalizedLine | undefined, language: string): string {
  if (!line) return '';
  const isEn = language.startsWith('en');
  const own = isEn ? line.en : line.ru;
  const other = isEn ? line.ru : line.en;
  return own.trim() || other.trim();
}
