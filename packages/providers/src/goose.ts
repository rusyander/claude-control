import { contourModelName } from './channels.ts';
import type { CliRunFacts } from './types.ts';

/**
 * Встроенный провайдер Goose, которым прогон идёт на адрес маршрута. Ведущая модель
 * (`GOOSE_LEAD_PROVIDER`) того же провайдера ходит тем же адресом — она обход не создаёт.
 */
export const GOOSE_RUN_PROVIDER = 'openai';

/** Goose (Block). Источник — каталог панели `providers/catalog/goose.ts` до переезда. */
export const gooseRunFacts: CliRunFacts = {
  id: 'goose',
  name: 'Goose',
  status: 'experimental',
  binary: { command: 'goose', windowsCommand: 'goose.cmd' },
  // Модель даёт провайдер, настроенный внутри Goose, ключ — в его связке ключей.
  login: 'cli-config',
  vendorApi: { kind: 'none', keyVars: [] },
  cliRunnable: true,
  channels: [
    // Провайдер `openai` целиком из окружения: справочник переменных Goose говорит, что
    // окружение перебивает `config.yaml`. Адрес делится на хост и путь (`OPENAI_BASE_PATH` —
    // без ведущей косой черты, с `chat/completions` на конце). Субагенты получают тот же
    // провайдер явно, иначе пошли бы провайдером из конфига (живая проба).
    {
      via: 'env',
      form: 'run',
      dialect: 'openai-chat',
      keyVar: 'OPENAI_API_KEY',
      build: ({ baseUrl, model, key }) => {
        const url = new URL(baseUrl);
        const name = contourModelName(model);
        return {
          GOOSE_PROVIDER: GOOSE_RUN_PROVIDER,
          GOOSE_MODEL: name,
          GOOSE_SUBAGENT_PROVIDER: GOOSE_RUN_PROVIDER,
          GOOSE_SUBAGENT_MODEL: name,
          OPENAI_HOST: url.origin,
          OPENAI_BASE_PATH: `${url.pathname.replace(/^\/+|\/+$/g, '')}/chat/completions`,
          OPENAI_API_KEY: key,
        };
      },
      // Ведущая модель другого провайдера (lead/worker) ушла бы своим ключом мимо адреса.
      bypass: { setting: 'GOOSE_LEAD_PROVIDER' },
    },
  ],
  // `--model` задокументирован только в паре с `--provider` — лестницы нет.
};
