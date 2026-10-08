import type { AgentRun } from './agent-runs.types';
import { apiClient } from '@shared/api/client';
import { i18n } from '@shared/config/i18n';
import { pickRetryPrompt } from './pickRetryPrompt';

/** Хвост транскрипта: своя реплика — последняя из реплик человека, дальше смотреть незачем. */
export const RETRY_TAIL = 5;

/** Задача заново или «продолжай» — по тому, дожила ли реплика до транскрипта. */
export async function retryPromptFor(run: AgentRun): Promise<string> {
  const lastPrompt = run.lastPrompt ?? '';
  if (!run.sessionId || run.startedAt === undefined) return lastPrompt;
  try {
    const { data } = await apiClient.get<{ messages: { role: string; timestamp: string }[] }>(
      `/chats/${run.sessionId}/messages`,
      { params: { limit: RETRY_TAIL } },
    );
    return pickRetryPrompt({
      lastPrompt,
      startedAt: run.startedAt,
      history: data.messages,
      continuation: i18n.t('chat.continueAfterDrop'),
    });
  } catch {
    // Транскрипт не прочитался — ведём себя как раньше: задача заново.
    return lastPrompt;
  }
}
