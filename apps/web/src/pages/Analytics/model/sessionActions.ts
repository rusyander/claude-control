import type { SessionLocation } from '@agentdeck/contracts';

/**
 * Решения кнопок «Перейти» и «Остановить» у строки «Сессий» — отдельно от
 * разметки, чтобы каждое было проверено тестом, а не глазами.
 */

/** «Перейти»: чат панели и завершённая сессия — в разговор; процесс вне панели — окно «где идёт». */
export type GoPlan = { kind: 'chat'; id: string } | { kind: 'where' };

export function goPlan(location: SessionLocation): GoPlan {
  const { where } = location;
  if (where.kind === 'panel') return { kind: 'chat', id: where.chatId };
  // Завершённая сессия продолжается из её разговора; идущая вне панели — нет:
  // второй писатель в тот же транскрипт перемешал бы ходы двух процессов.
  if (where.kind === 'finished') return { kind: 'chat', id: location.sessionId };
  return { kind: 'where' };
}

// Сравнение путей — одно на весь фронт, живёт в shared.
export { samePath } from '../../../shared/lib/samePath';
