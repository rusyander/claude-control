import type { McpServer } from '@agentdeck/contracts';

export interface McpFormModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Пусто — добавление нового сервера, иначе правка существующего. */
  server?: McpServer;
}
