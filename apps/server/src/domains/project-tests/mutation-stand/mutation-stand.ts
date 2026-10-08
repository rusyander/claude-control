import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coded } from '../../../lib/server-text/server-text.ts';
import { redactor } from '../env-secrets/env-secrets.ts';
import { standEnv } from '../e2e-run/e2e-run.ts';
import { ProjectTestsError } from '../files.ts';
import { readEnvironments } from '../library/library.ts';
import { pickEnvironmentId, type RunSecretsResolver } from '../runs/runs.ts';

/**
 * Стенд для ветки e2e проверки поломкой (Ф8). Автотесты e2e ходят в стенд:
 * без его адреса и доступов они падают ВСЕ, и каждое падение читалось бы как
 * «поломка поймана». Поэтому без стенда проверка отвечает «не проверено», а
 * не гоняет набор вслепую. Окружение выбирается так же, как у прогона e2e
 * раздела (`e2e-run.ts`): явное или окружение по умолчанию.
 */

const PLAYWRIGHT_CONFIGS = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];

/**
 * Конфиг Playwright сам поднимает приложение (`webServer`) — стенд ему не нужен:
 * адрес он знает сам, и прогон без окружения честный.
 */
function servesItself(cwd: string): boolean {
  return PLAYWRIGHT_CONFIGS.some((name) => {
    const path = join(cwd, name);
    try {
      return existsSync(path) && /\bwebServer\s*:/.test(readFileSync(path, 'utf8'));
    } catch {
      return false;
    }
  });
}

export interface MutationStand {
  env: Record<string, string>;
  /** Затирает значения доступов в выводе команды. */
  hide: (text: string) => string;
}

export function mutationStand(input: {
  root: string;
  /** Каталог запуска команды в копии — там лежит конфиг каркаса. */
  cwd: string;
  environmentId?: string;
  secrets?: RunSecretsResolver;
}): MutationStand {
  const environments = readEnvironments(input.root);
  const id = pickEnvironmentId(environments, input.environmentId);
  const environment = environments.find((item) => item.id === id);
  const secrets = input.secrets?.(environment) ?? { values: {}, missing: [] };
  if (secrets.missing.length > 0) {
    throw coded(
      new ProjectTestsError('Not verified: stand access values are missing on this machine.'),
      'mutation-no-secrets',
      { names: secrets.missing.map((ref) => ref.name).join(', ') },
    );
  }
  const stand = standEnv(environment);
  if (Object.keys(stand).length === 0 && !servesItself(input.cwd)) {
    throw coded(new ProjectTestsError('Not verified: no stand address.'), 'mutation-no-stand');
  }
  return {
    env: { ...secrets.values, ...stand },
    hide: redactor(secrets.values) ?? ((text) => text),
  };
}
