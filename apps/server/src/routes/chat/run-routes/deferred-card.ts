import type { DeferredDecisionResult } from '@agentdeck/contracts/deferred-asks';
import type { ServerContext } from '../../../context.ts';
import { decideDeferred, deferredAsksOf } from '../deferred-routes/deferred-store.ts';

/**
 * Кнопки карточки прав в ленте после того, как карточка стала D-n по сроку
 * (решение 1): CLI вызова уже не ждёт, ответ уходит записи, а разрешение —
 * продолжением разговора с разовым правом. Номер берётся у брокера (в памяти,
 * этот запуск панели) или у записи по вызову (после перезапуска).
 * `undefined` — карточка не откладывалась, решает брокер как раньше.
 */
export async function answerDeferredFromCard(
  ctx: ServerContext,
  deferredIdOf: (chatId: string, toolUseId: string) => string | undefined,
  chatId: string,
  toolUseId: string,
  decision: { behavior: 'allow' | 'deny'; message?: string },
): Promise<DeferredDecisionResult | undefined> {
  const id =
    deferredIdOf(chatId, toolUseId) ?? deferredAsksOf(ctx).byToolUse([chatId], toolUseId)?.id;
  if (!id) return undefined;
  return decideDeferred(ctx, id, {
    behavior: decision.behavior,
    ...(decision.message ? { message: decision.message } : {}),
    via: 'web',
  });
}
