import { PERMIT_MCP_SERVER, PERMIT_TOOL } from '@agentdeck/contracts/core/model-tools';
import type { AdapterEvent, CliAdapter, SessionHandle, TurnCause } from '../adapters/index.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { answerPermitCall } from '../conductor/model-tools/permit-call.ts';
import type { PermitCallDeps, SessionBinding } from '../conductor/model-tools/model-tools.types.ts';
import type { LiveTask } from '../journal/resume.ts';
import { createPendingPermits, type PendingPermits } from '../policy/permit/pending.ts';
import type { PermitContext } from '../policy/permit/permit.types.ts';
import type { EconomyTap } from './economy-wiring/index.ts';
import type { ObserverTap } from './observer-wiring/observer-wiring.types.ts';

/**
 * Живые сессии ядра и их дорога права (03 §CLI adapter, 06 §Session permissions). Запущенная
 * сессия ПРИКРЕПЛЯЕТСЯ сюда: рантайм — единственный читатель потока переходника (буфер потока
 * один), каждое событие видит ворот права (`tool.requested` без `tool.result` — законный вопрос),
 * затем — подписчик. Вопрос о праве решает ядро, обеими дорогами одинаково:
 * - инструментом сервера права (`POST /v1/session/permit`): `permitDeps` даёт кодек и сопоставление
 *   ИМЕННО этого переходника; неприкреплённая или кончившаяся сессия — `undefined` → 503 (fail-closed);
 * - строкой протокола (`permit.request`): тот же `answerPermitCall`, ответ — `adapter.answerPermit`.
 *   Не ждём в цикле потока: запрос инструмента может прийти в потоке ПОСЛЕ вопроса, а ворот ждёт его.
 */

export const PERMIT_SELF_TOOL = `mcp__${PERMIT_MCP_SERVER}__${PERMIT_TOOL}`;

/** Сколько ждать, пока поток сессии покажет запрос инструмента, о котором спрашивают. */
export const PERMIT_SETTLE_MS = 2_000;

export interface AttachSpec {
  task: LiveTask;
  binding: SessionBinding;
  adapter: CliAdapter;
  handle: SessionHandle;
  /** Факты копии единицы для решения о праве (свои пути, запреты, гранты задачи). */
  context: PermitContext;
  /** Подписчик потока: событие — уже после ворота права. */
  onEvent?: (event: AdapterEvent) => void;
  /**
   * Сессия прежнего ядра, прикреплённая заново: поток начинается с истории. Строка журнала
   * хода CLI пишется только сверх уже записанных для этой сессии (k-е событие ↔ k-я строка).
   */
  resumed?: boolean;
  /**
   * Сколько первых событий потока — история (ответ `reattach`, `replayed`). Ход ПОСЛЕ истории
   * пишется всегда, даже если журнал насчитал больше ходов, чем вернула история (строка
   * потеряна) — иначе счёт съедал бы новые ходы (core-s2 F-105). Не задано — вся сверка по счёту.
   */
  replayed?: number;
}

export interface AttachedSession {
  /** Поток переходника кончился (вышла, остановлена, упал) — после снятия записи; не отклоняется. */
  done: Promise<void>;
  /** Снять сессию: вопросы о праве дальше — 503, ворот её забывает. */
  detach(): void;
}

export interface SessionRuntime {
  attach(spec: AttachSpec): AttachedSession;
  permitDeps(task: LiveTask, binding: SessionBinding): PermitCallDeps | undefined;
  /**
   * Вопрос о праве сессии принят сервером права и ждёт решения ядра (`PendingPermits.deciding`):
   * тишина потока тогда — ожидание ядра, не модели (сторож тишины этапа 8).
   */
  permitPending(sessionId: string): boolean;
  /** Сколько сессий прикреплено (для загрузки и проверок). */
  size(): number;
}

export interface SessionRuntimeOptions {
  settleMs?: number;
  /** Сбой ответа строкой протокола — в журнал ядра, не в поток сессии. */
  note?: (event: string, data: Record<string, unknown>) => void;
  /** Кран экономики (этап 5): расход и факты окна из потока каждой сессии. */
  economy?: EconomyTap;
  /** Кран слоя пользователя (этап 7): отказы хуков человека, петли, потеря слоя — из потока. */
  userLayer?: UserLayerTap;
  /** Кран наблюдателя (этап 8): факты вызовов инструментов и активности сессии — из потока. */
  observer?: ObserverTap;
}

/** Кран слоя пользователя: событие потока сессии — после ворота права, рядом с экономикой. */
export interface UserLayerTap {
  onEvent(task: LiveTask, binding: SessionBinding, event: AdapterEvent): void;
}

interface Entry {
  spec: AttachSpec;
  deps: PermitCallDeps;
}

const keyOf = (taskId: string, sessionId: string): string => `${taskId}\u0000${sessionId}`;

const reasonText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function countCliTurns(task: LiveTask, sessionId: string): number {
  return readJournalLines(task.dir, task.taskId).lines.filter(
    (line) => line.kind === 'turn.cli-initiated' && line.sessionId === sessionId,
  ).length;
}

