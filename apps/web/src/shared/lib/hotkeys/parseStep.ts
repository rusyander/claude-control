import type { KeyStep } from './hotkeys.types';

/** Модификаторы, которые сворачиваем в общий признак `mod` (Ctrl или Cmd). */
export const MOD_TOKENS = new Set(['mod', 'ctrl', 'control', 'cmd', 'meta', 'command']);

/**
 * Разбирает один шаг аккорда: `mod+k` → `{ key: 'k', mod: true }`, `g` →
 * `{ key: 'g', mod: false }`. Регистр букв не важен, лишние пробелы вокруг `+`
 * отбрасываются. Пустой или бессмысленный шаг (только модификатор) даёт `null`.
 */
export function parseStep(raw: string): KeyStep | null {
  const parts = raw
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;

  let mod = false;
  let key: string | null = null;

  for (const part of parts) {
    if (MOD_TOKENS.has(part)) mod = true;
    else key = part;
  }

  // Шаг без собственной клавиши (например, «mod» без буквы) невалиден.
  if (!key) return null;
  return { key, mod };
}
