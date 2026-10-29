import type { CliRunFacts } from './types.ts';

/** Codex (OpenAI). Источник — каталог панели `providers/catalog/codex.ts` до переезда. */
export const codexRunFacts: CliRunFacts = {
  id: 'codex',
  name: 'Codex (OpenAI)',
  status: 'experimental',
  binary: { command: 'codex', windowsCommand: 'codex.cmd' },
  // Вход учётной записью ChatGPT — отказ CLI «…when using Codex with a ChatGPT account»
  // (`domains/provider-chat/cascade/cheap-deliver.ts`).
  login: 'account',
  vendorApi: { kind: 'openai', keyVars: ['OPENAI_API_KEY'] },
  cliRunnable: true,
  channels: [
    // Адрес — не переменной окружения, а таблицей `model_providers` в `config.toml`
    // (провайдер с `base_url`/`wire_api`, выбирается корневым `model_provider`). Ручка —
    // `/responses`: `wire_api = "chat"` codex больше не принимает и с таким конфигом не
    // стартует вовсе (живая проба 22.09.2026, `codex-cli 0.155.1`).
    {
      via: 'file',
      dialect: 'openai-responses',
      format: 'codex-toml',
      place: 'model_providers',
      perSession: false,
    },
  ],
  // Единственный аналог глубины среди чужих CLI — ключ конфига на запуск
  // `-c model_reasoning_effort=<low|medium|high>`. Кавычек из примеров документации нет:
  // их снимает оболочка, а argv уходит без неё.
  effort: { argv: ['-c', 'model_reasoning_effort={effort}'], values: ['low', 'medium', 'high'] },
  modelVendors: ['openai'],
  // Обе ступени — модели самого Codex: младшая (быстрая) кодовая и старшая. Флагман общего
  // назначения не берём — подбор понижает, а не меняет линейку.
  modelLadder: ['gpt-codex-spark', 'gpt-codex'],
};
