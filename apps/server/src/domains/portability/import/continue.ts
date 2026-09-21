import { readUniversalSections } from '../sections.ts';
import type { Importer } from '../types.ts';

/**
 * Continue → канон.
 *
 * Инструкции — каталог правил `.md`; права — три списка (`allow`, `ask`,
 * `exclude`), где `exclude` означает «инструмент недоступен вовсе» и в каноне
 * становится `deny`: понижение идёт ТОЛЬКО в сторону строгости (инвариант 6).
 * Глобального файла инструкций у Continue не задокументировано — раздел уходит
 * пропуском, а не выдуманным путём.
 */
export const importContinueEnvironment: Importer = (deps) => readUniversalSections(deps);
