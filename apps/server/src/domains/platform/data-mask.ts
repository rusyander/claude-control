import type { Platform, PlatformDataMask } from '@agentdeck/contracts';
import { maskRulesFor } from '../dlp/default-rules.ts';
import type { PlatformDriver } from './drivers/driver.ts';

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
  return globalOn || (platform.dataMask ?? declaresAnonymization(driver));
}

export function describeDataMask(
  platform: Platform,
  driver: PlatformDriver,
  globalOn: boolean,
  appDataDir: string,
): PlatformDataMask {
  const declared = declaresAnonymization(driver);
  const byContour = platform.dataMask ?? declared;
  const on = globalOn || byContour;
  const reason: PlatformDataMask['reason'] = byContour
    ? platform.dataMask === undefined
      ? 'declared'
      : 'chosen'
    : globalOn
      ? 'global'
      : platform.dataMask === false
        ? 'chosen'
        : 'none';
  const rules = maskRulesFor(appDataDir);
  return {
    on,
    reason,
    declared,
    rules: rules.source,
    count: 'rules' in rules ? rules.rules.length : 0,
  };
}
