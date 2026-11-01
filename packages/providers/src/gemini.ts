import type { CliRunFacts } from './types.ts';

/**
 * Gemini CLI. Источники — каталог панели `providers/catalog/gemini.ts` и
 * `providers/catalog/gemini-contour.ts` до переезда.
 */
export const geminiRunFacts: CliRunFacts = {
  id: 'gemini',
  name: 'Gemini CLI',
  status: 'experimental',
  binary: { command: 'gemini', windowsCommand: 'gemini.cmd' },
  // Вход Google-аккаунтом (и Vertex AI) — свои серверы CLI (`gemini-contour.ts`).
  login: 'account',
  // Адрес — корень хоста Gemini API из документации Google
  // (`https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`).
  vendorApi: {
    kind: 'google',
    keyVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    baseUrl: 'https://generativelanguage.googleapis.com',
  },
  cliRunnable: true,
  channels: [
    // `GOOGLE_GEMINI_BASE_URL` («Overrides the default base URL for Gemini API requests»),
    // модель — `GEMINI_MODEL`, ключ — `GEMINI_API_KEY`. Адрес gemini 0.62 читает только при
    // входе ключом API: иной способ входа ходит своими серверами, и переменной, которая его
    // перебила бы, нет (живая проба 07.10.2026).
    {
      via: 'env',
      form: 'vars',
      dialect: 'google-genai',
      baseUrlVar: 'GOOGLE_GEMINI_BASE_URL',
      modelVar: 'GEMINI_MODEL',
      keyVar: 'GEMINI_API_KEY',
      bypass: { setting: 'security.auth.selectedType', requires: 'gemini-api-key' },
    },
  ],
  // Аналога глубины у Gemini CLI нет — придумывать ему флаг нельзя.
  modelVendors: ['google'],
  // `flash-lite` и `flash` — младшие линейки, обе ниже `pro`, которой CLI работает по
  // умолчанию; верх у чужого CLI — его собственная настройка.
  modelLadder: ['gemini-flash-lite', 'gemini-flash'],
};
