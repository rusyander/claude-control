import { apiClient } from '@shared/api/client';
import { enqueue } from './agent-runs.commands';
import { drainQueue } from './agent-runs.lifecycle';
import { findKey, runs } from './agent-runs.state';
import type { AgentRun, QueuedMessage } from './agent-runs.types';

/**
 * Сказать агенту посреди хода — как в самом Claude Code: сообщение уходит в
 * живую сессию сразу, агент дочитывает текущий шаг, видит его и учитывает (ответ,
 * новый пункт плана, смена курса), не дожидаясь конца всей работы. В ленте оно
 * появляется по событию `steer` из потока прогона.
 *
 * Не вышло — вложения (они идут своим ходом), прогон не живой или уже кончился —
 * сообщение встаёт в очередь, как раньше: ничего не теряется.
 */
export async function steer(
  id: string,
  message: Omit<QueuedMessage, 'id'>,
): Promise<'steered' | 'queued'> {
  const key = findKey(id) ?? id;
  const run = runs.get(key);
  if (!run || run.status !== 'running' || (message.files?.length ?? 0) > 0) {
    enqueue(id, message);
    return 'queued';
  }
  try {
    const { data } = await apiClient.post<{ steered?: boolean }>('/chat/send', {
      chatId: run.serverRunId ?? (run.id || key),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.projectPath ? { projectPath: run.projectPath } : {}),
      prompt: message.prompt,
      steer: true,
      ...(message.allowEdits !== undefined ? { allowEdits: message.allowEdits } : {}),
      ...(message.autoApprove !== undefined ? { autoApprove: message.autoApprove } : {}),
      ...(message.model ? { model: message.model } : {}),
      ...(message.effort ? { effort: message.effort } : {}),
    });
    if (data?.steered) return 'steered';
  } catch {
    // Занят без живой сессии (409), ход кончился или сеть — дальше очередь.
  }
  enqueue(id, message);
  // Ход кончился, пока шёл запрос: конец хода очередь уже не снимет — дослать сейчас.
  if (runs.get(key)?.status !== 'running') drainQueue(key);
  return 'queued';
}

/**
 * Что показать пузырями ожидания: переданное агенту на ходу — первым (оно уже у
 * агента), за ним очередь, которая уйдёт только по концу хода.
 */
export function pendingBubbles(run: Pick<AgentRun, 'steered' | 'queued'>): QueuedMessage[] {
  return [
    ...(run.steered ?? []).map((item) => ({
      id: `steered-${item.at}`,
      prompt: item.text,
      steered: true,
    })),
    ...run.queued,
  ];
}
