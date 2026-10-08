import type { PendingPermission, StreamedTool } from './agent-runs.types';
import type { RunStatus } from './status.types';

/**
 * Чистые выборки поверх прогонов — для пульта агентов и суммарной стоимости.
 * Работают со структурной формой прогона (не завязаны на класс стора), поэтому
 * легко тестируются отдельно.
 */

export interface RunLike {
  id: string;
  sessionId?: string;
  projectPath?: string;
  status: RunStatus;
  lastEventAt: number;
  costUsd?: number;
  tokens?: number;
  /** Чем ведётся прогон: имя называет сам CLI первым событием сессии. */
  model?: string;
  /** Запросы прав, ждущие ответа — влияют на статус (жёлтая точка). */
  permissions?: PendingPermission[];
  /** Вызовы этого хода: среди них и вопрос человеку. */
  tools?: StreamedTool[];
}
