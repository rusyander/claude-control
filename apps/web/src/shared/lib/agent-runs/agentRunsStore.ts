import { apiClient } from '@shared/api/client';
import { normalizeProjectPath } from '@shared/lib/workspace';
import { aggregateStatus, runStatus, type RunStatus } from './status';

/**
 * Стор прогонов агента. В отличие от одного стрима на страницу, здесь их может
 * быть несколько сразу: агент продолжает работать в проекте, даже когда ты
 * переключился на другой таб. Каждый прогон — свой процесс на сервере и свой
 * поток событий; стор сводит их статусы по проектам для цветных точек на табах.
 *
 * Обновления иммутабельны (новый объект прогона на каждое событие) — этого ждёт
 * `useSyncExternalStore`. Снимок статусов по проектам кэшируется и пересчитывается
 * только при смене статуса или по таймеру зависания, а не на каждый токен текста,
 * иначе лента табов перерисовывалась бы на каждую букву ответа.
 */

export interface StreamedTool {
  name: string;
  input: string;
}

export interface AgentRun {
  /** Стабильный id прогона — chatId, с которым он стартовал. */
  id: string;
  sessionId?: string;
  /** Каталог проекта — для группировки статусов (undefined = домашний чат). */
  projectPath?: string;
  status: RunStatus;
  text: string;
  thinking: string;
  tools: StreamedTool[];
  costUsd?: number;
  limitResetsAt?: number;
  error?: string;
  /** В последнем ходе агент задал вопрос человеку (AskUserQuestion). */
  askedQuestion: boolean;
  lastEventAt: number;
}

export interface StartInput {
  chatId: string;
  prompt: string;
  sessionId?: string;
  files?: { name: string; base64: string }[];
  allowEdits?: boolean;
  /** Каталог проекта: серверу — для нового чата, стору — для группировки. */
  projectPath?: string;
}

type ChatEvent =
  | { kind: 'session'; sessionId: string; model: string; tools: number }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; input: unknown; id: string }
  | { kind: 'limit'; resetsAt: number; type: string; status: string }
  | { kind: 'done'; costUsd: number; durationMs: number; sessionId: string }
  | { kind: 'error'; message: string };

export const EMPTY_RUN: AgentRun = {
  id: '',
  status: 'idle',
  text: '',
  thinking: '',
  tools: [],
  askedQuestion: false,
  lastEventAt: 0,
};

const runs = new Map<string, AgentRun>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();

let onFinished: (() => void) | undefined;
let statusSnapshot = new Map<string, RunStatus>();
let watchdog: ReturnType<typeof setInterval> | undefined;

function emit(): void {
  for (const listener of listeners) listener();
}

/** Пересобрать снимок статусов по проектам (с поправкой на зависание). */
function rebuildStatuses(): void {
  const now = Date.now();
  const byProject = new Map<string, RunStatus[]>();

  for (const run of runs.values()) {
    if (!run.projectPath) continue;
    const key = normalizeProjectPath(run.projectPath);
    const status = runStatus({ status: run.status, lastEventAt: run.lastEventAt, now });
    const list = byProject.get(key) ?? [];
    list.push(status);
    byProject.set(key, list);
  }

  const next = new Map<string, RunStatus>();
  for (const [key, list] of byProject) next.set(key, aggregateStatus(list));
  statusSnapshot = next;
}

/** Таймер зависания: раз в 20 c пересобираем статусы, чтобы «молчащий» стал красным. */
function ensureWatchdog(): void {
  if (watchdog || typeof window === 'undefined') return;
  watchdog = setInterval(() => {
    let hasRunning = false;
    for (const run of runs.values()) if (run.status === 'running') hasRunning = true;
    if (!hasRunning) return;
    rebuildStatuses();
    emit();
  }, 20_000);
}

function setRun(id: string, patch: Partial<AgentRun>): void {
  const current = runs.get(id) ?? { ...EMPTY_RUN, id };
  runs.set(id, { ...current, ...patch });
}

/**
 * Ключ прогона по id чата. Новый чат стартует под временным id (`new-…`), а
 * потом получает настоящий sessionId; чтобы отображение не потеряло прогон при
 * смене id, ищем и по sessionId.
 */
function findKey(id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (runs.has(id)) return id;
  for (const [key, run] of runs) if (run.sessionId === id) return key;
  return undefined;
}

