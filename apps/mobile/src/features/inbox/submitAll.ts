import type { Submission } from './queue.types';

export interface SubmitDeps {
  post: (path: string, body: unknown) => Promise<unknown>;
  /** Сообщение в разговор. Ложь — не принято (текст причины рядом). */
  sendMessage: (text: string) => Promise<{ ok: boolean; message?: string }>;
}

export interface SubmitOutcome {
  /** Ключи, чьи ответы ушли, — карточка их больше не показывает. */
  sentKeys: string[];
  error?: string;
}

/**
 * Отправить по порядку и остановиться на первом отказе. Ушедшее запоминается:
 * повтор после ошибки шлёт только оставшееся, а не второе «разрешить» и не
 * второе сообщение — второе сообщение было бы вторым ходом агента.
 */
export async function submitAll(
  submissions: readonly Submission[],
  deps: SubmitDeps,
): Promise<SubmitOutcome> {
  const sentKeys: string[] = [];
  for (const item of submissions) {
    try {
      if (item.kind === 'permission') {
        // `ok: false` — запрос уже снят (решили за компьютером): ответ не нужен.
        await deps.post(`/chat/${encodeURIComponent(item.runKey)}/permission-decision`, {
          toolUseId: item.toolUseId,
          behavior: item.behavior,
        });
      } else if (item.kind === 'branchGate') {
        await deps.post(`/chat/${encodeURIComponent(item.runKey)}/branch-decision`, {
          toolUseId: item.toolUseId,
          choice: item.choice,
        });
      } else {
        const outcome = await deps.sendMessage(item.text);
        if (!outcome.ok) return { sentKeys, error: outcome.message ?? '' };
      }
    } catch (error) {
      return { sentKeys, error: error instanceof Error ? error.message : String(error) };
    }
    sentKeys.push(...item.keys);
  }
  return { sentKeys };
}
