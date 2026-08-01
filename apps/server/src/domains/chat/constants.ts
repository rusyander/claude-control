/** Размер окна ленты по умолчанию — последние N сообщений разговора. */
export const DEFAULT_MESSAGE_PAGE = 400;

/** Верхняя граница окна: больше за один запрос отдавать незачем. */
export const MAX_MESSAGE_PAGE = 5000;

/** Целое из строки запроса с зажимом в границы; мусор → значение по умолчанию. */
export function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
