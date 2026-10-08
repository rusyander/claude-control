import type { AssistantOption } from './assistant-fields.types';

/**
 * Найти вариант по ответу модели: точное значение, затем то же без учёта
 * регистра, затем подпись — последние два только когда совпадение одно.
 */
export function matchOption(options: readonly AssistantOption[], raw: string): string | undefined {
  const text = raw.trim();
  const exact = options.find((option) => option.value === text);
  if (exact) return exact.value;
  const lower = text.toLowerCase();
  const unique = (hits: readonly AssistantOption[]): string | undefined =>
    hits.length === 1 ? hits[0]?.value : undefined;
  return (
    unique(options.filter((option) => option.value.toLowerCase() === lower)) ??
    unique(options.filter((option) => option.label?.trim().toLowerCase() === lower))
  );
}
