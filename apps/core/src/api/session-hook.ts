import type { SessionBinding, PermitCallDeps } from '../conductor/model-tools/model-tools.types.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { decidePermit } from '../policy/permit/permit.ts';

/**
 * Решение хука ядра (03 §Launcher, 06 §Session permissions): CLI перед каждым вызовом
 * инструмента зовёт `run.ts hook`, тот несёт вызов сюда. Судья тот же, что у сервера права и
 * оверлея, — `decidePermit` над сопоставлением ЭТОГО переходника и фактами копии сессии.
 * Вида шага хук не применяет (это второй замок дороги `agentdeck-permit`, см. `decidePermit`):
 * встроенные инструменты шага только для чтения снимает переходник флагами CLI.
 *
 * Каждое решение — строка `decision` класса `permit` с `road: 'hook'`: журнал показывает, какой
 * дорогой решён вызов. Разрешение с сигналом (запись вне своих путей) — `signal warn`, как у
 * сервера права.
 */

export interface HookAnswer {
  allow: boolean;
  reason: string;
}

export function answerHookCall(
  task: LiveTask,
  b: SessionBinding,
  call: { tool: string; input: Record<string, unknown> },
  deps: Pick<PermitCallDeps, 'mapPermission' | 'context'>,
): HookAnswer {
  const ask = deps.mapPermission(call);
  const decision = decidePermit(ask, deps.context);
  const decided = task.append({
    kind: 'decision',
    actor: 'core',
    stepId: b.stepId,
    sessionId: b.sessionId,
    data: {
      decisionId: newId(),
      class: 'permit',
      inputs: [],
      facts: [],
      numbers: {},
      reasons: [decision.reason],
      output: {
        ...decision,
        action: ask.action,
        target: ask.target,
        tool: ask.tool,
        road: 'hook',
      },
    },
  });
  if (decision.allow && decision.signal) {
    task.append({
      kind: 'signal',
      actor: 'core',
      stepId: b.stepId,
      sessionId: b.sessionId,
      cause: decided.seq,
      data: {
        signal: decision.signal,
        severity: 'warn',
        subject: ask.target,
        detail: decision.reason,
      },
    });
  }
  return { allow: decision.allow, reason: decision.reason };
}