function applyEvent(id: string, event: ChatEvent): void {
  const run = runs.get(id);
  if (!run) return;

  const next: AgentRun = { ...run, lastEventAt: Date.now() };
  switch (event.kind) {
    case 'session':
      next.sessionId = event.sessionId;
      break;
    case 'text':
      next.text = run.text + event.text;
      break;
    case 'thinking':
      next.thinking = run.thinking + event.text;
      break;
    case 'tool':
      next.tools = [...run.tools, { name: event.name, input: JSON.stringify(event.input) }];
      // Вопрос человеку — повод для жёлтой точки, когда ход завершится.
      if (event.name === 'AskUserQuestion') next.askedQuestion = true;
      break;
    case 'limit':
      next.limitResetsAt = event.resetsAt;
      break;
    case 'done':
      next.costUsd = event.costUsd;
      next.sessionId = event.sessionId || run.sessionId;
      break;
    case 'error':
      next.error = event.message;
      break;
  }
  runs.set(id, next);
  emit();
}

function finalize(id: string): void {
  const run = runs.get(id);
  if (!run) return;
  const status: RunStatus = run.error ? 'error' : run.askedQuestion ? 'waiting' : 'idle';
  runs.set(id, { ...run, status });
  rebuildStatuses();
  emit();
}

export const agentRuns = {
  /** Запустить (или перезапустить) прогон под данным chatId. */
  start(input: StartInput): void {
    ensureWatchdog();
    const id = input.chatId;
    controllers.get(id)?.abort();
    const controller = new AbortController();
    controllers.set(id, controller);

    // Тот же разговор мог начаться под временным id (`new-…`), а продолжается уже
    // под настоящим sessionId. Старый прогон-двойник убираем, чтобы не копился.
    if (input.sessionId) {
      for (const [key, run] of runs) {
        if (key !== id && run.sessionId === input.sessionId) {
          controllers.get(key)?.abort();
          controllers.delete(key);
          runs.delete(key);
        }
      }
    }

    const prev = runs.get(id);
    setRun(id, {
      id,
      // Идентификатор сессии — ниточка разговора, сохраняем между ходами.
      sessionId: input.sessionId ?? prev?.sessionId,
      projectPath: input.projectPath ?? prev?.projectPath,
      status: 'running',
      text: '',
      thinking: '',
      tools: [],
      costUsd: undefined,
      error: undefined,
      askedQuestion: false,
      lastEventAt: Date.now(),
    });
    rebuildStatuses();
    emit();

    void (async () => {
      try {
        const response = await fetch(`${apiClient.defaults.baseURL}/chat/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Сервер ответил ${response.status}`);
        if (!response.body) throw new Error('Пустой ответ сервера');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const line = chunk.split('\n').find((part) => part.startsWith('data:'));
            if (line) applyEvent(id, JSON.parse(line.slice(5)) as ChatEvent);
          }
        }
      } catch (error) {
        // Прерывание кнопкой — не ошибка.
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          const run = runs.get(id);
          if (run) {
            runs.set(id, {
              ...run,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } finally {
        controllers.delete(id);
        finalize(id);
        onFinished?.();
      }
    })();
  },

  /** Остановить прогон: сервер убивает процесс, клиент перестаёт читать поток. */
  stop(id: string): void {
    void apiClient.post(`/chat/${id}/stop`).catch(() => undefined);
    controllers.get(id)?.abort();
  },

  /** Убрать прогон из стора (например, когда его ответ уже есть в истории). */
  clear(id: string): void {
    const key = findKey(id);
    if (!key) return;
    controllers.get(key)?.abort();
    controllers.delete(key);
    runs.delete(key);
    rebuildStatuses();
    emit();
  },

  /**
   * Спрятать потоковый текст прогона, сохранив статус: когда ответ уже есть в
   * истории, дубль на экране не нужен, но жёлтая/красная точка (вопрос/ошибка)
   * должна остаться.
   */
  quiet(id: string): void {
    const key = findKey(id);
    if (!key) return;
    const run = runs.get(key);
    if (!run) return;
    runs.set(key, { ...run, text: '', thinking: '', tools: [] });
    emit();
  },

  /** Колбэк по завершении любого прогона — страница обновляет список чатов. */
  setOnFinished(callback: (() => void) | undefined): void {
    onFinished = callback;
  },
};

export function getRun(id: string | undefined): AgentRun {
  const key = findKey(id);
  return (key && runs.get(key)) || EMPTY_RUN;
}

export function getProjectStatuses(): Map<string, RunStatus> {
  return statusSnapshot;
}

export function subscribeRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
