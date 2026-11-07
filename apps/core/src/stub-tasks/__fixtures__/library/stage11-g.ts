import type { StubTask } from '../stub-tasks.types.ts';

/**
 * Задачи-заглушки зоны G этапа 11. Файл зоны: зона дописывает только его, каталог
 * `STUB_TASKS` подхватывает сам. Пусто намеренно: контракт плана ведущего, эскалация ступени и
 * подъём по обучению судятся над несколькими задачами и крючками дирижёра, а не над ходами CLI
 * одной задачи — их настоящий путь гоняют `conductor/split/plan-contract.integration.test.ts`,
 * `conductor/run/run.escalation.test.ts` и `conductor/run/run.learned-promotion.test.ts`
 * (настоящие дирижёр, журнал, `readLearned` и суд `tier`; подделаны сессия модели и вердикт).
 */
export const STAGE11_G: readonly StubTask[] = [];
