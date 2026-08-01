import type { ProviderCheckStep } from '@claude-control/contracts';
import type { ConfigProvider } from '../../providers/types.ts';
import { providerCliCandidates } from '../../providers/cli.ts';
import { findCliOnPath, pathExists } from '../../providers/detect.ts';
import { step } from './step.ts';
import type { ProviderCheckDeps } from './types.ts';

/** Шаги про окружение: есть ли бинарь CLI и лежат ли где-то его файлы. */

export function checkCli(provider: ConfigProvider, deps: ProviderCheckDeps): ProviderCheckStep {
  const found = findCliOnPath(providerCliCandidates(provider), deps.detectCli);
  if (found) return step('cli', 'pass', `Команда ${found} найдена в PATH.`);
  return step(
    'cli',
    'warn',
    'Бинарь CLI в PATH не найден. Разделы конфигурации от этого не ломаются — ограничен только запуск ассистента через CLI.',
  );
}

export function checkConfig(provider: ConfigProvider, deps: ProviderCheckDeps): ProviderCheckStep {
  const exists = deps.exists ?? pathExists;
  // Пути считаем в try: у Claude они резолвятся детектом расположения, который
  // на битом override может бросить — проверка от этого падать не должна.
  let paths: string[];
  try {
    paths = provider.configLocations?.(deps.claudeDirOverride) ?? [];
  } catch {
    paths = [];
  }
  if (paths.length === 0)
    return step('config', 'skipped', 'Расположение конфигурации у провайдера не объявлено.');

  const present = paths.filter((path) => exists(path));
  if (present.length === 0)
    return step(
      'config',
      'warn',
      `Ни один из путей конфигурации не найден (${paths.join(', ')}). Обычно они появляются после первого запуска CLI.`,
    );

  // Путь отдельным полем здесь не нужен: он уже перечислен в тексте, а строкой
  // ниже интерфейс показал бы его второй раз.
  return step('config', 'pass', `Конфигурация на месте: ${present.join(', ')}.`);
}
