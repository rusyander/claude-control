import type { StubTask } from '../stub-tasks.types.ts';

/**
 * Задачи-заглушки зоны N этапа 11. Файл зоны: зона дописывает только его, каталог
 * `STUB_TASKS` подхватывает сам. Пусто намеренно: группа (N задач с одним `groupId`), дочерние
 * задачи XL, запасной путь «по одному» и единица интеграции судятся над несколькими задачами,
 * единицами и местами сеансов, а не над ходами CLI одного шага — одношаговая заглушка их не
 * выражает. Их настоящий путь гоняют `conductor/split/group-xl.integration.test.ts` (ручка
 * оценки и запуск деления), `conductor/split/fallback-serial.test.ts` (исполнитель на одном и
 * двух местах), `conductor/copy/copy-integration.integration.test.ts` (копия на настоящем git),
 * `conductor/gates/integrated.test.ts` (ворота публикации у судьи `next`) и
 * `conductor/gates/integration-publish.integration.test.ts` (конфликт интеграции решается в задаче,
 * затем MR единиц через заглушку форжа).
 */
export const STAGE11_N: readonly StubTask[] = [];
