export function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * Окно контекста человеческим числом: `1000000` → `1M`, `200000` → `200K`.
 * Пусто, если источник лимита не знает, — выдумывать нечего.
 */
export function formatContext(tokens: number | undefined): string {
  if (!tokens || tokens <= 0) return '';
  if (tokens >= 1_000_000) return `${round(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${round(tokens / 1_000)}K`;
  return String(tokens);
}
