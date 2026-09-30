import { useSyncExternalStore } from 'react';
import type { MessageUsage } from '@agentdeck/contracts';
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

/**
 * Ключ, под которым разговор уже известен стору, — по любому из его написаний.
 *
 * Один разговор живёт под несколькими именами: временный `new-…` до первого
 * ответа сервера, `sessionId` после, серверный ключ — если чат начали в другом
 * месте. Опрос `/chat/active` называет его как угодно, и сверка по одному
 * `chatId` заводила бы вторую запись и второй поток на тот же прогон.
 */
export function findRunKey(...names: (string | undefined)[]): string | undefined {
  const wanted = names.filter((name): name is string => Boolean(name));
  if (wanted.length === 0) return undefined;
  for (const [key, run] of runs) {
    if (wanted.includes(key)) return key;
    if (run.sessionId && wanted.includes(run.sessionId)) return key;
    if (run.serverRunId && wanted.includes(run.serverRunId)) return key;
  }
  return undefined;
}

/**
 * Под каким ключом экран разговора читает прогон, открытый под ЛЮБЫМ именем.
 *
 * Разговор, начатый во вкладке панели или разделением, идёт на сервере под
 * временным `new-…`, а телефон открывает его по сессии — из списка разговоров
 * или по памяти о прошлом открытии. Чтение по одному точному ключу находило
 * пустую запись, и экран показывал «молчит» у работающего агента: ни «Стоп», ни
 * живого текста, ни опроса прогресса (живой прогон 28.09, 1b). Идущий прогон
 * важнее законченного под тем же именем; дальше — точный ключ, потом любой.
 */
export function runKeyFor(id: string): string {
  let exact: string | undefined;
  let alias: string | undefined;
  for (const [key, run] of runs) {
    const named = key === id || run.sessionId === id || run.serverRunId === id;
    if (!named) continue;
    if (run.status === 'running') return key;
    if (key === id) exact = key;
    else alias ??= key;
  }
  return exact ?? alias ?? id;
}

/** Ключ прогона разговора с подпиской: сменится, как только опрос подхватит ход. */
export function useRunKey(id: string): string {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return runKeyFor(id);
}

/** Прогон, известный под одним из имён разговора; идущий — первым (точки списков). */
export function runNamed(
  list: readonly AgentRun[],
  ...names: (string | undefined)[]
): AgentRun | undefined {
  const wanted = names.filter((name): name is string => Boolean(name));
  const named = list.filter(
    (run) =>
      wanted.includes(run.id) ||
      (run.sessionId !== undefined && wanted.includes(run.sessionId)) ||
      (run.serverRunId !== undefined && wanted.includes(run.serverRunId)),
  );
  return named.find((run) => run.status === 'running') ?? named[0];
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
 *
 * У прогона, подхваченного законченным (`tailOnly`), текст, размышления и
 * вызовы инструментов в пузырь не идут — они уже в истории; из потока берём
 * только то, чего в ней нет: расход, вопрос, права.
 */
export function applyEvent(id: string, event: ChatEvent): void {
  const run = runs.get(id);
  if (!run) return;

  const tailOnly = run.tailOnly === true;
  const next: AgentRun = { ...run, lastEventAt: Date.now() };
  switch (event.kind) {
    case 'session':
      next.sessionId = event.sessionId;
      next.startedAt = event.startedAt ?? run.startedAt;
      // Модель — от самого CLI, а не из того, что телефон отправил. Отправляет
      // он её далеко не всегда (по умолчанию в поле ввода стоит «как в
      // настройках»), а чат, заведённый разделением, панель вообще ведёт
      // подобранной моделью, которой телефон не называл. Без этой строки экран
      // молчал бы ровно там, где ответ на «чем это сейчас работает» и нужен.
      next.model = event.model || run.model;
      break;
    case 'text':
      if (!tailOnly) next.text = run.text + event.text;
      break;
    case 'steer':
      if (!(run.steered ?? []).includes(event.text)) {
        next.steered = [...(run.steered ?? []), event.text];
      }
      break;
    case 'thinking':
      if (!tailOnly) next.thinking = run.thinking + event.text;
      break;
    case 'tool':
      if (event.name === 'AskUserQuestion') next.askedQuestion = true;
      if (tailOnly) break;
      next.tools = [
        ...run.tools,
        {
          name: event.name,
          input: JSON.stringify(event.input),
          id: event.id || undefined,
          usage: event.id ? pendingUsage.get(id)?.get(event.id) : undefined,
          at: Date.now(),
        },
      ];
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
    case 'autoPick': {
      // Вопрос закрыт автономией: вызов получает след выбора, а «ждёт вас»
      // снимается, если открытых вопросов в ходе не осталось.
      const tools = run.tools.map((tool) =>
        tool.id === event.toolUseId ? { ...tool, autoPicks: event.picks } : tool,
      );
      next.tools = tools;
      next.askedQuestion = tools.some(
        // Закрыт самим фактом автовыбора, как на сервере: пустой список — выбор,
        // который прогон не разобрал, а не открытый вопрос (F-132).
        (tool) => tool.name === 'AskUserQuestion' && tool.autoPicks === undefined,
      );
      break;
    }
    case 'handoff':
      // Продолжение заведено сервером — запоминаем, куда: экран разговора
      // переключится по окончании этого прогона. Отказ (`reason` без `chatId`)
      // ничего не меняет: разговор просто продолжается здесь.
      if (event.chatId) next.handoffTo = event.chatId;
      break;
  }

  runs.set(id, next);
  emit();
}

/**
 * Поток замолчал дольше срока. Метка живёт до первого байта после
 * переподключения; экран по ней показывает «переподключаемся» вместо точки
 * «работает» — иначе мёртвый сокет неотличим от думающего агента.
 */
export function markStalled(id: string): void {
  const run = runs.get(id);
  if (!run || run.stalled) return;
  runs.set(id, { ...run, stalled: true });
  emit();
}

/** Байты снова идут — связь восстановлена, метка снимается. */
export function markLive(id: string): void {
  const run = runs.get(id);
  if (!run?.stalled) return;
  runs.set(id, { ...run, stalled: undefined });
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
