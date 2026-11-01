import { readBytesSync } from '../../platform/safe-io/files.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';

/**
 * JSON-файл звена: чтение с умолчанием и атомарная запись — замена `lib/safe-io` панели в
 * перенесённых модулях. Нет файла или он пуст — умолчание; мусор — исключение (решает
 * вызывающий: журнал сжатий начинает с чистого листа, учёт расхода — нет).
 */
export function readJsonFile<T>(path: string, fallback: T): T {
  const bytes = readBytesSync(path);
  if ('absent' in bytes) return fallback;
  if ('unknown' in bytes) throw new Error(`${path}: ${bytes.unknown}`);
  const text = bytes.value.toString('utf8');
  // BOM снимается: с ним `JSON.parse` падает на валидном файле.
  const raw = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!raw.trim()) return fallback;
  return JSON.parse(raw) as T;
}

export function writeJsonFile(path: string, data: unknown, _options: object = {}): void {
  writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
}
