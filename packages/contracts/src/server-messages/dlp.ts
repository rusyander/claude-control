/** Коды текстов сервера, раздел «dlp»: DLP-прокси и правила. Сборка всех — `../server-messages.ts`. */
export const dlpMessageParams = {
  'dlp-rules-list-expected': [],
  'dlp-text-field-expected': [],
  'dlp-rules-unparsed': ['reason'],
  'dlp-rules-schema-file': [],
  'dlp-rule-schema': ['rule'],
  'dlp-rules-schema': [],
  'dlp-upstream-missing': [],
  'dlp-upstream-unparsed': ['value'],
  'dlp-upstream-scheme': [],
  'dlp-no-rules': [],
} as const satisfies Record<string, readonly string[]>;
