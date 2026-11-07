import type { StubTask } from '../stub-tasks.types.ts';

/**
 * Задачи-заглушки зоны H этапа 11. Файл зоны: зона дописывает только его, каталог
 * `STUB_TASKS` подхватывает сам. Пусто намеренно: места сеансов машины видны только на двух
 * процессах ядра с настоящими хостами сеансов — их держит
 * `bootstrap/allocator-wiring/allocator.integration.test.ts`; задача-заглушка в одном процессе их не даёт.
 */
export const STAGE11_H: readonly StubTask[] = [];
