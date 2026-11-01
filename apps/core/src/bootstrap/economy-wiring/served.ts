import { registryId } from '@agentdeck/contracts/core/ids';
import type { AdapterEvent } from '../../adapters/index.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import { MODEL_SERVED_SIGNAL } from '../../journal/reduce/stage4.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { signalDef } from '../../observer/catalog.ts';
import { judgeSignal } from '../../observer/judge.ts';
import { routeMismatchVerdict } from '../../observer/route-mismatch.ts';
import { writeObserverDecision } from '../observer-wiring/write.ts';

type UsageEvent = Extract<AdapterEvent, { type: 'usage' }>;

/**
 * Модель, которую назвал маршрут (P119): первый ход сеанса (не подагента) с именем модели в потоке
 * — строка `signal model-served`, свёртка кладёт её в `sessions[id].modelServed`. Модель из `init`
 * не годится: это то, что CLI велели (`--model`/переменная модели), а не то, что ответил вендор.
 * Потом суд наблюдателя: назвал не то, что просили, — вердикт предиката через `judgeSignal` и
 * каталог → `decision` класса `observer` и сигнал `route-mismatch` с действием и `cause`. Повтор
 * того же хода и следующие ходы ничего не пишут: первое имя побеждает.
 * `true` — строка `model-served` записана.
 */
export function journalServed(task: LiveTask, binding: SessionBinding, event: UsageEvent): boolean {
  if (event.subagent === true || !event.model || !registryId.safeParse(event.model).success)
    return false;
  const session = Object.hasOwn(task.state.sessions, binding.sessionId)
    ? task.state.sessions[binding.sessionId]
    : undefined;
  if (!session || session.modelServed !== null) return false;
  const served = event.model;
  const seq = task.append({
    kind: 'signal',
    actor: 'core',
    sessionId: binding.sessionId,
    stepId: binding.stepId,
    data: {
      signal: MODEL_SERVED_SIGNAL,
      severity: 'info',
      subject: served,
      detail: `asked ${session.modelAsked ?? 'CLI default'} on ${session.route.id}`,
    },
  }).seq;
  const verdict = routeMismatchVerdict({
    sessionId: binding.sessionId,
    routeId: session.route.id,
    modelAsked: session.modelAsked,
    modelServed: served,
  });
  const def = signalDef(verdict.signal);
  if (!verdict.fired || !def) return true;
  const where = { sessionId: binding.sessionId, stepId: binding.stepId, inputs: [seq] };
  writeObserverDecision(task, verdict, judgeSignal(verdict, def), where);
  return true;
}
