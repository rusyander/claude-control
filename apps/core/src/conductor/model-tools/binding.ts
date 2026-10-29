import type { LiveTask } from '../../journal/resume.ts';
import type { SessionBinding } from './model-tools.types.ts';

/**
 * Чья это сессия — только по журналу (F05): `session.started` даёт шаг, `step.started` — вид
 * шага и единицу. Токен называет задачу и сессию; закончившаяся или потерянная сессия
 * инструментов модели больше не получает.
 */

export type BindingOutcome =
  | { binding: SessionBinding }
  | { refused: 'no-session' | 'session-ended' | 'no-step'; reason: string };

export function bindingOf(task: LiveTask, sessionId: string): BindingOutcome {
  const session = task.state.sessions[sessionId];
  if (!session) return { refused: 'no-session', reason: 'session not in the task journal' };
  if (session.state === 'ended' || session.state === 'lost') {
    return { refused: 'session-ended', reason: `session is ${session.state}` };
  }
  const step = task.state.steps[session.stepId];
  if (!step) return { refused: 'no-step', reason: 'step of the session not in the journal' };
  return {
    binding: {
      taskId: task.taskId,
      sessionId,
      stepId: session.stepId,
      unitId: step.unitId,
      stepKind: step.stepKind,
    },
  };
}
