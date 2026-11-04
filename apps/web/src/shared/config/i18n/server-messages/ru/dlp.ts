import type { DlpMessageCode } from '@agentdeck/contracts/server-messages';

export const dlpRu: Record<DlpMessageCode, string> = {
  'dlp-rules-list-expected': 'Ожидается список правил.',
  'dlp-text-field-expected': 'Ожидается поле text.',
  'dlp-rules-unparsed': 'файл правил не разбирается ({{reason}})',
  'dlp-rules-schema-file': 'файл правил не соответствует схеме',
  'dlp-rule-schema': '{{rule}}: не соответствует схеме',
  'dlp-rules-schema': 'правила не соответствуют схеме',
  'dlp-upstream-missing': 'не задан адрес, куда пересылать запросы',
  'dlp-upstream-unparsed': 'адрес «{{value}}» не разбирается',
  'dlp-upstream-scheme': 'адрес должен начинаться с http:// или https://',
  'dlp-no-rules': 'нет ни одного включённого правила',
  'dlp-core-missing': 'ядро не найдено ({{reason}})',
  'dlp-core-unverified': 'строка ядра не сверена ({{reason}})',
  'dlp-core-unverified-bare': 'строка ядра не сверена',
  'dlp-core-http': 'ядро ответило {{status}} на {{path}}',
  'dlp-core-down': 'Защиту данных держит ядро, а оно не отвечает: {{reason}}',
  'dlp-core-port-waiting': 'порт занят',
  'dlp-core-port-busy': 'порт {{port}} занят ({{reason}})',
  'dlp-core-listener-silent': 'нет ответа слушателя',
};
