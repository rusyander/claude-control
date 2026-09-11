import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readJsonFile } from '../../../lib/safe-io.ts';
import { readContinueModels } from '../../../lib/continue-yaml.ts';
import { parseCodexToml } from '../../../lib/codex-toml.ts';
import { getProvider } from '../../../providers/registry.ts';
import { readProviderEnvVars, resolveProviderEnvTargetFor } from '../../provider-env.ts';
import type { ContourTarget, ContourTargetPaths } from './targets.ts';
import { contourEntryName } from './targets.ts';

/**
 * Что стоит в чужом конфиге ПРЯМО СЕЙЧАС.
 *
 * Нужно двум разным вопросам, и оба про честность: «занято ли место» (тогда
 * панель показывает конфликт и требует явного выбора вместо тихой перезаписи) и
 * «тот ли это файл, каким мы его оставили» (тогда откат имеет право его
 * трогать). Второе считается отпечатком: сравнивать по времени изменения
 * бессмысленно — его меняет и наша собственная запись.
 */

/** sha1 файла; файла нет — пустая строка (это тоже состояние, а не ошибка). */
export function fingerprintOf(filePath: string): string {
  if (!filePath || !existsSync(filePath)) return '';
  return createHash('sha1').update(readFileSync(filePath)).digest('hex');
}

interface ClaudeSettingsEnv {
  env?: Record<string, string>;
}

/** Текущие значения переменных цели: имя → значение. Файла нет — пусто. */
export function readCurrentEnv(
  target: ContourTarget,
  paths: ContourTargetPaths,
): Map<string, string> {
  const write = target.write;
  if (write?.kind !== 'endpoint-env') return new Map();

  if (write.providerId === 'claude') {
    const settings = readJsonFile<ClaudeSettingsEnv>(paths.claudeSettings, {});
    return new Map(Object.entries(settings.env ?? {}));
  }

  const envTarget = resolveProviderEnvTargetFor(getProvider(write.providerId), paths.override);
  if (!envTarget) return new Map();
  return new Map(readProviderEnvVars(envTarget).map((item) => [item.key, item.value] as const));
}

/**
 * Текущие значения файловой цели в тех же ключах, что показывает план
 * (`model_providers.<имя>.base_url`, `models[<имя>].apiBase`). Файл не
 * разбирается — считаем, что занятого места нет: отказ произойдёт при записи,
 * fail-closed, и там он с внятным кодом, а не в предпросмотре.
 */
export function readCurrentFileValues(
  target: ContourTarget,
  platformId: string,
): Map<string, string> {
  const write = target.write;
  if (write?.kind !== 'endpoint-file' || !existsSync(write.filePath)) return new Map();

  const name = contourEntryName(platformId);
  const values = new Map<string, string>();
  const text = readFileSync(write.filePath, 'utf8');

  try {
    if (write.file.format === 'codex-toml') {
      const parsed = parseCodexToml(text);
      const root = parsed.model_provider;
      if (typeof root === 'string') values.set('model_provider', root);

      const region = parsed.model_providers;
      const entry =
        region && typeof region === 'object' && !Array.isArray(region)
          ? (region as Record<string, unknown>)[name]
          : undefined;
      if (entry && typeof entry === 'object') {
        for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
          if (typeof value === 'string') values.set(`model_providers.${name}.${key}`, value);
        }
      }
      return values;
    }

    const entry = readContinueModels(text).find((item) => item.name === name);
    for (const [key, value] of Object.entries(entry ?? {})) {
      if (typeof value === 'string') values.set(`models[${name}].${key}`, value);
    }
    return values;
  } catch {
    return new Map();
  }
}
