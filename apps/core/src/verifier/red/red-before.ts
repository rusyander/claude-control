import type { CheckRecord, RedBeforeResult } from '@agentdeck/contracts/core/records';
import { sameTest } from './test-path.ts';

/**
 * Ворота «красный до» для исправления бага (04:68-71, R:S2-14, P94). Красный на базе засчитан только
 * когда НАЗВАННЫЙ тест упал на своём утверждении — его имя есть в разобранном `failing`. Ошибка
 * сборки или импорта (файл не собрался, имён нет) — `no-verdict-engine`, ворота открыты: такой
 * «красный» ловит опечатку, а не баг. Зелёный на базе — тест бага не ловит, шаг исправления теста.
 */

/**
 * Тест назван списком: полный путь «a > b > it» — целиком (хвост « > it» засчитал бы чужой
 * старый красный с тем же листом), файл — когда известен с обеих сторон.
 */
const inList = (list: CheckRecord['failing'], test: string, file: string | undefined): boolean =>
  list.some((t) => sameTest(t, { name: test, ...(file !== undefined ? { file } : {}) }));

/**
 * Зелёный финал доказывает «зелёный после», только если тест в нём был: раннер, что называет
 * прошедших, обязан назвать и этот (выборка без якоря могла прогнать другой тест). Раннер, что
 * прошедших не называет, — довод прежний: узкий зелёный без единого теста отсекает прогон (P50).
 */
function greenAfter(final: CheckRecord, test: string, file: string | undefined): boolean {
  if (final.verdict.kind !== 'pass') return false;
  return final.passing === undefined || inList(final.passing, test, file);
}

export function decideRedBefore(
  test: string,
  base: CheckRecord,
  final: CheckRecord,
  file?: string,
): RedBeforeResult {
  const out = (outcome: RedBeforeResult['outcome']): RedBeforeResult => ({
    test,
    base: base.id,
    final: final.id,
    outcome,
  });
  if (base.verdict.kind === 'pass') return out('green-on-base');
  if (
    base.verdict.kind !== 'fail' ||
    base.verdict.reason !== 'red' ||
    !inList(base.failing, test, file)
  )
    return out('no-verdict-engine');
  if (greenAfter(final, test, file)) return out('proven');
  if (final.verdict.kind === 'fail' && inList(final.failing, test, file)) return out('red-after');
  // Финал без вердикта или красный не этим тестом — доказательства «зелёный после» нет.
  return out('no-verdict-engine');
}
