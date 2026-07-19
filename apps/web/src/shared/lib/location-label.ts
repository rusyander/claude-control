import type { ClaudeLocation } from '@claude-control/contracts';

/**
 * Человекочитаемая подпись, откуда взялся путь к конфигурации. Показывать
 * сырое значение source («home», «env») нельзя: это внутренний термин,
 * который ничего не говорит пользователю.
 */
export function sourceLabel(location: ClaudeLocation, t: (key: string) => string): string {
  if (!location.isValid) return t('overview.notFound');
  if (location.source === 'manual') return t('overview.detectedManual');
  if (location.source === 'env') return t('overview.detectedEnv');
  return t('overview.detectedAuto');
}
