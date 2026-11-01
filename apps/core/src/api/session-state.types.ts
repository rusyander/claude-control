import type { SessionStateDoc } from '@agentdeck/contracts/core/user-layer';
import type { SessionBinding } from '../conductor/model-tools/model-tools.types.ts';
import type { LiveTask } from '../journal/resume.ts';

/**
 * Порт `GET /v1/session/state` — то, что печатает `agentdeck state` автору хука (03:81-82, G8):
 * ядро — источник правды, снимок запуска — запасной путь самой команды. Сессию называет токен,
 * задачу и шаг — журнал. Реализует зона состояния (`bootstrap/session-state.ts`); нет порта — 501.
 */
export interface SessionStatePort {
  read(task: LiveTask, binding: SessionBinding): { value: SessionStateDoc } | { unknown: string };
}
