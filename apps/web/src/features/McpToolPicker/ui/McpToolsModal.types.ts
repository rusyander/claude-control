import type { McpServer } from '@agentdeck/contracts';

export interface McpToolsModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  server: McpServer;
}
