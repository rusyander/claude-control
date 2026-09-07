import type { LinkScopeOption } from './IntegrationLinkModal.types';

export interface IntegrationLinksBarProps {
  projectPath: string | undefined;
  /** Группы тестов проекта; пусто — привязывать можно только сам проект. */
  scopes?: LinkScopeOption[];
  /** Какую область открывать в окне привязки по умолчанию. */
  activeScope?: string;
}
