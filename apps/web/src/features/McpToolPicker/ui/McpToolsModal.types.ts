import type { McpServer } from '@claude-control/contracts';

export interface McpToolsModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  server: McpServer;
}
