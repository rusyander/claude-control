import type {
  Platform,
  PlatformDriverBase,
  PlatformDriverId,
  PlatformManifestOverrides,
} from '@agentdeck/contracts';
import {
  platformDrivers,
  platformManifestOf,
  platformPreset,
} from '@agentdeck/contracts/platform-presets';
import type { DriverControl, PlatformDriver } from './driver.ts';
import { buildEnterprisePlatformDriver, enterprisePlatformDriver } from './enterprise-platform.ts';
import { openAiCompatDriver } from './openai-compat.ts';

/**
 * Реестр драйверов. Ветвление по платформе кончается здесь: дальше все
 * спрашивают возможности, а не имя контура.
 *
 * Кода у драйверов два набора — у платформы компании и у совместимого шлюза. Всё прочее —
 * пресеты-данные из контракта (DRV-03) и переопределения самого контура: они
 * накладываются на код базы здесь, в одном месте, и дальше по панели едет уже
 * собранный драйвер. Второй сборки нигде нет: проба, шлюз, картинки и план
 * применения спрашивают один и тот же ответ.
 */
const BASES: Record<PlatformDriverBase, PlatformDriver> = {
  'enterprise-platform': enterprisePlatformDriver,
  'openai-compat': openAiCompatDriver,
};

/**
 * Правило размышлений по объявленному полю. Своё у базы (платформа компании) сохраняет
 * подписи и меняет только поле; у базы без него правило появляется с подписью,
 * которая называет провод, — ничего сверх объявленного.
 */
function withThinkingField(controls: DriverControl[], path: string): DriverControl[] {
  const rest = controls.filter((control) => control.field !== 'enableThinking');
  if (!path) return rest;
  const own = controls.find((control) => control.field === 'enableThinking');
  const control: DriverControl = own
    ? { ...own, wireField: path }
    : {
        id: 'enable_thinking',
        title: 'Размышления модели',
        kind: 'request',
        field: 'enableThinking',
        wireField: path,
        detail: `включить или выключить полем «${path}»; по умолчанию не отправляется, решает шаблон модели`,
      };
  return [...rest, control];
}

/**
 * Данные поверх кода. Отсутствующее поле не трогает драйвер, пустая строка
 * снимает объявленное: так и пресет, и человек могут сказать «у этого шлюза
 * ручки нет», не заводя для этого нового значения.
 */
/**
 * Префикс вендорных полей поверх собранного драйвера. Меняется всё, что
 * называется префиксом, — разбор кадров, поля цельного ответа, правила на
 * проводе, — а подписи и прочие переопределения остаются как были.
 */
function withVendorPrefix(driver: PlatformDriver, prefix: string): PlatformDriver {
  const old = driver.vendorPrefix;
  if (old === undefined || old === prefix) return driver;
  const rebuilt = buildEnterprisePlatformDriver(prefix);
  return {
    ...driver,
    vendorPrefix: prefix,
    readFrame: rebuilt.readFrame,
    vendorFields: rebuilt.vendorFields,
    controls: driver.controls.map((control) =>
      control.id.startsWith(`${old}_`)
        ? { ...control, id: `${prefix}_${control.id.slice(old.length + 1)}` }
        : control,
    ),
  };
}

function applyManifest(driver: PlatformDriver, patch: PlatformManifestOverrides): PlatformDriver {
  let next: PlatformDriver = { ...driver };
  if (patch.vendorPrefix !== undefined) next = withVendorPrefix(next, patch.vendorPrefix);
  if (patch.clientTools) next.clientTools = patch.clientTools;
  if (patch.effort !== undefined) next.effort = patch.effort;
  if (patch.anthropicMessages !== undefined) {
    if (patch.anthropicMessages) next.anthropic = { messages: patch.anthropicMessages };
    else delete next.anthropic;
  }
  if (patch.imagesApi !== undefined) {
    next.images = patch.imagesApi ? { api: patch.imagesApi } : 'none';
  }
  if (patch.nonStreamTimeoutSec !== undefined) {
    if (patch.nonStreamTimeoutSec > 0) next.nonStreamTimeoutSec = patch.nonStreamTimeoutSec;
    else delete next.nonStreamTimeoutSec;
  }
  if (patch.responseCeilingSec !== undefined) {
    if (patch.responseCeilingSec > 0) next.responseCeilingSec = patch.responseCeilingSec;
    else delete next.responseCeilingSec;
  }
  if (patch.thinkingField !== undefined) {
    next.controls = withThinkingField(next.controls, patch.thinkingField);
  }
  return next;
}

function composePreset(id: PlatformDriverId): PlatformDriver {
  const preset = platformPreset(id);
  const base = BASES[preset.base];
  return applyManifest(
    { ...base, id, title: preset.title, ...(preset.auth ? { auth: preset.auth } : {}) },
    preset.manifest,
  );
}

const PRESETS = new Map<string, PlatformDriver>(
  platformDrivers.map((id) => [id, composePreset(id)]),
);

/**
 * Драйвер по имени пресета и переопределениям контура.
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
 *
 * Переопределения читаются поле за полем: негодное поле из записи, правленной
 * руками, значит «как у пресета», а не сломанный шлюз.
 */
export function driverFor(id: string, overrides?: unknown): PlatformDriver {
  const preset = PRESETS.get(id) ?? PRESETS.get('openai-compat')!;
  const patch = platformManifestOf(overrides);
  return Object.keys(patch).length === 0 ? preset : applyManifest(preset, patch);
}

/** Драйвер контура: его пресет и то, что человек сказал о своём шлюзе поверх. */
export function driverOf(
  platform: Pick<Platform, 'driver'> & { manifest?: unknown },
): PlatformDriver {
  return driverFor(platform.driver, platform.manifest);
}

/**
 * Все пресеты списком — для набора соответствия (`conformance/`), который
 * обязан пройти КАЖДЫЙ драйвер. Перечисляются именно пресеты контракта, а не
 * отдельный список: иначе новый шлюз можно было бы завести, не внеся в таблицу,
 * и он бы молча не проверялся ничем.
 */
export const allDrivers: PlatformDriver[] = [...PRESETS.values()];

export type { PlatformDriver, DriverReading, DriverAuth } from './driver.ts';
