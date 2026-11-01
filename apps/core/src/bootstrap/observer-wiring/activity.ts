import type { AdapterEvent } from '../../adapters/index.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { ObserverNote, ObserverTap } from './observer-wiring.types.ts';

/**
 * Кран активности сессий (этап 8, F9): по потоку каждой сессии — когда было последнее живое
 * событие (рабочее монотонное время ядра, сон машины вычтен), идёт ли наш ход (`turn.started` без
 * `turn.ended`), каких инструментов сессия ждёт (запрос без результата → класс действия) и не ждёт
 * ли CLI ответа о праве в самом потоке (`permit.request` — последнее событие). Тик тишины
 * (`stall.ts`) читает это и пишет переходы; сам кран пишет только `output` — первое живое событие
 * затихшей сессии возвращает её в `live` (quiet → live, никогда live → live).
 *
 * История прикреплённой заново сессии (`inHistory`) восстанавливает ход и ожидания, но живым
 * событием не считается: её строки старые, отсчёт тишины после перезапуска идёт от прикрепления.
 */

export interface SessionActivity {
  /** Последнее живое событие (или первое знакомство с сессией) в рабочем монотонном времени. */
  lastAt: number;
  /** Наш ход в работе. */
  turn: boolean;
  /** Ждущие вызовы: id → класс действия. */
  pending: Map<string, string>;
  /** CLI спросил о праве строкой потока и ждёт ответа (после вопроса событий не было). */
  permitWaiting: boolean;
}

/** Класс действия запрошенного вызова: тот же словарь, что `tool.event.effectClass`. */
export type ToolClassOf = (
  task: LiveTask,
  binding: SessionBinding,
  call: { tool: string; input: unknown },
) => string;

/** Без классификатора — один класс на все вызовы: порог тогда только из значения спеки. */
export const UNCLASSIFIED_TOOL = 'tool';

export interface ActivityDeps {
  now: () => number;
  note?: ObserverNote;
  classOf?: ToolClassOf;
}

export interface ActivityBook {
  tap: ObserverTap;
  /** Активность сессии; нет — кран её ещё не видел. */
  get(sessionId: string): SessionActivity | undefined;
  /** Активность сессии, заведённая сейчас, если её не было (тик знакомится с сессией). */
  touch(sessionId: string): SessionActivity;
  forget(sessionId: string): void;
  /** Сессии, о которых кран что-то знает. */
  sessions(): string[];
}

/** Предел ждущих вызовов на сессию: поток с потерянными результатами не раздувает память. */
const PENDING_LIMIT = 256;

export function createActivityBook(deps: ActivityDeps): ActivityBook {
  const book = new Map<string, SessionActivity>();
  const classOf = deps.classOf ?? (() => UNCLASSIFIED_TOOL);

  const touch = (sessionId: string): SessionActivity => {
    let entry = book.get(sessionId);
    if (!entry) {
      entry = { lastAt: deps.now(), turn: false, pending: new Map(), permitWaiting: false };
      book.set(sessionId, entry);
    }
    return entry;
  };

  const classify = (
    task: LiveTask,
    binding: SessionBinding,
    event: Extract<AdapterEvent, { type: 'tool.requested' }>,
  ): string => {
    try {
      return classOf(task, binding, { tool: event.name, input: event.input });
    } catch (error) {
      deps.note?.('observer.activity.class-failed', {
        taskId: binding.taskId,
        sessionId: binding.sessionId,
        tool: event.name,
        reason: error instanceof Error ? error.message : String(error),
      });
      return UNCLASSIFIED_TOOL;
    }
  };

  const tap: ObserverTap = {
    onEvent(task, binding, event, meta) {
      const entry = touch(binding.sessionId);
      switch (event.type) {
        case 'turn.started':
          entry.turn = true;
          break;
        case 'turn.ended':
          entry.turn = false;
          entry.pending.clear();
          break;
        case 'tool.requested':
          // Вызов, начатый самим CLI (фон), не держит наш ход: его ожидание порог не растягивает.
          if (!event.cliInitiated && entry.pending.size < PENDING_LIMIT)
            entry.pending.set(event.toolUseId, classify(task, binding, event));
          break;
        case 'tool.result':
          entry.pending.delete(event.toolUseId);
          break;
        default:
      }
      entry.permitWaiting = event.type === 'permit.request';
      if (meta.inHistory) return;
      entry.lastAt = deps.now();
      const session = task.state.sessions[binding.sessionId];
      if (session?.state !== 'quiet') return;
      task.append({
        kind: 'session.transition',
        actor: 'core',
        sessionId: binding.sessionId,
        stepId: binding.stepId,
        data: { sessionId: binding.sessionId, event: 'output', from: 'quiet', to: 'live' },
      });
    },
  };

  return {
    tap,
    get: (sessionId) => book.get(sessionId),
    touch,
    forget: (sessionId) => {
      book.delete(sessionId);
    },
    sessions: () => [...book.keys()],
  };
}
