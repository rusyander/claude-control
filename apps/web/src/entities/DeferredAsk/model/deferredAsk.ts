import type { DeferredAskView } from '@agentdeck/contracts/deferred-asks';
import { OPEN_STATES } from './deferredAsk.constants';

/** Записи, на которые человек может ответить: ждущие первыми, потом истёкшие. */
export function openAsks(items: readonly DeferredAskView[]): DeferredAskView[] {
  const open = items.filter((item) => (OPEN_STATES as readonly string[]).includes(item.state));
  return [
    ...open.filter((item) => item.state === 'waiting'),
    ...open.filter((item) => item.state !== 'waiting'),
  ];
}

/** Сколько записей ждёт человека — число на плашке. Истёкшие не считаются. */
export function waitingCount(items: readonly DeferredAskView[]): number {
  return items.filter((item) => item.state === 'waiting').length;
}

/** Записи групп одного разделения — хаб родителя показывает только свои. */
export function asksOfParent(
  items: readonly DeferredAskView[],
  parentChatId: string,
): DeferredAskView[] {
  return items.filter(
    (item) => item.scope.kind === 'group' && item.scope.parentChatId === parentChatId,
  );
}

/**
 * Ключ фильтра «чья запись»: группа — по номеру внутри разделения, чат — по
 * ключу разговора. Один ключ на одного владельца, чтобы фишка фильтра считала
 * записи группы вместе, из какого бы её звена они ни пришли.
 */
export function ownerKey(item: DeferredAskView): string {
  return item.scope.kind === 'group'
    ? `group:${item.scope.parentChatId}:${item.scope.groupIndex}`
    : `chat:${item.scope.chatKeys[0] ?? item.chatId ?? item.id}`;
}
