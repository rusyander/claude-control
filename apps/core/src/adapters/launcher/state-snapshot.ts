import { SESSION_STATE_V, type SessionStateDoc } from '@agentdeck/contracts/core/user-layer';
import type { CoreSessionVars } from './launcher.types.ts';

/**
 * Снимок `agentdeck state` в `state.json` сессии (G8): запасной путь команды, когда ядро
 * недоступно. Документ дороги ложится ЦЕЛИКОМ, с `source: 'snapshot'` — поля запуска поверх него
 * не кладутся (прежний `{task, step, stepKind, ...state}` давал объект шага вместо id или id
 * вместо объекта, смотря кто последний). Документа нет или он о другой задаче/шаге — снимок
 * неполный, с причиной: автор хука видит, чего нет, а не пустые требования и бюджеты.
 * Токен сессии сюда не попадает никогда: он в окружении CLI, не в файле.
 */

export interface IncompleteSnapshot {
  v: typeof SESSION_STATE_V;
  source: 'snapshot';
  task: string;
  step: { id: string; kind: string };
  /** Почему документа нет. */
  incomplete: string;
}

export type SessionStateSnapshot = SessionStateDoc | IncompleteSnapshot;

export function stateSnapshot(core: CoreSessionVars): SessionStateSnapshot {
  const incomplete = (why: string): IncompleteSnapshot => ({
    v: SESSION_STATE_V,
    source: 'snapshot',
    task: core.taskId,
    step: { id: core.stepId, kind: core.stepKind },
    incomplete: why,
  });
  const doc = core.state;
  if (!doc) return incomplete('state document not supplied at launch');
  if (doc.task !== core.taskId || doc.step.id !== core.stepId)
    return incomplete(
      `state document names ${doc.task}/${doc.step.id}, the session runs ${core.taskId}/${core.stepId}`,
    );
  return { ...doc, source: 'snapshot' };
}
