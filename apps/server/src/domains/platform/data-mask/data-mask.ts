import type { Platform, PlatformDataMask } from '@agentdeck/contracts';
import { dataMaskDecision } from '@agentdeck/dlp/data-mask';
import { maskRulesFor } from '@agentdeck/dlp/default-rules';
import type { PlatformDriver } from '../drivers/driver.ts';

/**
 * Маска данных на пути через контур (Р11, 15.09.2026) — одно решение на шлюз и
 * карточку. Два расчёта разошлись бы молча: карточка обещала бы маску, а запрос
 * уходил бы открытым, — ровно та болезнь, которую `chooseRunModel` лечил в Т6.
 */

/** Контур объявил подмену данных — строка его манифеста. */
export function declaresAnonymization(driver: PlatformDriver): boolean {
  return driver.controls.some((control) => control.id === 'anonymization');
}

/**
 * Маскировать ли запрос. Общий выключатель раздела сильнее выбора на контуре:
 * человек, включивший защиту данных для всего, не должен узнать, что одна
 * карточка её тихо сняла.
 */
export function dataMaskOn(platform: Platform, driver: PlatformDriver, globalOn: boolean): boolean {
  return dataMaskDecision({
    globalOn,
    choice: platform.dataMask,
    declared: declaresAnonymization(driver),
  }).on;
}

export function describeDataMask(
  platform: Platform,
  driver: PlatformDriver,
  globalOn: boolean,
  appDataDir: string,
): PlatformDataMask {
  const declared = declaresAnonymization(driver);
  // Само решение — в `@agentdeck/dlp/data-mask`: его же спрашивает хост звеньев ядра.
  const { on, reason } = dataMaskDecision({ globalOn, choice: platform.dataMask, declared });
  const rules = maskRulesFor(appDataDir);
  return {
    on,
    reason,
    declared,
    rules: rules.source,
    count: 'rules' in rules ? rules.rules.length : 0,
  };
}
