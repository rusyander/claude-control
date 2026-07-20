import type { EnvVar, EnvVarDraft } from '@claude-control/contracts';
import { readTextFile, writeTextFile, readJsonFile, writeJsonFile } from '../lib/safe-io.ts';

/**
 * Переменные окружения живут в двух местах: settings.json → env (их видит сам
 * Claude Code) и .mcp-secrets.env (их читает лаунчер MCP-серверов). Работаем
 * с обоими, но по-разному: json — структурой, env-файл — построчно, сохраняя
 * комментарии, потому что в них записано, где брать каждый токен.
 */

/** По имени ключа решаем, прятать ли значение за маской. */
const SECRET_HINT = /(TOKEN|SECRET|KEY|PASSWORD|PAT|CREDENTIAL)/i;

interface RawSettings {
  env?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Переменные из обоих файлов настроек и из файла секретов. Локальные помечены
 * источником: Claude Code их применяет, а панель — только показывает.
 */
export function readEnvVars(
  settingsPath: string,
  secretsPath: string,
  settingsLocalPath?: string,
): EnvVar[] {
  const fromSettings = readSettingsEnv(settingsPath, 'settings');
  const fromLocal = settingsLocalPath ? readSettingsEnv(settingsLocalPath, 'settings-local') : [];

  return [...fromSettings, ...fromLocal, ...parseEnvFile(readTextFile(secretsPath))];
}

function readSettingsEnv(path: string, source: EnvVar['source']): EnvVar[] {
  const settings = readJsonFile<RawSettings>(path, {});
  return Object.entries(settings.env ?? {}).map(([key, value]) => toEnvVar(key, value, source));
}

/** Полное значение — отдельным запросом, по явному действию пользователя. */
export function revealEnvValue(
  settingsPath: string,
  secretsPath: string,
  key: string,
  source: EnvVar['source'],
  settingsLocalPath?: string,
): string | undefined {
  if (source === 'settings') {
    return readJsonFile<RawSettings>(settingsPath, {}).env?.[key];
  }
  // Локальную переменную показать можно — это чтение; запись в этот файл
  // закрыта, а прятать значение, которое лежит открытым текстом рядом,
  // смысла нет.
  if (source === 'settings-local') {
    return settingsLocalPath
      ? readJsonFile<RawSettings>(settingsLocalPath, {}).env?.[key]
      : undefined;
  }
  return parseEnvFile(readTextFile(secretsPath), false).find((item) => item.key === key)?.value;
}

/** Имена переменных, уже лежащих в settings.json → env. */
export function existingEnvKeys(settingsPath: string): string[] {
  return Object.keys(readJsonFile<RawSettings>(settingsPath, {}).env ?? {});
}

/**
 * Применить и снять переменные группы в settings.json одним заходом. `set` —
 * ключи со значениями, которые группа добавляет; `remove` — ключи, которые она
 * снимает (когда их больше никто не держит). Возвращает путь резервной копии.
 */
export function applyGroupEnv(
  settingsPath: string,
  set: Record<string, string>,
  remove: string[],
  backupDir?: string,
): string | undefined {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const env = { ...settings.env };
  for (const [key, value] of Object.entries(set)) env[key] = value;
  for (const key of remove) delete env[key];
  settings.env = env;
  return writeJsonFile(settingsPath, settings, { backupDir });
}

/**
 * Запись переменной. Локальная уходит в свой файл: панель показывает оба и
 * правит каждый на месте — переезд в общий конфиг сделал бы личную настройку
 * общей, чего никто не просил.
 */
export function saveEnvVar(
  settingsPath: string,
  secretsPath: string,
  draft: EnvVarDraft,
  backupDir?: string,
  settingsLocalPath?: string,
): string | undefined {
  if (draft.source === 'settings-local') {
    if (!settingsLocalPath) throw new Error('Не задан путь к settings.local.json');

    const local = readJsonFile<RawSettings>(settingsLocalPath, {});
    local.env = { ...local.env, [draft.key]: draft.value };
    return writeJsonFile(settingsLocalPath, local, { backupDir });
  }

  if (draft.source === 'settings') {
    const settings = readJsonFile<RawSettings>(settingsPath, {});
    settings.env = { ...settings.env, [draft.key]: draft.value };
    return writeJsonFile(settingsPath, settings, { backupDir });
  }

  if (draft.source === 'secrets') {
    return upsertEnvFileLine(secretsPath, draft.key, draft.value, draft.comment, backupDir);
  }

  // source === 'group' — служебный: env групп применяется маршрутами групп
  // (applyGroupEnv), а не через /api/env. Прямая запись сюда — ошибка вызова;
  // молча свалить переменную в .mcp-secrets.env (ветка секретов по умолчанию)
  // нельзя, поэтому ничего не пишем.
  return undefined;
}

export function deleteEnvVar(
  settingsPath: string,
  secretsPath: string,
  key: string,
  source: EnvVar['source'],
  backupDir?: string,
  settingsLocalPath?: string,
): string | undefined {
  if (source === 'settings-local') {
    if (!settingsLocalPath) throw new Error('Не задан путь к settings.local.json');

    const local = readJsonFile<RawSettings>(settingsLocalPath, {});
    delete local.env?.[key];
    return writeJsonFile(settingsLocalPath, local, { backupDir });
  }

  if (source === 'settings') {
    const settings = readJsonFile<RawSettings>(settingsPath, {});
    delete settings.env?.[key];
    return writeJsonFile(settingsPath, settings, { backupDir });
  }

  if (source === 'secrets') {
    return deleteSecretLine(secretsPath, key, backupDir);
  }

  // source === 'group' — служебный, см. saveEnvVar: не наша забота.
  return undefined;
}

/**
 * Удаляет строку `KEY=…` из env-файла вместе с прилегающим сверху блоком
 * комментариев: он привязан к переменной (см. parseEnvFile) и описывает, где
 * брать именно этот токен. Осиротев, комментарий копит мусор и вводит в
 * заблуждение, поэтому уходит вместе с переменной.
 */
function deleteSecretLine(path: string, key: string, backupDir?: string): string | undefined {
  const lines = readTextFile(path).split(/\r?\n/);
  const index = lines.findIndex((line) => startsWithKey(line, key));
  if (index === -1) return writeTextFile(path, lines.join('\n'), { backupDir });

  // Забираем и непрерывный блок комментариев прямо над переменной (до пустой
  // строки или не-комментария) — ровно то, что parseEnvFile привязал к ней.
  let start = index;
  while (start > 0 && (lines[start - 1]?.trim().startsWith('#') ?? false)) start -= 1;

  lines.splice(start, index - start + 1);
  return writeTextFile(path, lines.join('\n'), { backupDir });
}

/**
 * Разбор env-файла. Комментарий, стоящий над переменной, привязываем к ней:
 * в этом файле комментарии объясняют, где выпускать каждый токен.
 */
function parseEnvFile(content: string, mask = true): EnvVar[] {
  const result: EnvVar[] = [];
  let pendingComment: string[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      pendingComment = [];
      continue;
    }
    if (line.startsWith('#')) {
      pendingComment.push(line.replace(/^#\s?/, ''));
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    result.push(toEnvVar(key, value, 'secrets', pendingComment.join(' ') || undefined, mask));
    pendingComment = [];
  }

  return result;
}

function toEnvVar(
  key: string,
  value: string,
  source: EnvVar['source'],
  comment?: string,
  mask = true,
): EnvVar {
  const isSecret = SECRET_HINT.test(key);
  return {
    id: `${source}:${key}`,
    key,
    value: isSecret && mask ? maskValue(value) : value,
    isSecret,
    source,
    comment,
  };
}

/** Показываем начало и хвост: этого хватает, чтобы отличить один токен от другого. */
function maskValue(value: string): string {
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}${'•'.repeat(Math.min(12, value.length - 8))}${value.slice(-4)}`;
}

/** Обновляет строку в env-файле на месте, сохраняя порядок и комментарии. */
function upsertEnvFileLine(
  path: string,
  key: string,
  value: string,
  comment: string | undefined,
  backupDir?: string,
): string | undefined {
  const lines = readTextFile(path).split(/\r?\n/);
  const index = lines.findIndex((line) => startsWithKey(line, key));

  if (index >= 0) lines[index] = `${key}=${value}`;
  else {
    if (lines.at(-1)?.trim() !== '') lines.push('');
    if (comment) lines.push(`# ${comment}`);
    lines.push(`${key}=${value}`);
  }

  return writeTextFile(path, lines.join('\n'), { backupDir });
}

function startsWithKey(line: string, key: string): boolean {
  const trimmed = line.trim();
  return !trimmed.startsWith('#') && trimmed.startsWith(`${key}=`);
}
