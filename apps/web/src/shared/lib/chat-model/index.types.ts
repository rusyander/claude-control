/** Причина отказа или ухода мимо контура — ключ словаря и имя настройки CLI. */
export interface PlatformRefusalParams {
  title: string;
  reason: 'gateway_down' | 'no_token' | 'cli_config_bypass';
  /** Настройка конфига CLI (`cli_config_bypass`); у остальных причин пусто. */
  setting: string;
}
