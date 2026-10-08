import type { PanelAgentPageContext } from '@agentdeck/contracts/panel-agent';

/**
 * Контекст, уходящий с каждым сообщением: где человек и какой проект у него
 * выбран. Адрес — с запросом (`/settings?tab=prompts`): вкладка тоже место.
 * Пустые поля не отправляем — схема сервера их не ждёт.
 */
export function buildPageContext(input: {
  pathname: string;
  searchStr?: string;
  title?: string;
  projectPath?: string;
}): PanelAgentPageContext {
  const search = input.searchStr && input.searchStr !== '?' ? input.searchStr : '';
  return {
    route: `${input.pathname}${search}`,
    ...(input.title ? { title: input.title } : {}),
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
  };
}
