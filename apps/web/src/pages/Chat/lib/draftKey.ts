import type { ChatSummary } from '@claude-control/contracts';
import { normalizeProjectPath } from '@shared/lib/workspace';

/**
 * Ключ контекста для черновиков поля ввода и пер-чат оверрайдов: у каждого
 * разговора, проекта и домашнего чата свой невыпущенный текст. Существующий
 * разговор ключуется по id, черновик проекта — по пути (он стабилен между
 * перезагрузками, в отличие от временного `new-…`).
 */
export function draftKeyFor(
  chat: ChatSummary | undefined,
  projectPath: string | undefined,
): string {
  if (chat) return `chat:${chat.id}`;
  if (projectPath) return `project:${normalizeProjectPath(projectPath)}`;
  return 'home';
}
