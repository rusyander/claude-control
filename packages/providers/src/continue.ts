import type { CliRunFacts } from './types.ts';

/** Continue (`cn`). Источник — каталог панели `providers/catalog/continue.ts` до переезда. */
export const continueRunFacts: CliRunFacts = {
  id: 'continue',
  name: 'Continue',
  status: 'experimental',
  // Бинарь CLI — `cn` (пакет @continuedev/cli).
  binary: { command: 'cn', windowsCommand: 'cn.cmd' },
  // Модель, адрес и ключ — в `config.yaml` или в аккаунте Continue Hub.
  login: 'account',
  // Своего модельного API у Continue нет: прежний `anthropic` + `ANTHROPIC_API_KEY` молча
  // отвечал моделью Claude под именем Continue (SF-1).
  vendorApi: { kind: 'none', keyVars: [] },
  cliRunnable: true,
  channels: [
    // Адрес — поле `apiBase` конкретной модели в `config.yaml`; общей переменной нет.
    // `provider: openai` + `apiBase` — это путь `/chat/completions`.
    {
      via: 'file',
      dialect: 'openai-chat',
      format: 'continue-yaml',
      place: 'models[].apiBase',
      perSession: false,
    },
  ],
};
