import type { McpServer } from '@claude-control/contracts';

export interface ProjectMcpFormProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** id проекта — куда пишем .mcp.json. */
  projectId: string;
  /** Пусто — добавление нового сервера, иначе правка существующего. */
  server?: McpServer;
}
