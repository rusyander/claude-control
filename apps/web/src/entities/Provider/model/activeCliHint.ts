import type { ProviderDetectResponse } from '@agentdeck/contracts';
import { findDetection } from './detection';

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
