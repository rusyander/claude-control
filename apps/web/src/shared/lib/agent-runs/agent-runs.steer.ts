import { apiClient } from '@shared/api/client';
import { enqueue } from './agent-runs.commands';
import { drainQueue } from './agent-runs.lifecycle';
import { nextQueueSeq } from './agent-runs.state';
import type { QueuedMessage } from './agent-runs.types';
import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { setRun } from './setRun';
import { findKey } from './findKey';

/** Слово «на ходу» — в ленту сразу, до ответа сервера (Ф12). */
function markSending(key: string, text: string): string {
  const id = `steering-${Date.now()}-${nextQueueSeq()}`;
  setRun(key, { steering: [...(runs.get(key)?.steering ?? []), { id, text }] });
  emit();
  return id;
}

function unmarkSending(key: string, id: string): void {
  const run = runs.get(key);
  if (!run?.steering) return;
  const rest = run.steering.filter((item) => item.id !== id);
  setRun(key, { steering: rest.length > 0 ? rest : undefined });
  emit();
}

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
  const sendingId = markSending(key, message.prompt);
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
    if (data?.steered) {
      unmarkSending(key, sendingId);
      return 'steered';
    }
  } catch {
    // Занят без живой сессии (409), ход кончился или сеть — дальше очередь.
  }
  // Снять пузырь «Передаётся…» и поставить в очередь — одним показом, без мигания.
  unmarkSending(key, sendingId);
  enqueue(id, message);
  // Ход кончился, пока шёл запрос: конец хода очередь уже не снимет — дослать сейчас.
  if (runs.get(key)?.status !== 'running') drainQueue(key);
  return 'queued';
}
