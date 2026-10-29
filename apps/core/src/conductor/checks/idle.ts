import type {
  CheckAnswer,
  CheckRegistry,
  CheckRequest,
  RequiredAt,
} from '@agentdeck/contracts/core/records';
import type { CheckQueue } from '../../verifier/queue/queue.ts';
import type { CheckService } from './request.ts';

/**
 * Ранние прогоны в простое (04:58, R:S2-30, P101): свободный слот и никого выше фонового класса
 * в очереди — ядро гонит проверки законченных единиц заранее, классом `background` и фазой
 * `final`, тем же входом `requestCheck`. Ключ не знает, кто и когда гнал: итоговая композиция на
 * том же дереве получает повтор записи, а не второй прогон. Тронули единицу после — ключ другой,
 * итог гонит заново (повтор старого исхода невозможен по построению).
 */

export interface PreRunScope {
  taskId: string;
  project: string;
  copyDir: string;
  /** Единицы, чья работа закончена (их шаги сданы). */
  finishedUnits: string[];
  /** Какие проверки гнать: по умолчанию обязательные к публикации или сдаче. */
  requiredAt?: RequiredAt;
  /**
   * Работа задачи закончена целиком: только тогда гонятся проверки уровня проекта (ключ — всё
   * дерево; прогон раньше сгорел бы на первой же правке).
   */
  allFinished?: boolean;
}

export function preRunCandidates(registry: CheckRegistry, scope: PreRunScope): CheckRequest[] {
  // По умолчанию — тот же набор, что требует итог (`compose`: publish | deliver): иначе проверки
  // только к сдаче никогда не гонялись бы заранее.
  const wanted: RequiredAt[] = scope.requiredAt ? [scope.requiredAt] : ['publish', 'deliver'];
  const out: CheckRequest[] = [];
  const ask = (checkId: string, unit: string): void => {
    out.push({
      road: 'idle-prerun',
      origin: 'core',
      taskId: scope.taskId,
      stepId: null,
      project: scope.project,
      copyDir: scope.copyDir,
      class: 'background',
      phase: 'final',
      checkId,
      unit,
      changedUnits: [],
      exec: 'core',
    });
  };
  const required = registry.checks.filter((e) => e.requiredAt.some((at) => wanted.includes(at)));
  for (const unit of [...scope.finishedUnits].sort()) {
    if (!registry.units[unit]) continue;
    for (const entry of required) if (entry.unit === 'package') ask(entry.id, unit);
  }
  if (scope.allFinished)
    for (const entry of required) if (entry.unit !== 'package') ask(entry.id, '.');
  return out;
}

export interface PreRunOutcome {
  answers: { req: CheckRequest; answer: CheckAnswer }[];
  /** Почему остановились раньше списка: слот занят или очередь не прочиталась. */
  stopped?: string;
}

/**
 * Один проход простоя: перед каждым кандидатом очередь спрашивается заново — пришла работа
 * выше фона, и ранний прогон уступает ей (класс `background` всё равно встал бы последним).
 */
export async function idlePreRun(
  service: Pick<CheckService, 'requestCheck'>,
  queue: Pick<CheckQueue, 'idle'>,
  candidates: readonly CheckRequest[],
): Promise<PreRunOutcome> {
  const answers: PreRunOutcome['answers'] = [];
  for (const req of candidates) {
    const idle = await queue.idle();
    if (!('value' in idle))
      return {
        answers,
        stopped: `queue unreadable: ${'unknown' in idle ? idle.unknown : 'absent'}`,
      };
    if (!idle.value)
      return { answers, stopped: 'queue busy: a slot is taken or higher work waits' };
    answers.push({ req, answer: await service.requestCheck(req) });
  }
  return { answers };
}
