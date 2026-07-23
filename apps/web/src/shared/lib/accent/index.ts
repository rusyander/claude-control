import { accentSchema, type Accent } from '@claude-control/contracts';

/**
 * Порядок пресетов акцента для селектора в настройках. Берётся прямо из
 * `accentSchema.options`, а не переписан руками: добавили пресет в контракт —
 * он сам появится в UI, и рассинхрон невозможен. `default` идёт первым как
 * базовый акцент темы.
 */
export const ACCENT_OPTIONS: readonly Accent[] = accentSchema.options;

/** Ключ перевода подписи пресета акцента. */
export function accentLabelKey(accent: Accent): string {
  return `settings.accent_${accent}`;
}
