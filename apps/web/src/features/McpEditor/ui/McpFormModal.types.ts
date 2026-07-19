import type { McpServer } from '@claude-control/contracts';

export interface McpFormModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Пусто — добавление нового сервера, иначе правка существующего. */
  server?: McpServer;
}
