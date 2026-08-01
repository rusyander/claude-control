import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { ConfigProvider } from '../../../providers/types.ts';
import type { ProviderLocation } from '../locations.ts';
import { redactSecrets } from '../redact.ts';
import {
  isDotenvName,
  JUNK_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  PARTIAL_JSON,
  REDACTABLE_EXTENSIONS,
  SECRET_BASENAMES,
  SECRET_EXTENSIONS,
} from './rules.ts';
import type { CollectResult } from './types.ts';

/**
 * Судьба одного файла: взять целиком, взять частично, замаскировать значения
 * или не брать вовсе — с записью причины в `skipped`/`checklist`.
 */
export function takeFile(
  provider: ConfigProvider,
  location: ProviderLocation,
  relativePath: string,
  sourcePath: string,
  result: CollectResult,
): void {
  const name = basename(sourcePath).toLowerCase();
  const extension = extname(name);

  if (SECRET_BASENAMES.has(name) || SECRET_EXTENSIONS.has(extension)) {
    result.skipped.push({ sourcePath, reason: 'secret' });
    result.checklist.push({ source: sourcePath, keys: [], reason: 'secret-file' });
    return;
  }
  if (JUNK_EXTENSIONS.has(extension)) {
    result.skipped.push({ sourcePath, reason: 'excluded' });
    return;
  }

  let size: number;
  try {
    size = statSync(sourcePath).size;
  } catch {
    result.skipped.push({ sourcePath, reason: 'unreadable' });
    return;
  }
  if (size > MAX_FILE_BYTES) {
    result.skipped.push({ sourcePath, reason: 'too-large' });
    return;
  }
  if (result.totalBytes + size > MAX_TOTAL_BYTES) {
    result.skipped.push({ sourcePath, reason: 'archive-full' });
    return;
  }

  let raw: Buffer;
  try {
    raw = readFileSync(sourcePath);
  } catch {
    result.skipped.push({ sourcePath, reason: 'unreadable' });
    return;
  }

  // Файл переменных окружения: сами значения — секреты, поэтому в архив он не
  // едет, а его ключи становятся пунктами чек-листа.
  if (isDotenvName(name)) {
    const keys = dotenvKeys(raw.toString('utf8'));
    result.skipped.push({ sourcePath, reason: 'secret' });
    if (keys.length > 0) result.checklist.push({ source: sourcePath, keys, reason: 'env-file' });
    return;
  }

  const partial = PARTIAL_JSON[provider.id];
  const isPartial =
    partial !== undefined && location.role === partial.role && extension === '.json';

  let data = raw;
  let redactedKeys: string[] = [];
  if (isPartial) {
    const reduced = keepJsonKeys(raw.toString('utf8'), partial.keys);
    if (!reduced) {
      result.skipped.push({ sourcePath, reason: 'unreadable' });
      return;
    }
    const cleaned = redactSecrets(name, reduced);
    data = Buffer.from(cleaned.text, 'utf8');
    redactedKeys = cleaned.keys;
  } else if (REDACTABLE_EXTENSIONS.has(extension)) {
    const cleaned = redactSecrets(name, raw.toString('utf8'));
    // Заменять было нечего — везём ИСХОДНЫЕ байты. Пересборка ради ничего
    // меняла бы форматирование и переводы строк, и на новой машине такой файл
    // выглядел бы отличающимся, хотя отличий по сути нет.
    if (cleaned.keys.length > 0) {
      data = Buffer.from(cleaned.text, 'utf8');
      redactedKeys = cleaned.keys;
    }
  }

  if (redactedKeys.length > 0) {
    result.checklist.push({ source: sourcePath, keys: redactedKeys, reason: 'redacted' });
  }

  result.files.push({
    archivePath: `files/loc-${location.index}/${relativePath}`,
    locationIndex: location.index,
    relative: relativePath,
    sourcePath,
    applyMode: isPartial ? 'json-merge' : 'file',
    ...(isPartial ? { mergeKeys: partial.keys } : {}),
    bytes: data.length,
    sha256: sha256(data),
    redactedKeys,
    data,
  });
  result.totalBytes += data.length;
}

/** Имена переменных из dotenv-файла. Значения не читаем и никуда не кладём. */
function dotenvKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) keys.push(match[1]);
  }
  return [...new Set(keys)];
}

/** Оставляет в JSON только перечисленные ключи верхнего уровня. */
function keepJsonKeys(text: string, keys: string[]): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

  const source = parsed as Record<string, unknown>;
  const reduced: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) reduced[key] = source[key];
  }
  return `${JSON.stringify(reduced, null, 2)}\n`;
}

/** Отпечаток содержимого — по нему импорт отличает «то же самое» от «другое». */
export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
