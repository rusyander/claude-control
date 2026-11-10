import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { answerKey, switchAnswerOf } from './answers.ts';
import type { Attempt, NextAction } from './next.types.ts';
import { END_REASON } from './next.types.ts';

/**
 * Ответ на вопрос потерянного входа (этап 12, P170). Вопрос блокирует, и ответ сам отпускает шаг
 * в работу (`answer` → running), поэтому ответ читает не ожидание человека, а сам шаг без живой
 * сессии: «остановить» — шаг кончается; `model:`/`cli:` — правка задачи кликом (основание — id
 * вопроса, вариант сверяет исполнитель по строке вопроса); «вошёл заново» — ничего, шаг идёт
 * новой сессией тем же маршрутом. Правка этого поля после потери входа (сам ответ или поздний
 * клик человека) значит, что ответ уже применён: второй раз он чужой выбор не перепишет.
 */
export function loginAnswerAction(state: TaskFoldState, att: Attempt): NextAction | null {
  const lost = state.loginLost?.[att.stepId];
  if (!lost) return null;
  const asks = Object.entries(state.asks).filter(
    ([, a]) => a.source === 'login' && a.stepId === att.stepId,
  );
  const last = asks.at(-1);
  if (!last || last[1].answer === undefined) return null;
  const [askId, ask] = last;
  if (answerKey('login', ask.answer) === 'stop')
    return {
      kind: 'stop-step',
      stepId: att.stepId,
      reason: `${END_REASON.stopped}: login lost, human stop`,
    };
  const override = switchAnswerOf(ask.answer);
  if (!override) return null;
  const applied = state.overrides.some(
    (o) => o.seq > lost.seq && o.scope === 'task' && o.field === override.field,
  );
  if (applied) return null;
  return { kind: 'answered', stepId: att.stepId, askId, override };
}
