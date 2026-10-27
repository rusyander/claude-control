import { isAbsolute } from 'node:path';
import { readJson } from '../files.ts';
import type { SuiteEnvEntry, SuiteEnvRead } from './suite-env.types.ts';

export type { SuiteEnvEntry, SuiteEnvRead } from './suite-env.types.ts';

/**
 * Окружение набора — поле `env` в `.agent/tests/automation.json` (M2, g5 27.10).
 *
 * У монорепозитория на Go `go.sum` вне git, и копия набора inst-auth собирается только с
 * `GOFLAGS=-modfile=…`: рецепт жил в блокноте группы, `run --stale` о нём не знал, и
 * пять красных записей легли в историю из-за окружения, а не кода. Теперь рецепт —
 * в конфиге проекта, рядом с командой: ключ — каталог от корня (`.` — весь проект),
 * значение — переменные. Кейс получает переменные всех ключей, под которыми лежит
 * его `automation.file`; одна переменная в двух ключах — берётся из более узкого.
 * `{copy}` в значении — корень копии (на `--base` — исходной: файлы вне git лежат там).
 */

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE = 4000;

/** Прочитать `env` из automation.json. Нет файла или поля — пусто, это обычный случай. */
export function readSuiteEnv(root: string): SuiteEnvRead {
  const { data, error } = readJson(root, 'automation.json');
  if (error) return { entries: [], error };
  const env = (data as { env?: unknown } | undefined)?.env;
  if (env === undefined) return { entries: [] };
  return parseSuiteEnv(env);
}

export function parseSuiteEnv(env: unknown): SuiteEnvRead {
  if (!env || typeof env !== 'object' || Array.isArray(env))
    return {
      entries: [],
      error: '«env» — объект: каталог от корня → { ПЕРЕМЕННАЯ: "значение" }.',
    };
  const entries: SuiteEnvEntry[] = [];
  for (const [rawKey, rawVars] of Object.entries(env)) {
    const path = normalDir(rawKey);
    if (path === undefined)
      return {
        entries: [],
        error: `Ключ «${rawKey}» в «env» — не каталог от корня проекта (без «..» и абсолютного пути).`,
      };
    if (!rawVars || typeof rawVars !== 'object' || Array.isArray(rawVars))
      return { entries: [], error: `«env» → «${rawKey}» — объект переменных.` };
    const vars: Record<string, string> = {};
    for (const [name, value] of Object.entries(rawVars)) {
      if (!VAR_NAME.test(name))
        return { entries: [], error: `«env» → «${rawKey}»: «${name}» — не имя переменной.` };
      if (typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > MAX_VALUE)
        return {
          entries: [],
          error: `«env» → «${rawKey}» → «${name}»: значение — одна строка до ${MAX_VALUE} символов.`,
        };
      vars[name] = value;
    }
    entries.push({ path, vars });
  }
  return { entries };
}

/** `./inst-auth\\` → `inst-auth`; корень — `''`; путь наружу — `undefined`. */
function normalDir(key: string): string | undefined {
  const parts = key
    .trim()
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.');
  if (isAbsolute(key.trim()) || /^[A-Za-z]:/.test(key.trim()) || parts.includes('..'))
    return undefined;
  return parts.join('/');
}

/** Ключ покрывает файл: корень — любой, каталог — сам он и всё под ним. */
function covers(dir: string, file: string): boolean {
  const path = file.split(/[\\/]+/).join('/');
  return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

/**
 * Переменные файла кейса: ключи от широкого к узкому, узкий перекрывает. `{copy}` — в
 * корень копии. Что взято откуда — `from` (каталоги), для строки вывода.
 */
export function suiteEnvFor(
  entries: readonly SuiteEnvEntry[],
  file: string,
  copy: string,
): { vars: Record<string, string>; from: string[] } {
  const vars: Record<string, string> = {};
  const from: string[] = [];
  const matching = entries
    .filter((entry) => covers(entry.path, file))
    .sort((a, b) => a.path.length - b.path.length);
  for (const entry of matching) {
    from.push(entry.path || '.');
    for (const [name, value] of Object.entries(entry.vars))
      vars[name] = value.replaceAll('{copy}', copy);
  }
  return { vars, from };
}
