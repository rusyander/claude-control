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
};
