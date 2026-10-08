import type { ProviderDetection } from '@agentdeck/contracts';

/** Что показывает бейдж детекта у провайдера в селекторе. */
export type DetectionBadgeKind = 'installed' | 'configOnly' | 'missing';

export interface DetectionBadge {
  kind: DetectionBadgeKind;
  /** Ключ i18n подписи бейджа. */
  key: string;
  tone: 'success' | 'info' | 'neutral';
}

/**
 * Бейдж детекта: «установлен» (бинарь в PATH) → «конфиг найден» (бинаря нет, но
 * каталог/файл конфигурации есть) → «не найден». Пока детект не загружен —
 * `undefined`: бейдж не рисуем, чтобы селектор не мигал ложным «не найден».
 */
export function detectionBadge(
  detection: ProviderDetection | undefined,
): DetectionBadge | undefined {
  if (!detection) return undefined;
  if (detection.cliInstalled) {
    return { kind: 'installed', key: 'providerDetect.installed', tone: 'success' };
  }
  if (detection.configPresent) {
    return { kind: 'configOnly', key: 'providerDetect.configOnly', tone: 'info' };
  }
  return { kind: 'missing', key: 'providerDetect.missing', tone: 'neutral' };
}
