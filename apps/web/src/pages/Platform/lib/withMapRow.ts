import type { Platform } from '@agentdeck/contracts';

/**
 * Записать строку карты. Пустое имя слева не сохраняется вовсе: ключ, которого
 * не бывает, тихо переводил бы ничто во что-то.
 *
 * Ключ, отличающийся только регистром, ЗАМЕНЯЕТСЯ: перевод ищется
 * регистронезависимо и берёт первое совпадение, поэтому строки «sonnet» и
 * «Sonnet» выглядели бы двумя настройками, а действовала бы одна — и какая,
 * видно не было.
 */
export function withMapRow(platform: Platform, from: string, to: string): Platform {
  const key = from.trim();
  if (!key) return platform;
  const next = { ...platform.modelMap };
  for (const existing of Object.keys(next)) {
    if (existing.toLowerCase() === key.toLowerCase()) delete next[existing];
  }
  next[key] = to.trim();
  return { ...platform, modelMap: next };
}
