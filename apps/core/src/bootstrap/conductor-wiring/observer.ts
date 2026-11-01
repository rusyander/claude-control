import { PLATFORM_MARKER } from '@agentdeck/contracts/core/user-layer';
import type { SessionHint } from '../../journal/reduce/reduce.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { signalDef } from '../../observer/catalog.ts';
import type { ConductorHooks, Outgoing } from '../../conductor/run/run.types.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';

/**
 * Зона наблюдателя этапа 8 в дирижёре: пакет подсказок на конце хода (зона W, F8) и вопрос о
 * парковке (зона I). Место в `ZONE_ORDER` — после слоя пользователя: его отказ хука уже остановил
 * шаг, подсказка такому шагу не нужна.
 *
 * Подсказки копит свёртка задачи (`sessions[sid].hints` — строки `signal{action:'hint'}`); на конце
 * хода они уходят ОДНИМ сообщением с меткой платформы, текст — из каталога (английский, по фактам
 * сигнала, без прозы модели). Ссылка доставки — decisionId последней: строка `message.delivered`
 * снимает её и все прежние, поэтому ядро, перезапущенное после доставки, второй раз их не шлёт.
 * Ход, сдавший `step_done`, подсказку не получает: она завела бы ход у сданной работы.
 */

export const HINT_HEAD =
  'Platform observer notes (facts from your own tool calls in this session):';

export function hintLine(h: SessionHint): string {
  const text = signalDef(h.signal)?.hint?.({ subject: h.subject, detail: h.detail });
  return text ?? `${h.signal}: ${h.subject} — ${h.detail}`;
}

/** Одно сообщение на все подсказки сессии; одинаковые строки — один раз. */
export function hintBatch(hints: readonly SessionHint[]): Outgoing | null {
  const last = hints.at(-1);
  if (!last) return null;
  const lines = [...new Set(hints.map(hintLine))];
  return {
    text: `${PLATFORM_MARKER}\n${HINT_HEAD}\n${lines.map((l) => `- ${l}`).join('\n')}`,
    ref: { kind: 'hint', id: last.decisionId },
  };
}

export function pendingHints(task: LiveTask, sessionId: string | null): Outgoing[] {
  if (sessionId === null) return [];
  const batch = hintBatch(task.state.sessions[sessionId]?.hints ?? []);
  return batch ? [batch] : [];
}

/** Из зависимостей проводки зона читает только реестр задач. */
export function observerHooks(deps: Pick<ConductorWiringDeps, 'registry'>): ConductorHooks {
  return {
    async onTurnEnd(s, turn) {
      const task = deps.registry.live(s.taskId);
      if (!task || turn.hadStepDone) return { send: [] };
      return { send: pendingHints(task, s.sessionId) };
    },
  };
}
