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

export function readEnvVars(settingsPath: string, secretsPath: string): EnvVar[] {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const fromSettings = Object.entries(settings.env ?? {}).map(([key, value]) =>
    toEnvVar(key, value, 'settings'),
  );

  return [...fromSettings, ...parseEnvFile(readTextFile(secretsPath))];
}

/** Полное значение — отдельным запросом, по явному действию пользователя. */
export function revealEnvValue(
  settingsPath: string,
  secretsPath: string,
  key: string,
  source: EnvVar['source'],
): string | undefined {
  if (source === 'settings') {
    return readJsonFile<RawSettings>(settingsPath, {}).env?.[key];
  }
  return parseEnvFile(readTextFile(secretsPath), false).find((item) => item.key === key)?.value;
}

export function saveEnvVar(
  settingsPath: string,
  secretsPath: string,
  draft: EnvVarDraft,
  backupDir?: string,
): string | undefined {
  if (draft.source === 'settings') {
    const settings = readJsonFile<RawSettings>(settingsPath, {});
    settings.env = { ...settings.env, [draft.key]: draft.value };
    return writeJsonFile(settingsPath, settings, { backupDir });
  }

  return upsertEnvFileLine(secretsPath, draft.key, draft.value, draft.comment, backupDir);
}

export function deleteEnvVar(
  settingsPath: string,
  secretsPath: string,
  key: string,
  source: EnvVar['source'],
  backupDir?: string,
): string | undefined {
  if (source === 'settings') {
    const settings = readJsonFile<RawSettings>(settingsPath, {});
    delete settings.env?.[key];
    return writeJsonFile(settingsPath, settings, { backupDir });
  }

  const lines = readTextFile(secretsPath).split(/\r?\n/);
  const kept = lines.filter((line) => !startsWithKey(line, key));
  return writeTextFile(secretsPath, kept.join('\n'), { backupDir });
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
