import type { EnvItemKind, EnvSkip } from '@agentdeck/contracts/portable-env';
import type { NestedServerMessage } from '@agentdeck/contracts/server-messages';
import { UNRECOGNIZED_FORMAT_TEXT } from '../../lib/format-errors.ts';
import { envSkip, readerTextCode } from './canon.ts';
import { nested } from './intent-codes.ts';
import type { ImportResult } from './types.ts';

/**
 * Нечитаемый источник не роняет паспорт.
 *
 * Читатель раздела, который бросил (битый JSON в `settings.json`, отказ ОС),
 * раньше ронял весь импорт: человек получал ошибку вместо паспорта, хотя
 * инструкции, скиллы и команды лежали в других файлах и читались. Теперь каждый
 * раздел читается под этой обёрткой: бросил — его виды названы пропуском
 * `not_readable` с файлом и причиной, остальные разделы паспорта на месте.
 */
export function guardSection(
  kinds: readonly EnvItemKind[],
  where: string,
  read: () => ImportResult,
): ImportResult {
  try {
    return read();
  } catch (error) {
    return { items: [], skipped: kinds.map((kind) => unreadableSection(kind, where, error)) };
  }
}

/** Причины без цитаты файла: строка сервера рядом со своим кодом. */
const CAUSE_TEXT = {
  'portability-cause-not-json': 'файл не разбирается как JSON',
  'portability-cause-unparsed': 'содержимое файла не разбирается',
} as const;

function codedCause(code: keyof typeof CAUSE_TEXT): { text: string; cause: NestedServerMessage } {
  return { text: CAUSE_TEXT[code], cause: nested(code) };
}

/** Пропуск «раздел не прочитан» — где искали и почему не прочитали. */
export function unreadableSection(kind: EnvItemKind, where: string, error: unknown): EnvSkip {
  const { text, cause } = causeOf(error);
  return envSkip(
    kind,
    'not_readable',
    `${where}: раздел не прочитан — ${text}`,
    'portability-skip-section-unreadable',
    { where, cause },
  );
}

/**
 * Причина отказа: русская фраза для `detail` и то же — кодом для экрана.
 *
 * Текст разборщика наружу НЕ идёт: `JSON.parse`, TOML и YAML цитируют строки
 * файла, а рядом в настройках живут ключи API — паспорт вынес бы то, что сам
 * бережно не показывает. Поэтому: `SyntaxError` (разбор JSON) — своя фраза;
 * фраза сервера (общий отказ формата, шаблон `serverText`) узнаётся по тексту и
 * едет кодом; отказ ОС (`EACCES`, `EISDIR`…) несёт только путь и код ошибки —
 * едет как есть; всё прочее — «содержимое не разбирается» без цитаты.
 * Вложенный код несёт только плоские подстановки: глубже схема не принимает.
 */
function causeOf(error: unknown): { text: string; cause: string | NestedServerMessage } {
  if (error instanceof SyntaxError) return codedCause('portability-cause-not-json');
  const text = error instanceof Error ? error.message : String(error);
  // Общий отказ формата говорит «только для чтения» — про запись, не про паспорт.
  if (text === UNRECOGNIZED_FORMAT_TEXT) return unparsed();
  const { detailCode, detailParams } = readerTextCode(text);
  if (detailCode) {
    const flat: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(detailParams ?? {})) {
      if (typeof value === 'object') return unparsed();
      if (value !== undefined) flat[key] = value;
    }
    return { text, cause: nested(detailCode, detailParams ? flat : undefined) };
  }
  return isSystemError(error) || SYSTEM_TEXT.test(text) ? { text, cause: text } : unparsed();
}

/** Текст отказа ОС, уже снятый с ошибки читателем раздела (`info.error`): `EACCES: …`. */
const SYSTEM_TEXT = /^E[A-Z]+: /;

function unparsed(): { text: string; cause: NestedServerMessage } {
  return codedCause('portability-cause-unparsed');
}

/** Отказ файловой системы: у него строковый `code` вида `EACCES`, а текст — путь и код. */
function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === 'string' &&
    /^E[A-Z]+$/.test((error as NodeJS.ErrnoException).code ?? '')
  );
}
