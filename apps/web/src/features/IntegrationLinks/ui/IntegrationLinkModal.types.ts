export interface LinkScopeOption {
  /** Пустая строка — сам проект, иначе id группы тестов. */
  id: string;
  title: string;
}

export interface IntegrationLinkModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  projectPath: string | undefined;
  /** Проект и его группы: к чему можно привязать внешний контекст. */
  scopes: LinkScopeOption[];
  /** Что открыть сразу — например, активную вкладку группы. */
  initialScope?: string;
}
