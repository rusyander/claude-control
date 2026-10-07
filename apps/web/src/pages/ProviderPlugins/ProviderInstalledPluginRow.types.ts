import type { ProviderInstalledPlugin } from '@agentdeck/contracts';

export interface ProviderInstalledPluginRowProps {
  plugin: ProviderInstalledPlugin;
  /** Панель умеет менять установленное командами CLI (Qwen, Codex). */
  actions: boolean;
  /** Чем действие адресует строку: имя расширения Qwen, `имя@рынок` Codex. */
  actionId: string;
  /** Текст подтверждения удаления — у каждого CLI своё последствие. */
  uninstallConfirm: string;
}
