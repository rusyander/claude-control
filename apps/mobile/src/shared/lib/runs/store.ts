import { useSyncExternalStore } from 'react';
import type { MessageUsage } from '@claude-control/contracts';
import { EMPTY_RUN, type AgentRun, type ChatEvent, type RunStatus } from './types';

/**
 * Состояние идущих прогонов. Живёт вне React по той же причине, что и в панели:
 * поток событий приходит из транспорта, а не из компонентов, и прогон обязан
 * переживать уход с экрана.
 *
 * Обновления иммутабельны — этого требует `useSyncExternalStore`.
 */

export const runs = new Map<string, AgentRun>();
/** Последний seq каждого прогона — с него догоняем поток при переподключении. */
export const lastSeqs = new Map<string, number>();
/** Живые контроллеры потоков: по ним поток отцепляется при остановке. */
export const controllers = new Map<string, AbortController>();
/** Расход шага приходит РАНЬШЕ вызовов инструментов — держим до их прихода. */
const pendingUsage = new Map<string, Map<string, MessageUsage>>();

const listeners = new Set<() => void>();
let version = 0;

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function getVersion(): number {
  return version;
}

/** Прогон разговора: тот, что зарегистрирован под этим id, либо пустой. */
export function getRun(id: string): AgentRun {
  return runs.get(id) ?? { ...EMPTY_RUN, id };
}

export function setRun(id: string, patch: Partial<AgentRun>): AgentRun {
  const current = runs.get(id) ?? { ...EMPTY_RUN, id };
  const next = { ...current, ...patch, id: patch.id ?? current.id ?? id };
  runs.set(id, next);
  return next;
}

/** Хук подписки: возвращает прогон и перерисовывает экран на каждое событие. */
export function useRun(id: string): AgentRun {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return getRun(id);
}

/** Все прогоны, о которых знает приложение, — для точек на списках и вкладках. */
export function useRuns(): AgentRun[] {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return [...runs.values()];
}

/**
 * Статус, который видит человек. Отдельно от поля `status`: «ждёт» — это не
 * отдельное состояние прогона, а идущий прогон, упёршийся в вопрос или права.
 */
export function visibleStatus(run: AgentRun): RunStatus {
  if (run.status !== 'running') return run.status;
  if (run.permissions.length > 0 || run.askedQuestion) return 'waiting';
  return 'running';
}

function addUsage(base: MessageUsage | undefined, step: MessageUsage): MessageUsage {
  if (!base) return step;
  return {
    ...base,
    input: base.input + step.input,
    output: base.output + step.output,
    cacheRead: base.cacheRead + step.cacheRead,
    cacheCreation: base.cacheCreation + step.cacheCreation,
    cacheCreation1h: (base.cacheCreation1h ?? 0) + (step.cacheCreation1h ?? 0),
    costUsd: (base.costUsd ?? 0) + (step.costUsd ?? 0),
  };
}

/**
 * Применить событие потока. Разбор один в один с панелью: расхождение здесь
 * значило бы, что телефон и браузер показывают разный ход одного разговора.
 */
export function applyEvent(id: string, event: ChatEvent): void {
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
      next.tools = [
        ...run.tools,
        {
          name: event.name,
          input: JSON.stringify(event.input),
          id: event.id || undefined,
          usage: event.id ? pendingUsage.get(id)?.get(event.id) : undefined,
        },
      ];
      if (event.name === 'AskUserQuestion') next.askedQuestion = true;
      break;
    case 'limit':
      next.limitResetsAt = event.resetsAt;
      break;
    case 'usage': {
      next.tokens = run.tokens + event.input + event.output + event.cacheRead + event.cacheCreation;
      // Остаток сверки с итогом прогона — не шаг: к тексту ответа он не
      // относится, панель его тоже не приписывает. Только счётчик.
      if (event.remainder) break;
      const step: MessageUsage = {
        input: event.input,
        output: event.output,
        cacheRead: event.cacheRead,
        cacheCreation: event.cacheCreation,
        cacheCreation1h: event.cacheCreation1h,
        model: event.model,
        costUsd: event.costUsd,
      };
      const toolIds = event.toolIds ?? [];
      if (toolIds.length === 0) {
        next.textUsage = addUsage(run.textUsage, step);
        break;
      }
      let waiting = pendingUsage.get(id);
      if (!waiting) {
        waiting = new Map();
        pendingUsage.set(id, waiting);
      }
      for (const toolId of toolIds) waiting.set(toolId, step);
      next.tools = run.tools.map((tool) =>
        tool.id && toolIds.includes(tool.id) ? { ...tool, usage: step } : tool,
      );
      break;
    }
    case 'done':
      next.costUsd = event.costUsd;
      next.sessionId = event.sessionId || run.sessionId;
      break;
    case 'error':
      next.error = event.message;
      next.errorRetriable = event.retriable === true;
      break;
    case 'permission': {
      const already = run.permissions.some((item) => item.toolUseId === event.toolUseId);
      next.permissions = already
        ? run.permissions
        : [
            ...run.permissions,
            { toolName: event.toolName, input: event.input, toolUseId: event.toolUseId },
          ];
      break;
    }
    case 'permissionResolved':
      next.permissions = run.permissions.filter((item) => item.toolUseId !== event.toolUseId);
      break;
  }

  runs.set(id, next);
  emit();
}

/**
 * Убрать потоковый дубль: ответ живёт в двух местах — пока печатается, в
 * потоке, а после записи в транскрипт ещё и в истории. Как только история
 * перечитана, поток обязан замолчать, иначе один и тот же ответ стоит на экране
 * дважды. Статус, ошибку и сессию оставляем: по ним живёт точка и продолжение
 * разговора.
 */
export function quietRun(id: string): void {
  const run = runs.get(id);
  if (!run) return;
  runs.set(id, { ...run, text: '', thinking: '', tools: [] });
  emit();
}

/** Прогона больше нет на сервере — чистим и его отложенный расход. */
export function forgetRun(id: string): void {
  runs.delete(id);
  lastSeqs.delete(id);
  pendingUsage.delete(id);
  controllers.delete(id);
  emit();
}
