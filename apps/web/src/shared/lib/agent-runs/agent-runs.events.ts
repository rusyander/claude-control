import type { MessageUsage } from '@claude-control/contracts';
import { persistQueue } from './agent-runs.queue-store';
import { callbacks, emit, pendingUsage, runs } from './agent-runs.state';
import { rebuildStatuses } from './agent-runs.statuses';
import type { AgentRun, ChatEvent, HandoffEvent } from './agent-runs.types';
import { addUsage } from './agent-runs.usage';

/**
 * Применить одно событие потока к прогону. Обновления иммутабельны (новый объект
 * прогона на каждое событие) — этого ждёт `useSyncExternalStore`.
 */
export function applyEvent(id: string, event: ChatEvent): void {
  const run = runs.get(id);
  if (!run) return;

  const next: AgentRun = { ...run, lastEventAt: Date.now() };
  let firePermission = false;
  let fireHandoff: HandoffEvent | undefined;
  switch (event.kind) {
    case 'session':
      next.sessionId = event.sessionId;
      next.startedAt = event.startedAt ?? run.startedAt;
      break;
    case 'text':
      // Хвост завершённого прогона: ответ уже в истории, пузырю он не нужен.
      if (!run.tailOnly) next.text = run.text + event.text;
      break;
    case 'thinking':
      if (!run.tailOnly) next.thinking = run.thinking + event.text;
      break;
    case 'tool':
      next.tools = [
        ...run.tools,
        {
          name: event.name,
          input: JSON.stringify(event.input),
          id: event.id || undefined,
          // Расход своего шага приходит РАНЬШЕ самих вызовов — забираем отложенное.
          usage: event.id ? pendingUsage.get(id)?.get(event.id) : undefined,
        },
      ];
      // Вопрос человеку — повод для жёлтой точки, когда ход завершится.
      if (event.name === 'AskUserQuestion') next.askedQuestion = true;
      break;
    case 'limit':
      next.limitResetsAt = event.resetsAt;
      break;
    case 'usage': {
      // Токены прогона — для бейджа этого разговора; общий счётчик за сеанс
      // считает сервер (см. loadSpend), чтобы он не слетал на перезагрузке.
      const spent = event.input + event.output + event.cacheRead + event.cacheCreation;
      next.tokens = run.tokens + spent;
      // Остаток сверки — не шаг: у него нет ни действия, ни текста, к которым
      // его можно было бы приписать. Только счётчик.
      if (event.remainder) break;

      // Тот же расход — ещё и адресно, к действиям этого шага. Порядок не
      // гарантирован: с потоковыми событиями расход замыкает ход и приходит
      // после вызовов, без них — раньше. Поэтому и отложенные (их разберёт
      // case 'tool'), и дополнение уже показанных вызовов ниже.
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
        // Шаг без вызовов — это цена текста ответа.
        next.textUsage = addUsage(run.textUsage, step);
        break;
      }

      let waiting = pendingUsage.get(id);
      if (!waiting) {
        waiting = new Map();
        pendingUsage.set(id, waiting);
      }
      for (const toolId of toolIds) waiting.set(toolId, step);
      // Вызов мог прийти и раньше расхода — тогда дополняем уже показанный.
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
      // Признак временности — только тот, что прислал сервер.
      next.errorRetriable = event.retriable === true;
      break;
    case 'permission': {
      // Новый запрос прав — добавляем (без дублей по toolUseId).
      const already = run.permissions.some((p) => p.toolUseId === event.toolUseId);
      next.permissions = already
        ? run.permissions
        : [
            ...run.permissions,
            { toolName: event.toolName, input: event.input, toolUseId: event.toolUseId },
          ];
      firePermission = !already;
      break;
    }
    case 'permissionResolved':
      next.permissions = run.permissions.filter((p) => p.toolUseId !== event.toolUseId);
      break;
    case 'handoff':
      // В самом прогоне ничего не меняется: он закрыт, а работа уехала в другой
      // разговор. Колбэк вызываем ПОСЛЕ записи снимка, ниже, — обработчик
      // переключает вкладку и читает прогон, который должен быть уже актуален.
      fireHandoff = event;
      break;
  }
  runs.set(id, next);
  // Разговор обзавёлся настоящим id — переписываем под него сохранённую
  // очередь. Под временным `new-…` она после перезагрузки недостижима: этого
  // написания больше не существует ни у кого.
  if (next.sessionId !== run.sessionId && next.queued.length > 0) persistQueue(id);
  // Снимок пульта пересобираем только на событиях, которые в нём ВИДНЫ.
  //
  // Запрос и ответ прав меняют «важность» прогона (жёлтая точка). Вопрос
  // человеку — то же самое, и вдобавок родительский разговор читает вопросы
  // детей именно из снимка: пока пересборки не было, карточка не появлялась
  // нигде — ни у ребёнка, ни у родителя — до случайного соседнего события или
  // сторожевого таймера, то есть до двадцати секунд, всё это время агент стоял.
  // Расход — цифры того же пульта, и отставать на двадцать секунд им незачем.
  //
  // Текст и размышления в снимок не входят: пересборка на каждую букву ответа
  // перерисовывала бы ленту табов, ради чего кэш и заводился.
  const shownInSnapshot =
    event.kind === 'permission' ||
    event.kind === 'permissionResolved' ||
    event.kind === 'usage' ||
    (event.kind === 'tool' && event.name === 'AskUserQuestion');
  if (shownInSnapshot) rebuildStatuses();
  emit();
  if (firePermission) callbacks.onPermissionRequest?.(next);
  if (fireHandoff) callbacks.onHandoff?.(fireHandoff, next);
}
