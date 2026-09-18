import type { SystemMessageCode } from '@agentdeck/contracts/server-messages';

export const systemRu: Record<SystemMessageCode, string> = {
  'analytics-pricing-refresh-failed': 'Не удалось обновить прайс: {{failure}}',
  'endpoint-profile-not-found': 'Профиль своего эндпоинта не найден.',
  'value-too-long': 'Значение превышает допустимую длину.',
  'remote-settings-invalid': 'Настройки заданы неверно',
  'remote-device-invalid': 'Устройство описано неверно',
  'remote-device-token-unspecified': 'Не указан токен устройства',
  'location-not-found':
    'Каталог .claude не найден автоматически. Укажите путь к нему вручную в настройках приложения.',
  'location-dir-missing': 'Каталог не существует: {{dir}}',
  'location-is-file': 'Это файл, а не каталог: {{dir}}',
  'location-dir-unavailable': 'Каталог недоступен: {{dir}}',
  'location-dir-unreadable': 'Нет прав на чтение каталога: {{dir}}',
  'location-app-data-failed': 'Каталог данных панели в {{root}} не создаётся: {{detail}}',
};
