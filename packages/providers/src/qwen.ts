import type { CliRunFacts } from './types.ts';

/**
 * Qwen Code. Источники — каталог панели `providers/catalog/qwen.ts` до переезда,
 * `domains/provider-chat/system-note/system-note.ts` (пределы локальной модели) и
 * `domains/groups/qwen-layer/qwen-layer.ts` (файл настроек на прогон).
 */
export const qwenRunFacts: CliRunFacts = {
  id: 'qwen',
  name: 'Qwen Code',
  status: 'experimental',
  binary: { command: 'qwen', windowsCommand: 'qwen.cmd' },
  // Вход Qwen OAuth — способ `qwen-oauth` (`domains/provider-chat/economy-run/qwen.ts`).
  login: 'account',
  // API — совместимое с OpenAI; у ModelStudio/DashScope ключ `DASHSCOPE_API_KEY`.
  vendorApi: { kind: 'openai-compat', keyVars: ['OPENAI_API_KEY', 'DASHSCOPE_API_KEY'] },
  cliRunnable: true,
  // Документированы ДВА протокола сразу, оба CLI берёт и из `.env`. Порядок — порядок видов
  // API у панели (совместимый первым).
  channels: [
    {
      via: 'env',
      form: 'vars',
      dialect: 'openai-chat',
      baseUrlVar: 'OPENAI_BASE_URL',
      modelVar: 'OPENAI_MODEL',
      keyVar: 'OPENAI_API_KEY',
    },
    {
      via: 'env',
      form: 'vars',
      dialect: 'anthropic-messages',
      baseUrlVar: 'ANTHROPIC_BASE_URL',
      modelVar: 'ANTHROPIC_MODEL',
      keyVar: 'ANTHROPIC_API_KEY',
    },
  ],
  modelVendors: ['alibaba'],
  // Лестницы нет намеренно: семейство `qwen` мешает `flash`, `plus` и `max`, и «свежайшая в
  // семействе» завтра стала бы повышением. По той же причине нет и `modelRungs`: ранга моделей
  // Qwen Code факты не знают, а флага глубины у него нет — лестницы уровня ядра у Qwen нет.
  //
  // Окно и сроки локальной модели (L4b, бандл 0.25.0): `model.generationConfig` файла
  // системных настроек, путь которого принимает `QWEN_CODE_SYSTEM_SETTINGS_PATH`.
  limitsChannel: {
    via: 'settings-file',
    fileVar: 'QWEN_CODE_SYSTEM_SETTINGS_PATH',
    path: ['model', 'generationConfig'],
    keys: { window: 'contextWindowSize', timeout: 'timeout', idle: 'streamIdleTimeoutMs' },
  },
};
