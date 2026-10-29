import { contourModelName } from './channels.ts';
import type { CliRunFacts } from './types.ts';

/** Kimi Code (Moonshot). Источник — каталог панели `providers/catalog/kimi.ts` до переезда. */
export const kimiRunFacts: CliRunFacts = {
  id: 'kimi',
  name: 'Kimi Code',
  status: 'experimental',
  binary: { command: 'kimi', windowsCommand: 'kimi.cmd' },
  // Подписка — после `/login` (OAuth), адрес `api.kimi.com/coding/v1`.
  login: 'account',
  // API Moonshot, совместимое с OpenAI. Адрес — из документации вендора (D1): Moonshot API
  // reference зовёт `https://api.moonshot.ai/v1/chat/completions` ключом `MOONSHOT_API_KEY`,
  // Kimi Code для `KIMI_API_KEY` называет тот же `https://api.moonshot.ai/v1`.
  vendorApi: {
    kind: 'openai-compat',
    keyVars: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    baseUrl: 'https://api.moonshot.ai/v1',
  },
  cliRunnable: true,
  channels: [
    // Модель целиком из окружения — `KIMI_MODEL_*` (документация «Environment variables»):
    // CLI заводит из них модель `__kimi_env_model__`, и она перебивает `default_model`
    // конфига; запрос идёт на `<адрес>/chat/completions` (живая проба 2.1.1).
    // `KIMI_BASE_URL`/`KIMI_API_KEY` — поля конфига, не переменные: не годятся.
    {
      via: 'env',
      form: 'run',
      dialect: 'openai-chat',
      keyVar: 'KIMI_MODEL_API_KEY',
      build: ({ baseUrl, model, key }) => ({
        KIMI_MODEL_PROVIDER_TYPE: 'openai',
        KIMI_MODEL_BASE_URL: baseUrl,
        KIMI_MODEL_API_KEY: key,
        KIMI_MODEL_NAME: contourModelName(model),
      }),
      // Вторая модель ходит своим провайдером, а переменной, перебивающей её, документация не
      // называет (`KIMI_SECONDARY_MODEL` в бинаре есть, в документации — нет).
      bypass: { setting: '[secondary_model] model' },
    },
  ],
  modelVendors: ['moonshotai'],
  // Лестницы нет: `-m` принимает имя записи из личной таблицы `models` человека.
};
