import type { McpServer } from '@agentdeck/contracts';

export interface ProjectMcpCardProps {
  server: McpServer;
  onToggle: (isEnabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting?: boolean;
}
