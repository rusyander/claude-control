import type { Group } from '@agentdeck/contracts';

/**
 * Прежняя группа так, как её отдаёт `GET /api/groups` — только для чтения (этап 10, F1): сетка
 * «Прежние группы» показывает её и переводит «Путь» в сценарий ядра; править её больше нечем.
 */
export interface GroupListItem extends Group {
  /** Проекты, чьи привязки, выбор или файлы ссылаются на группу. */
  usedIn?: string[];
}
