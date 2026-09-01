import type { ChatSummary } from '@claude-control/contracts';
import { normalizeProjectPath } from '@shared/lib/workspace';

/**
 * Какие разговоры показывать в боковом списке.
 *
 * Без открытого проекта это домашняя вкладка — там живёт песочница, и только
 * она: разговоры настоящих проектов ушли бы в общую кучу, из которой их не
 * разобрать.
 *
 * У открытого проекта — его собственные разговоры плюс те, что выделило из них
 * разделение задач. Последние живут в КОПИЯХ репозитория, то есть в других
 * каталогах, и по фильтру пути сюда бы не попали, — но человек ищет их там, где
 * согласился на разделение.
 *
 * Копий может и не быть: в проекте без git разделение заводит чаты В ТОМ ЖЕ
 * каталоге, и тогда они уже отобраны как свои. Без проверки такой разговор
 * попадал в список ДВАЖДЫ — та же строка, тот же ключ React, а дерево под
 * родителем оказывалось вдвое гуще, чем чатов на самом деле.
 */
export function visibleChats(all: ChatSummary[], activeProjectId?: string): ChatSummary[] {
  if (!activeProjectId) return all.filter((chat) => chat.isSandbox);

  const own = all.filter(
    (chat) => !chat.isSandbox && normalizeProjectPath(chat.projectPath) === activeProjectId,
  );

  const roots = new Set(own.map((chat) => chat.id));
  const children = all.filter(
    (chat) => chat.parentId && roots.has(chat.parentId) && !roots.has(chat.id),
  );

  return children.length > 0 ? [...own, ...children] : own;
}
