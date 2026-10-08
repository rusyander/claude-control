import type { Group } from '@agentdeck/contracts';

export interface GroupPathProps {
  /**
   * Группа целиком: область и состав нужны строкам (откуда скилл, где его
   * файл), `flow` — виду конструктора, остальное — составителю, когда шаг
   * сценария добавляет участника.
   */
  group: Group;
  /** Только что созданный сценарий: составитель первого шага открыт сразу. */
  startComposer?: boolean;
}
