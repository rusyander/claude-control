import type { McpHealth, McpServer } from '@claude-control/contracts';

export interface McpServerCardProps {
  server: McpServer;
  onToggle: (isEnabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting?: boolean;
}

/** Ответ проверки связи: сервер поднимается и опрашивается по протоколу MCP. */
export interface HealthResult {
  health: McpHealth;
  detail?: string;
  toolCount?: number;
}
