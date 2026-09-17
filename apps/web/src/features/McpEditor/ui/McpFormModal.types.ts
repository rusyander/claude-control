import type { McpServer } from '@agentdeck/contracts';

export interface McpFormModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Пусто — добавление нового сервера, иначе правка существующего. */
  server?: McpServer;
  /**
   * Открыто агентом панели на шаге секрета: над полями — пустые секреты
   * сервера отдельными полями пароля, обёртка помечена этим якорем.
   */
  secretAnchor?: string;
}
