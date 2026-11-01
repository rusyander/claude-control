import type { CliRunFacts } from './types.ts';

/** Aider. Источник — каталог панели `providers/catalog/aider.ts` до переезда. */
export const aiderRunFacts: CliRunFacts = {
  id: 'aider',
  name: 'Aider',
  status: 'experimental',
  binary: { command: 'aider', windowsCommand: 'aider.cmd' },
  // Модель и ключ — опции его же `.aider.conf.yml` (`model`, `api-key`) или окружение.
  login: 'cli-config',
  // Прямой вызов — только ключом OpenAI и только в OpenAI: своего API у Aider нет, а
  // «совместимый» вид отдал бы ключ неизвестно чьему серверу.
  // Адрес — из документации OpenAI API (`https://api.openai.com/v1/chat/completions`).
  vendorApi: { kind: 'openai', keyVars: ['OPENAI_API_KEY'], baseUrl: 'https://api.openai.com/v1' },
  cliRunnable: true,
  channels: [
    // Свои имена под собственным префиксом: `AIDER_OPENAI_API_BASE` («Specify the api base
    // url»), `AIDER_MODEL` и переменная ключа с тем же префиксом. Anthropic-адреса в
    // справочнике переменных нет.
    {
      via: 'env',
      form: 'vars',
      dialect: 'openai-chat',
      baseUrlVar: 'AIDER_OPENAI_API_BASE',
      modelVar: 'AIDER_MODEL',
      // Без приставки litellm внутри Aider не знает, куда слать запрос, и падает до модели
      // (живая проба 12.10.2026, aider 0.86.2).
      modelPrefix: 'openai/',
      keyVar: 'AIDER_OPENAI_API_KEY',
    },
  ],
  // Оболочка поверх любой модели: ни вендора, ни лестницы.
};
