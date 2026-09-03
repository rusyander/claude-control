import type { UniversalMcpServer, UniversalMcpServerDraft } from '@claude-control/contracts';

export interface ProviderMcpFormProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Имя CLI — для подсказки «изменения применятся после перезапуска …». */
  providerName: string;
  server?: UniversalMcpServer;
  /**
   * Сохранение: черновик, прежнее имя сервера (при правке) и колбэк «готово»
   * (форма закроется). Мутации задаёт вызывающая страница — так одна форма
   * обслуживает и глобальный раздел провайдера, и проектный уровень (COMMON-2).
   */
  onSave: (
    draft: UniversalMcpServerDraft,
    serverId: string | undefined,
    onDone: () => void,
  ) => void;
  isPending: boolean;
  isError: boolean;
}
