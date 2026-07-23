import type { McpServer } from '@claude-control/contracts';

export interface ProjectMcpCardProps {
  server: McpServer;
  onToggle: (isEnabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting?: boolean;
}
