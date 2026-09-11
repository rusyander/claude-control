import type { PlatformDriverId } from '@agentdeck/contracts';
import type { PlatformDriver } from './driver.ts';
import { enterprise-platformDriver } from './enterprise-platform.ts';
import { openAiCompatDriver } from './openai-compat.ts';

/**
 * Реестр драйверов. Ветвление по платформе кончается здесь: дальше все
 * спрашивают возможности, а не имя контура.
 */
const DRIVERS: Record<PlatformDriverId, PlatformDriver> = {
  enterprise-platform: enterprise-platformDriver,
  'openai-compat': openAiCompatDriver,
};

/**
 * Драйвер по имени контура.
 *
 * Незнакомое имя — не выдумка типов, а обычная жизнь настроек: контур заведён
 * прежней версией панели, драйвер с тех пор переименован или убран, и в
 * `state.json` осталось имя, которого в реестре нет. Прежняя редакция отдавала
 * на это `undefined` с типом `PlatformDriver`, и первый же запрос падал на
 * `driver.readFrame` — то есть сломанной оказывалась не одна карточка, а весь
 * шлюз.
 *
 * Ответ — драйвер, который НИЧЕГО о контуре не утверждает (`openai-compat`):
 * незнакомое имя ровно это и значит. Подставить сюда драйвер конкретной
 * платформы значило бы приписать чужому шлюзу её вендорные кадры и коды.
 */
export function driverFor(id: PlatformDriverId): PlatformDriver {
  return DRIVERS[id] ?? openAiCompatDriver;
}

/**
 * Весь реестр списком — для набора соответствия (`conformance/`), который
 * обязан пройти КАЖДЫЙ драйвер. Перечисляется именно реестр, а не отдельный
 * список: иначе новый контур можно было бы зарегистрировать, не внеся в
 * таблицу, и он бы молча не проверялся ничем.
 */
export const allDrivers: PlatformDriver[] = Object.values(DRIVERS);

export type { PlatformDriver, DriverReading } from './driver.ts';
