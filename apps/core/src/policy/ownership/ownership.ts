import { matchesAny, toSlashes } from '../../lib/glob/glob.ts';
import type { OwnershipDecision } from './ownership.types.ts';

/**
 * Владение единицы (06:64, 02:74, R:S2-08d) — один судья: изменённые файлы (дифф единицы от её
 * базы) против своих путей из `unit.created`. Свои пути — от корня копии (`rooted`): `src`
 * значит `<копия>/src`, не чужой `pkg/src`. Вне своих путей — `outside` с файлами: дирижёр пишет
 * `signal ownership`, следующий бриф их называет. Правку не откатывает и шаг не стопорит:
 * соседний файл часто правится, потому что иначе не собирается (панель, split-overlap).
 */

/** Сколько файлов называть в брифе: дальше — число, бриф не раздувается чужим списком. */
const BRIEF_FILES_MAX = 20;

export function decideOwnership(
  owned: readonly string[],
  changed: readonly string[],
  foldCase = false,
): OwnershipDecision {
  const outside = changed.filter((f) => !matchesAny(toSlashes(f), owned, foldCase, 'rooted'));
  if (outside.length === 0)
    return {
      verdict: 'inside',
      outside: [],
      reasons: [`${changed.length} changed files inside owned paths`],
    };
  return {
    verdict: 'outside',
    outside,
    reasons: [`${outside.length} of ${changed.length} changed files outside owned paths`],
  };
}

/**
 * Текст раздела брифа «владение»: свои пути единицы и, если были, файлы вне них. Владение
 * живёт в `policy`, бриф — у дирижёра: здесь только текст, раздел собирает обвязка зоны.
 */
export function ownershipBrief(owned: readonly string[], outside: readonly string[]): string {
  const lines = [`Owned paths of this unit: ${owned.join(', ')}.`];
  if (outside.length > 0) {
    const shown = outside.slice(0, BRIEF_FILES_MAX);
    const more = outside.length - shown.length;
    lines.push(
      `Edited outside owned paths: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}.`,
      'Keep further edits inside owned paths; another unit may own these files.',
    );
  }
  return lines.join('\n');
}
