import { type PathEntry, type PathStep } from '@agentdeck/contracts';

/**
 * Правка своих шагов пути на клиенте. Сервер хранит только свои шаги — у каждого
 * стадия, ПОСЛЕ которой он идёт (`anchor`), и место внутри неё (`order`); общий
 * порядок строк собирает он же. Здесь — только перевод жестов человека («+»
 * между двумя строками, «выше», «ниже», «убрать») в новый список своих шагов,
 * который уходит одним PUT.
 */

/** Свои шаги в том порядке, в каком их показывает путь. */
export function customSteps(entries: PathEntry[]): PathStep[] {
  return entries.flatMap((entry) => (entry.kind === 'custom' ? [entry.step] : []));
}
