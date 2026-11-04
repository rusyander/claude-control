import {
  humanTextOf,
  sessionEventKeys,
  type SessionStreamEvent,
} from '@agentdeck/contracts/core/session-stream';
import type { SessionView, StepView, TaskView } from '@agentdeck/contracts/core/task-view';
import type { ChatItem, ChatToolItem, SessionEvents } from './coreChat.types';

/**
 * Лента чата ядра из вида сеанса (`GET …/sessions/:sid/stream`): один рисовальщик на любой CLI —
 * события уже нормализованы переходником. Текст модели приходит кусками (`assistant-text`) и
 * склеивается в одно сообщение до первого не-текста; результат инструмента садится к своему
 * вызову по `toolUseId`; слово человека показывается без строки метки ядра.
 */

/** Шаг чата задачи: у `chat@1` он один; несколько (повтор после сбоя) — последний начатый. */
export function chatStepOf(view: TaskView | undefined): StepView | undefined {
  const steps = (view?.steps ?? []).filter((s) => s.stepKind === 'chat');
  return steps.sort((a, b) => b.startedSeq - a.startedSeq)[0];
}

/** Сеансы шага в порядке начала: после перезапуска ядра разговор продолжает новый сеанс. */
export function sessionsOfStep(view: TaskView | undefined, stepId: string): SessionView[] {
  return (view?.sessions ?? [])
    .filter((s) => s.stepId === stepId)
    .sort((a, b) => a.startedSeq - b.startedSeq);
}

const textOf = (data: SessionStreamEvent['data'], key: string): string => {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const v = (data as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return '';
};

const fieldOf = (data: SessionStreamEvent['data'], key: string): unknown =>
  data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)[key]
    : undefined;

export function chatItems(sessions: readonly SessionEvents[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, ChatToolItem>();
  let open: { kind: 'assistant'; key: string; text: string } | null = null;
  for (const s of sessions) {
    const keys = sessionEventKeys(s.events);
    s.events.forEach((e, i) => {
      const key = `${s.sessionId}:${keys[i]}`;
      if (e.kind === 'assistant-text') {
        const text = textOf(e.data, 'text');
        if (open) open.text += text;
        else {
          open = { kind: 'assistant', key, text };
          items.push(open);
        }
        return;
      }
      // Окно подписки — замер лимита для панели, не реплика: текст ответа вокруг него не рвётся.
      if (e.kind === 'usage' || e.kind === 'thinking' || e.kind === 'window') return;
      open = null;
      switch (e.kind) {
        case 'user-text':
          items.push({ kind: 'human', key, text: humanTextOf(textOf(e.data, 'text')) });
          return;
        case 'tool-call': {
          const toolUseId = textOf(e.data, 'toolUseId');
          const tool: ChatToolItem = {
            toolUseId,
            name: textOf(e.data, 'name'),
            input: fieldOf(e.data, 'input') ?? null,
            result: null,
          };
          tools.set(toolUseId, tool);
          items.push({ kind: 'tool', key, tool });
          return;
        }
        case 'tool-result': {
          const tool = tools.get(textOf(e.data, 'toolUseId'));
          if (tool) tool.result = { isError: fieldOf(e.data, 'isError') === true };
          return;
        }
        case 'permission':
          items.push({ kind: 'permission', key, data: e.data });
          return;
        case 'error':
          items.push({
            kind: 'error',
            key,
            text: [textOf(e.data, 'code'), textOf(e.data, 'detail')].filter(Boolean).join(': '),
          });
          return;
        case 'turn-end':
          items.push({ kind: 'turn-end', key, isError: fieldOf(e.data, 'isError') === true });
          return;
        default:
          return;
      }
    });
  }
  // Пустые куски текста (служебная дельта) строк не дают.
  return items.filter((it) => it.kind !== 'assistant' || it.text.length > 0);
}

/** Ход за моделью: последнее значимое событие — не конец хода и не ошибка. */
export function modelTurnOpen(items: readonly ChatItem[]): boolean {
  const last = items.at(-1);
  return last !== undefined && last.kind !== 'turn-end' && last.kind !== 'error';
}

export type ChatStatusKey =
  'missing' | 'refused' | 'launch-refused' | 'closed' | 'dropped' | 'answering' | 'waiting';

/**
 * Строка состояния чата — первое верное по важности: задачи нет, ядро отказало запросу, ядро
 * отказало запуску CLI (суд совместимости), чат закрыт, поток оборван, модель отвечает, ждём
 * человека. Закрытый чат с оборванным потоком — закрыт: писать в него уже нечего; отказ запуска
 * важнее закрытия — шаг, кончившийся отказами, иначе читался бы как обычный конец чата.
 */
export function chatStatusKey(s: {
  taskMissing: boolean;
  refusal: number | null;
  launchRefused: boolean;
  closed: boolean;
  dropped: boolean;
  answering: boolean;
}): ChatStatusKey {
  if (s.taskMissing) return 'missing';
  if (s.refusal !== null) return 'refused';
  if (s.launchRefused) return 'launch-refused';
  if (s.closed) return 'closed';
  if (s.dropped) return 'dropped';
  return s.answering ? 'answering' : 'waiting';
}
