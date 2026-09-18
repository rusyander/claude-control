/** Коды текстов сервера, раздел «system»: Система, место конфигурации, удалённый доступ. Сборка всех — `../server-messages.ts`. */
export const systemMessageParams = {
  'analytics-pricing-refresh-failed': ['failure'],
  'endpoint-profile-not-found': [],
  'value-too-long': [],
  'remote-settings-invalid': [],
  'remote-device-invalid': [],
  'remote-device-token-unspecified': [],
  'location-not-found': [],
  'location-dir-missing': ['dir'],
  'location-is-file': ['dir'],
  'location-dir-unavailable': ['dir'],
  'location-dir-unreadable': ['dir'],
  'location-app-data-failed': ['detail', 'root'],
} as const satisfies Record<string, readonly string[]>;
