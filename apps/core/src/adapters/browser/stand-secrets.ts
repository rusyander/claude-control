import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { environmentSecretsKey } from '@agentdeck/keys/environment-keys';
import { readKeyStrict } from '@agentdeck/keys/provider-keys';
import type {
  EnvironmentsRead,
  StandEnvironment,
  StandSecretMiss,
  StandSecrets,
  StandSecretValue,
} from './browser.types.ts';

/**
 * Доступы стенда для прохода (R2, P178). Имена доступов лежат в `environments.json` блока «Тесты»
 * проекта (он в git — там только имена), значения — зашифрованы в хранилище панели под ключом
 * `environmentSecretsKey(корень, окружение)` строкой JSON `{ИМЯ: значение}`; пишет их панель
 * (`env-secrets.ts` сервера), ядро только читает.
 *
 * Значение отдаётся только тому окружению, чей `baseUrl` того же источника, что открытая страница:
 * пароль стенда A не уедет в форму сайта B, даже если модель попросит. Хранилище не прочиталось —
 * отказ `secret-unreadable`, а не «секрета нет» (P44): иначе проход шёл бы дальше без входа.
 */

const ENVIRONMENTS = ['.agent', 'tests', 'environments.json'] as const;

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** Окружения проекта; файла нет — `absent`, файл не JSON — `unknown` с причиной. */
export function readStandEnvironments(root: string): EnvironmentsRead {
  const path = join(root, ...ENVIRONMENTS);
  if (!existsSync(path)) return { absent: true };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { unknown: (error as Error).message };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { unknown: 'environments.json is not JSON' };
  }
  const raw = (data as { environments?: unknown } | null)?.environments;
  if (!Array.isArray(raw)) return { value: [] };
  const environments: StandEnvironment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id) continue;
    const secrets = Array.isArray(record.secrets)
      ? record.secrets
          .map((s) => (s && typeof s === 'object' ? (s as { name?: unknown }).name : undefined))
          .filter((n): n is string => typeof n === 'string' && n !== '')
      : [];
    environments.push({
      id: record.id,
      ...(typeof record.baseUrl === 'string' ? { baseUrl: record.baseUrl } : {}),
      ...(record.archived === true ? { archived: true } : {}),
      secrets,
    });
  }
  return { value: environments };
}

const miss = (refused: StandSecretMiss['refused'], message: string): StandSecretMiss => ({
  refused,
  message,
});

export function createStandSecrets(panelAppData: string | null | undefined): StandSecrets {
  return {
    read(roots, name, pageUrl): StandSecretValue | StandSecretMiss {
      if (!panelAppData) {
        return miss('secret-unwired', 'stand secrets are not wired to this core (no panel data)');
      }
      if (roots.length === 0) {
        return miss('secret-no-project', `no project folder on this task to look up ${name} in`);
      }
      const origin = originOf(pageUrl);
      if (!origin) {
        return miss(
          'secret-not-for-this-page',
          `open the stand page first: ${name} is given only to its own stand`,
        );
      }
      const unreadable: string[] = [];
      let listed = false;
      for (const root of roots) {
        const read = readStandEnvironments(root);
        if ('unknown' in read) {
          unreadable.push(read.unknown);
          continue;
        }
        if ('absent' in read) continue;
        for (const env of read.value) {
          if (env.archived || !env.baseUrl || originOf(env.baseUrl) !== origin) continue;
          if (!env.secrets.includes(name)) continue;
          listed = true;
          let raw: string | undefined;
          try {
            raw = readKeyStrict(panelAppData, environmentSecretsKey(root, env.id));
          } catch (error) {
            const code = (error as { code?: string }).code ?? 'unreadable';
            return miss('secret-unreadable', `the panel key store could not be read (${code})`);
          }
          const value = valueOf(raw, name);
          if (typeof value === 'object') {
            return miss(
              'secret-unreadable',
              `the stored secrets of environment ${env.id} are not JSON`,
            );
          }
          if (value !== undefined) return { value, environmentId: env.id };
        }
      }
      if (listed) {
        return miss(
          'secret-missing',
          `${name} has no value on this machine: set it in Tests > Environments`,
        );
      }
      if (unreadable.length > 0) {
        return miss('secret-unreadable', `environments.json could not be read: ${unreadable[0]}`);
      }
      return miss(
        'secret-not-for-this-page',
        `no environment of this project with base URL ${origin} lists ${name}`,
      );
    },
  };
}

/** Значение имени из записи окружения; запись не JSON-объект — отметка, а не строка-пароль. */
function valueOf(raw: string | undefined, name: string): string | undefined | { garbage: true } {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { garbage: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { garbage: true };
  const value = (parsed as Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
