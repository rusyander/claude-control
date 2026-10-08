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

/**
 * Добавление и правка MCP-сервера. Поля зависят от транспорта: у stdio это
 * команда с аргументами, у sse и http — адрес. Показывать всё сразу вредно:
 * половина полей окажется лишней и запутает.
 */
/** Пустой секрет сервера: в каком поле формы он лежит и под каким именем. */
export interface SecretSlot {
  field: 'env' | 'headers';
  key: string;
}
