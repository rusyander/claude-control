import type { ProviderPluginsInfo } from '@agentdeck/contracts';

/** Подзаголовок называет модель раздела: файлы+npm, показ установленного, расширения. */
export const SUBTITLE_BY_FORMAT = {
  'opencode-plugins': 'providerPlugins.subtitle',
  'kimi-plugins': 'providerPlugins.subtitleInstalled',
  'qwen-extensions': 'providerPlugins.subtitleExtensions',
  'codex-plugins': 'providerPlugins.subtitleCodex',
} as const satisfies Record<ProviderPluginsInfo['format'], string>;
