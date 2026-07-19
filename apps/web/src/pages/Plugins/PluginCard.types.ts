import type { Plugin } from '@claude-control/contracts';

export interface PluginCardProps {
  plugin: Plugin;
  onToggle: (isEnabled: boolean) => void;
  onUninstall: () => void;
  onUpdate: () => void;
  isBusy?: boolean;
}
