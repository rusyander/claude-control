import type { ProviderDetection, ProviderDetectResponse } from '@claude-control/contracts';

/**
 * Детект установленных провайдер-CLI (Ф7) — ЧИСТАЯ логика вида.
 *
 * Сервер отдаёт по каждому провайдеру две независимые вещи: найден ли бинарь в
 * PATH (`cliInstalled`) и есть ли каталог/файл конфигурации (`configPresent`).
 * Здесь это превращается в бейджи селектора, рекомендацию дефолта и
 * неалармирующую подсказку — БЕЗ вызова i18n и без React, чтобы всё покрывалось
 * обычным тестом (тесты фронта идут в node-окружении, без DOM).
 *
 * ВАЖНО: детект — ПОДСКАЗКА, а не принуждение. Провайдер здесь не переключается
 * никогда: функции лишь возвращают, что показать. Дефолт остаётся `claude`.
 */

/** Ключ перевода с параметрами — перевод вызывает уже компонент. */
export interface TextKey {
  key: string;
  params?: Record<string, unknown>;
}

/** Что показывает бейдж детекта у провайдера в селекторе. */
export type DetectionBadgeKind = 'installed' | 'configOnly' | 'missing';

export interface DetectionBadge {
  kind: DetectionBadgeKind;
  /** Ключ i18n подписи бейджа. */
  key: string;
  tone: 'success' | 'info' | 'neutral';
}

/** Дефолтный провайдер панели — его рекомендуем, когда он установлен. */
const DEFAULT_PROVIDER_ID = 'claude';

/** Детект по конкретному провайдеру (или `undefined`, пока не загружено). */
export function findDetection(
  data: ProviderDetectResponse | undefined,
  providerId: string,
): ProviderDetection | undefined {
  return data?.providers.find((item) => item.id === providerId);
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

/** Провайдеры с реально установленным CLI — их перечисляет онбординг. */
export function installedProviders(data: ProviderDetectResponse | undefined): ProviderDetection[] {
  return (data?.providers ?? []).filter((item) => item.cliInstalled);
}

/**
 * Кого рекомендовать: если установлен `claude` — его (проверенный дефолт),
 * иначе первый установленный из списка. Ничего не установлено → `undefined`
 * (рекомендовать нечего). Автопереключения провайдера НЕТ — только бейдж.
 */
export function recommendedProviderId(
  data: ProviderDetectResponse | undefined,
): string | undefined {
  const installed = installedProviders(data);
  const claude = installed.find((item) => item.id === DEFAULT_PROVIDER_ID);
  return (claude ?? installed[0])?.id;
}

/**
 * Неалармирующая подсказка, когда CLI АКТИВНОГО провайдера не найден в системе:
 * разделы конфигурации при этом работают, а вот ассистент/запуск потребуют
 * установки CLI либо API-ключа. Если CLI найден (или детект не загружен) —
 * подсказки нет.
 */
export function activeCliHint(data: ProviderDetectResponse | undefined): TextKey | undefined {
  if (!data) return undefined;
  const active = findDetection(data, data.active);
  if (!active || active.cliInstalled) return undefined;
  return {
    key: 'providerDetect.activeMissing',
    params: { provider: active.name, command: active.cliCommand },
  };
}
