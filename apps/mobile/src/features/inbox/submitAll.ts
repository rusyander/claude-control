import type { CorePermitAsk } from '@agentdeck/contracts/chat-handoff';
import type { Submission } from './queue.types';

export interface SubmitDeps {
  post: (path: string, body: unknown) => Promise<unknown>;
  /** Сообщение в разговор. Ложь — не принято (текст причины рядом). */
  sendMessage: (text: string) => Promise<{ ok: boolean; message?: string }>;
  /**
   * Ответ на вопрос права задачи ядра — командами ядра с подписью ключа телефона
   * (`entities/core-task` `decideCorePermit`). Ложь — не ушло (нет ключа, отказ ядра).
   */
  sendCore: (
    card: CorePermitAsk,
    behavior: 'allow' | 'deny',
  ) => Promise<{ ok: boolean; message?: string }>;
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
      if (item.kind === 'corePermit') {
        const outcome = await deps.sendCore(item.card, item.behavior);
        if (!outcome.ok) return { sentKeys, error: outcome.message ?? '' };
      } else if (item.kind === 'permission') {
        // `ok: false` — запрос уже снят (решили за компьютером): ответ не нужен.
        await deps.post(`/chat/${encodeURIComponent(item.runKey)}/permission-decision`, {
          toolUseId: item.toolUseId,
          behavior: item.behavior,
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
