import { contourModelName } from './channels.ts';
import type { CliRunFacts } from './types.ts';

/** Встроенные агенты OpenCode: у каждого своя модель, и каждый обязан смотреть на маршрут. */
const OPENCODE_AGENTS = ['build', 'plan', 'general', 'explore'];

/** OpenCode. Источник — каталог панели `providers/catalog/opencode.ts` до переезда. */
export const opencodeRunFacts: CliRunFacts = {
  id: 'opencode',
  name: 'OpenCode',
  status: 'experimental',
  binary: { command: 'opencode', windowsCommand: 'opencode.cmd' },
  // Шлюз ко многим вендорам: ключ настраивается на стороне OpenCode.
  login: 'cli-config',
  // Вид совместимый, но адреса нет намеренно (D1): чей это ключ, по нему не понять.
  vendorApi: { kind: 'openai-compat', keyVars: [] },
  cliRunnable: true,
  channels: [
    // `OPENCODE_CONFIG_CONTENT` — конфиг строкой, по документации старше глобального и
    // проектного. Провайдер `contour` — встроенный `@ai-sdk/openai-compatible`, и он
    // единственный разрешённый: модель по умолчанию, малая и модели встроенных агентов
    // смотрят туда. Без последних `agent.build.model` человека на выключенном провайдере
    // роняет прогон (UnknownError, живая проба). Ключ едет внутри конфига, не переменной.
    {
      via: 'env',
      form: 'run',
      dialect: 'openai-chat',
      build: ({ baseUrl, model, key }) => {
        const name = contourModelName(model);
        const ref = `contour/${name}`;
        const agent = Object.fromEntries(OPENCODE_AGENTS.map((id) => [id, { model: ref }]));
        return {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            provider: {
              contour: {
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL: baseUrl, apiKey: key },
                models: { [name]: {} },
              },
            },
            model: ref,
            small_model: ref,
            agent,
            enabled_providers: ['contour'],
          }),
        };
      },
    },
  ],
  // Собственный шлюз OpenCode Zen (models.dev, вендор `opencode`). Лестницы нет: шлюз ведёт
  // модели всех вендоров, ступень значила бы выбор вендора за человека.
  modelVendors: ['opencode'],
};
