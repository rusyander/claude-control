import { ActionFailed, runAction } from '../../conductor/outbox.ts';
import type { StepCtx } from '../../conductor/run/run.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { OutboxPort } from '../../publisher/push/push.types.ts';

/**
 * Порт outbox для частей публикатора поверх `conductor/outbox.runAction`: `action.started` с
 * fsync до эффекта; отказ эффекта — `ActionFailed(code)` → `action.failed` (повтор возможен);
 * исключение эффекта — `effect-threw`. Части дирижёра не импортируют (00 §Parts).
 */
export function outboxPort(
  task: LiveTask,
  s: Partial<Pick<StepCtx, 'unitId' | 'stepId'>> = {},
): OutboxPort {
  const scope = {
    ...(s.unitId ? { unitId: s.unitId } : {}),
    ...(s.stepId ? { stepId: s.stepId } : {}),
  };
  return {
    async run(spec, effect) {
      const got = await runAction(
        task,
        spec,
        async () => {
          const res = await effect();
          if (!res.ok) throw new ActionFailed(res.code, res.detail);
          return res.result;
        },
        scope,
      );
      return got.ok
        ? { ok: true, actionId: got.actionId, result: got.result }
        : { ok: false, actionId: got.actionId, code: got.code };
    },
  };
}
