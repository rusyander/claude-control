import type { MessageUsage } from '@claude-control/contracts';
import { callbacks, emit, pendingUsage, runs } from './agent-runs.state';
import { rebuildStatuses } from './agent-runs.statuses';
import type { AgentRun, ChatEvent } from './agent-runs.types';
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

      // Тот же расход — ещё и адресно, к действиям этого шага. Событие обгоняет
      // сами вызовы, поэтому кладём его в отложенные: их разберёт case 'tool'.
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
  }
  runs.set(id, next);
  // Запрос/ответ прав меняют «важность» прогона (жёлтая точка) — пересобираем.
  if (event.kind === 'permission' || event.kind === 'permissionResolved') rebuildStatuses();
  emit();
  if (firePermission) callbacks.onPermissionRequest?.(next);
}
