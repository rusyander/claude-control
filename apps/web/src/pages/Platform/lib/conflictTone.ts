import type { PlatformConflictLevel } from '@agentdeck/contracts';

/** Цвет строки конфликта. Взаимное исключение — единственное красное. */
export function conflictTone(level: PlatformConflictLevel): 'danger' | 'warning' | 'info' {
  if (level === 'exclusive') return 'danger';
  return level === 'warning' ? 'warning' : 'info';
}