export function createSessionRuntime(options: SessionRuntimeOptions = {}): SessionRuntime {
  const gate: PendingPermits = createPendingPermits({ selfToolNames: [PERMIT_SELF_TOOL] });
  const settleMs = options.settleMs ?? PERMIT_SETTLE_MS;
  const live = new Map<string, Entry>();
  const note = options.note ?? (() => {});

  const answerInBand = async (entry: Entry, requestId: string, raw: unknown): Promise<void> => {
    const { task, binding, adapter, handle } = entry.spec;
    try {
      if (!adapter.answerPermit) {
        throw new Error(`adapter ${adapter.id} emits permit.request but has no answerPermit`);
      }
      const outcome = await answerPermitCall(task, binding, raw, entry.deps);
      await adapter.answerPermit(handle, requestId, outcome.reply);
    } catch (error) {
      note('permit.in-band.failed', {
        taskId: binding.taskId,
        sessionId: binding.sessionId,
        requestId,
        reason: reasonText(error),
      });
      await denyOrStop(entry, requestId);
    }
  };

  /**
   * Решение не дошло до CLI — он ждёт ответа посреди хода. Отказ кодеком переходника; не
   * вышло и это — сессия снимается мягко, а не висит до сторожа простоя (core-s2 F-42).
   */
  const denyOrStop = async (entry: Entry, requestId: string): Promise<void> => {
    const { binding, adapter, handle } = entry.spec;
    try {
      if (!adapter.answerPermit) throw new Error('no answerPermit');
      const deny = adapter.permitCodec.render({
        allow: false,
        message: 'The core could not decide this permission; denied.',
      });
      await adapter.answerPermit(handle, requestId, deny);
      return;
    } catch (error) {
      note('permit.in-band.deny-failed', {
        taskId: binding.taskId,
        sessionId: binding.sessionId,
        requestId,
        reason: reasonText(error),
      });
    }
    try {
      await adapter.stop(handle, 'soft');
    } catch (error) {
      note('permit.in-band.stop-failed', {
        taskId: binding.taskId,
        sessionId: binding.sessionId,
        requestId,
        reason: reasonText(error),
      });
    }
  };

  return {
    attach(spec) {
      const { task, binding, adapter, handle } = spec;
      const key = keyOf(binding.taskId, binding.sessionId);
      if (task.taskId !== binding.taskId) throw new Error('binding names another task');
      if (live.has(key)) throw new Error(`session ${binding.sessionId} already attached`);
      const entry: Entry = {
        spec,
        deps: {
          gate,
          codec: adapter.permitCodec,
          mapPermission: (call) => adapter.mapPermission(call),
          context: spec.context,
          settleMs,
        },
      };
      live.set(key, entry);
      let attached = true;
      const detach = (): void => {
        if (!attached) return;
        attached = false;
        if (live.get(key) === entry) live.delete(key);
        gate.forget(binding.sessionId);
      };
      let cliTurns = 0;
      let events = 0;
      const journaledCliTurns = spec.resumed ? countCliTurns(task, binding.sessionId) : 0;
      // Событие из истории прикреплённой заново сессии: `replayed` первых, а без счёта — любое
      // (сверка по счёту строк журнала).
      const historyAt = (index: number): boolean =>
        spec.replayed === undefined || index < spec.replayed;
      const journalCliTurn = (cause: TurnCause, index: number): void => {
        cliTurns += 1;
        if (historyAt(index) && cliTurns <= journaledCliTurns) return;
        try {
          // Ход, начатый самим CLI (03, P48): ядро его не посылало — видно только по журналу.
          task.append({
            kind: 'turn.cli-initiated',
            actor: `adapter:${adapter.id}`,
            sessionId: binding.sessionId,
            data: { sessionId: binding.sessionId, cause },
          });
        } catch (error) {
          note('turn.cli-initiated.unjournaled', {
            taskId: binding.taskId,
            sessionId: binding.sessionId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      };
      // Сбой крана экономики — запись в журнал ядра, поток сессии не рвётся.
      const tapEconomy = (event: AdapterEvent): void => {
        try {
          options.economy?.onEvent(task, binding, event);
        } catch (error) {
          note('economy.tap.failed', {
            taskId: binding.taskId,
            sessionId: binding.sessionId,
            reason: reasonText(error),
          });
        }
      };
      // Сбой крана слоя — так же: запись в журнал ядра, поток и кран экономики не рвутся.
      const tapUserLayer = (event: AdapterEvent): void => {
        try {
          options.userLayer?.onEvent(task, binding, event);
        } catch (error) {
          note('user-layer.tap.failed', {
            taskId: binding.taskId,
            sessionId: binding.sessionId,
            reason: reasonText(error),
          });
        }
      };
      // Кран наблюдателя — так же; история новой сессии не бывает (`resumed` нет — всё живое).
      const tapObserver = (event: AdapterEvent, index: number): void => {
        try {
          const inHistory = spec.resumed === true && historyAt(index);
          options.observer?.onEvent(task, binding, event, { inHistory });
        } catch (error) {
          note('observer.tap.failed', {
            taskId: binding.taskId,
            sessionId: binding.sessionId,
            reason: reasonText(error),
          });
        }
      };
      const pump = async (): Promise<void> => {
        try {
          for await (const event of adapter.events(handle)) {
            const index = events;
            events += 1;
            if (!attached) continue;
            gate.observe(binding.sessionId, event);
            if (event.type === 'turn.cli-initiated') journalCliTurn(event.cause, index);
            tapEconomy(event);
            tapUserLayer(event);
            tapObserver(event, index);
            if (event.type === 'permit.request') {
              void answerInBand(entry, event.requestId, event.raw);
            }
            spec.onEvent?.(event);
          }
        } catch (error) {
          // Поток упал — сессия снимается; `done` не отклоняется: его могут и не ждать.
          note('session.stream.failed', {
            taskId: binding.taskId,
            sessionId: binding.sessionId,
            reason: error instanceof Error ? error.message : String(error),
          });
        } finally {
          detach();
        }
      };
      return { done: pump(), detach };
    },
    permitDeps(task, binding) {
      return live.get(keyOf(task.taskId, binding.sessionId))?.deps;
    },
    permitPending: (sessionId) => gate.deciding(sessionId),
    size: () => live.size,
  };
}
