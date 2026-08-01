import type { Plugin } from '@claude-control/contracts';

export interface CatalogRowProps {
  plugin: Plugin;
  isBusy: boolean;
  isInstalling: boolean;
  onInstall: () => void;
}
