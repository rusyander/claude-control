import type { Plugin } from '@agentdeck/contracts';

export interface CatalogRowProps {
  plugin: Plugin;
  isBusy: boolean;
  isInstalling: boolean;
  onInstall: () => void;
}
