import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import { registryId } from '@agentdeck/contracts/core/ids';
import type { AdapterEvent } from '../../adapters/index.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import type { LiveTask } from '../../journal/resume.ts';

/**
 * Расход хода в журнал (план s5 зона L, P43): каждое событие `usage` переходника — строка
 * `turn.usage` с маршрутом сессии и моделью хода. Строка ЗАМЕНЯЕТ прежнюю того же `messageId`
 * в свёртке; одинаковый повтор (хост сессии отдал поток заново после переподключения) не пишется
 * вовсе — каждый API-ход в журнале один раз.
 */

type UsageEvent = Extract<AdapterEvent, { type: 'usage' }>;
type Row = JournalDataV1['turn.usage'];

/** Модель хода: имя потока, если оно годно реестру; иначе модель сеанса; иначе `unknown`. */
function modelOf(event: UsageEvent, served: string | null, asked: string | null): string {
  for (const name of [event.model, served, asked]) {
    if (name && registryId.safeParse(name).success) return name;
  }
  return 'unknown';
}

// Ключи обеих строк: поле, появившееся только в новой (окно сессии), — уже не повтор.
const same = (a: Row, b: Row): boolean =>
  ([...new Set([...Object.keys(a), ...Object.keys(b)])] as (keyof Row)[]).every(
    (k) => a[k] === b[k],
  );

export function usageRow(task: LiveTask, binding: SessionBinding, event: UsageEvent): Row | null {
  const session = Object.hasOwn(task.state.sessions, binding.sessionId)
    ? task.state.sessions[binding.sessionId]
    : undefined;
  if (!session) return null;
  const subagent = event.subagent === true;
  return {
    sessionId: binding.sessionId,
    messageId: event.messageId,
    input: event.input,
    cacheRead: event.cacheRead,
    cacheWrite: event.cacheWrite,
    // Доля не больше целого: поток пишет не ядро, рассогласование полей не даёт лишних денег.
    cacheWrite1h: Math.min(event.cacheWrite1h ?? 0, event.cacheWrite),
    output: event.output,
    routeId: session.route.id,
    model: modelOf(event, session.modelServed, session.modelAsked),
    subagent,
    // Подагент своей сессии ядра не имеет: родитель — сессия, чей CLI его запустил.
    parentSessionId: subagent ? binding.sessionId : null,
    remainder: event.remainder === true,
    ...(event.contextWindow !== undefined &&
    Number.isInteger(event.contextWindow) &&
    event.contextWindow > 0
      ? { contextWindow: event.contextWindow }
      : {}),
  };
}

/** `true` — строка записана; `false` — повтор без изменений или сессии нет в свёртке. */
export function journalUsage(task: LiveTask, binding: SessionBinding, event: UsageEvent): boolean {
  const fresh = usageRow(task, binding, event);
  if (!fresh) return false;
  const key = `${fresh.sessionId}|${fresh.messageId}`;
  const prior = Object.hasOwn(task.state.usage.lastByMessage, key)
    ? task.state.usage.lastByMessage[key]
    : undefined;
  // Ход без своего имени модели берёт модель сеанса, а она меняется (`modelServed` складывается
  // после первого хода): у повтора того же сообщения модель — прежней строки, иначе
  // переподключённый поток писал бы каждый ход второй раз.
  const ownModel = Boolean(event.model && registryId.safeParse(event.model).success);
  const row = prior && !ownModel ? { ...fresh, model: prior.model } : fresh;
  if (prior && same(prior, row)) return false;
  const adapter = task.state.sessions[binding.sessionId]!.adapter;
  task.append({
    kind: 'turn.usage',
    actor: `adapter:${adapter}`,
    sessionId: binding.sessionId,
    stepId: binding.stepId,
    data: row,
  });
  return true;
}
