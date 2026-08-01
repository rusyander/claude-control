import { existsSync, readFileSync, statSync } from 'node:fs';
import { detectTextForm, stripBom, type TextForm } from '../text-form.ts';

/** Выше этого размера форму файла не определяем — запись идёт как есть. */
const MAX_FORM_PROBE_BYTES = 4 * 1024 * 1024;

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return fallback;
  // BOM снимаем: с ним `JSON.parse` падает на совершенно валидном файле
  // (Блокнот/PowerShell пишут settings.json именно так) — это уводило бы раздел
  // в fail-closed на здоровом конфиге. Сам BOM при записи вернётся (см. writeTextFile).
  return JSON.parse(stripBom(raw)) as T;
}

export function readTextFile(path: string, fallback = ''): string {
  // Тоже без BOM: иначе он утекал бы в редактор инструкций как невидимый символ
  // в начале текста и «прилипал» бы вторым при каждом сохранении.
  return existsSync(path) ? stripBom(readFileSync(path, 'utf8')) : fallback;
}

/**
 * Форма существующего файла (BOM + переводы строк) — или `undefined`, если файла
 * нет либо он неправдоподобно велик (форму не гадаем и не читаем гигабайты).
 */
export function readTextForm(path: string): TextForm | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_FORM_PROBE_BYTES) return undefined;
    return detectTextForm(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Проверка, что строка — валидный JSON. Используется до записи, чтобы не портить конфиг. */
export function assertValidJson(raw: string): void {
  try {
    JSON.parse(stripBom(raw));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Невалидный JSON: ${detail}`, { cause: error });
  }
}
