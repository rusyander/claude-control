import type { StubTask } from '../stub-tasks.types.ts';

/**
 * Задачи-заглушки зоны C этапа 7 (настройка ядра). Пусто намеренно: у `StubTask` нет пробы этапа
 * 7, а обе пробы зоны идут мимо сессии модели — их исполняют тесты настоящих дорог:
 * `bootstrap/core-config/port.test.ts` (токен сессии на `POST /v1/config` — `forged-authority`,
 * ни байта в файле) и `bootstrap/session-road/permit-sources.test.ts` «stage7-c G6» (правка
 * `config.json` мимо API не меняет решение права). Каталог `STUB_TASKS` подхватывает сам.
 */
export const STAGE7_C: readonly StubTask[] = [];
