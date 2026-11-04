import { CORE_PERMIT_TOOL } from '@agentdeck/contracts/chat-handoff';

type Translate = (key: string) => string;

/**
 * Подпись значка карточки прав: имя инструмента CLI (`Bash`, `Edit`) — как есть, это и есть суть
 * запроса. Вопрос права задачи ядра приходит под служебным именем `core-permit` — человеку оно
 * ничего не говорит, поэтому значок называет, кто спрашивает: ядро.
 */
export function permissionBadge(toolName: string, t: Translate): string {
  return toolName === CORE_PERMIT_TOOL ? t('chat.corePermitBadge') : toolName;
}
