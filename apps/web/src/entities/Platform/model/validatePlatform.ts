import type { Platform } from '@agentdeck/contracts';
import {
  platformIdPattern,
  isPlatformDay,
  platformTransportErrors,
  defaultPlatformTransport,
  platformManifestError,
} from '@agentdeck/contracts';

/** Какие поля черновика не пройдут схему. Ключ — имя поля, значение — код ошибки. */
export type PlatformFieldError = 'required' | 'pattern' | 'url';

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validatePlatform(
  draft: Platform,
): Partial<Record<keyof Platform, PlatformFieldError>> {
  const errors: Partial<Record<keyof Platform, PlatformFieldError>> = {};
  if (!draft.title.trim()) errors.title = 'required';
  if (!draft.id.trim()) errors.id = 'required';
  else if (!platformIdPattern.test(draft.id)) errors.id = 'pattern';
  const url = draft.baseUrl.trim();
  if (!url) errors.baseUrl = 'required';
  else if (!isHttpUrl(url)) errors.baseUrl = 'url';
  // Дата периода бюджета — та же проверка, что и в схеме, и проверяется не
  // только вид: дни учёта сравниваются посимвольно, «01.09.2026» не отказало
  // бы, а тихо отрезало весь расход, а `2026-13-45` по виду проходит, но такого
  // дня нет — итог тот же. Отказ на форме объясняет это до сохранения.
  if (!isPlatformDay(draft.budgetSince.trim())) errors.budgetSince = 'pattern';
  // Подробности (какое поле и почему) форма берёт из `platformTransportErrors`
  // сама; здесь — только то, что сохранять такое нельзя.
  if (platformTransportErrors(draft.transport ?? defaultPlatformTransport()).length > 0) {
    errors.transport = 'pattern';
  }
  // Переопределения пресета — та же проверка, что в двери сохранения сервера.
  if (platformManifestError(draft.manifest)) errors.manifest = 'pattern';
  return errors;
}
