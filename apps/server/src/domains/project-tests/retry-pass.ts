import type { ProjectTestPointResult, ProjectTestRetryPass } from '@agentdeck/contracts';

/**
 * «Зелёный только на повторе» — полем, а не заметкой.
 *
 * Прежде импорт писал в заметку прохода и кейса русскую фразу «Нестабильный:
 * прошёл только на повторе (упавших попыток: N).», и английский интерфейс
 * показывал её как есть: это были данные, а не текст панели. Теперь у прохода
 * число `flakyAttempts`, у кейса `flaky {attempts, runId}`, а слова — в словаре
 * каждой стороны. Записи, сделанные раньше, читаются тем же полем: фраза панели
 * узнаётся целиком (ровно два её вида), чужая заметка со словом «нестабильный»
 * остаётся заметкой.
 */
const LEGACY_NOTE = /^Нестабильный: прошёл только на повторе(?: \(упавших попыток: (\d+)\))?\.$/;

/**
 * Число упавших попыток из старой фразы панели; не она — `undefined`. Фраза без
 * числа (отчёт назвал тест нестабильным, но попыток не приложил) — `1`: повтор
 * был хотя бы один, иначе раннер не назвал бы его так.
 */
export function legacyRetryAttempts(note: string | undefined): number | undefined {
  const match = note ? LEGACY_NOTE.exec(note.trim()) : null;
  if (!match) return undefined;
  const count = Number(match[1] ?? 1);
  return Number.isInteger(count) && count > 0 ? count : 1;
}

/** Поле кейса из файла: число попыток — целое больше нуля, иначе поля нет. */
export function parseRetryPass(raw: unknown): ProjectTestRetryPass | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { attempts, runId } = raw as { attempts?: unknown; runId?: unknown };
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1) return undefined;
  return typeof runId === 'string' && runId ? { attempts, runId } : { attempts };
}

/** Проход из старой записи прогона: фраза панели в заметке — числом попыток. */
export function withLegacyRetry(result: ProjectTestPointResult): ProjectTestPointResult {
  // Чужой файл истории может нести в `results` что угодно — не объект идёт как есть.
  if (!result || typeof result !== 'object') return result;
  const legacy = legacyRetryAttempts(typeof result.note === 'string' ? result.note : undefined);
  if (legacy === undefined) return result;
  const { note: _phrase, ...rest } = result;
  return { ...rest, flakyAttempts: result.flakyAttempts ?? legacy };
}
