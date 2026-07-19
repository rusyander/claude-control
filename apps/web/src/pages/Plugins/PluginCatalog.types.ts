import type { Plugin } from '@agentdeck/contracts';

export interface PluginCatalogProps {
  plugins: Plugin[];
  isLoading: boolean;
  isBusy: boolean;
  /** Какой плагин ставится прямо сейчас — у его кнопки крутится индикатор. */
  installingId?: string;
  onInstall: (id: string) => void;
}
