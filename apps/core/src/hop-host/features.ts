import type { HopRegisterSpec } from '@agentdeck/contracts/core/hops';
import type { PlatformManifestOverrides } from '@agentdeck/contracts/platform-presets';
import {
  buildEnterprisePlatformDriver,
  enterprisePlatformDriver,
} from './gateway/drivers/enterprise-platform.ts';
import { openAiCompatDriver } from './gateway/drivers/openai-compat.ts';
import type { HopDriver } from './gateway/drivers/driver.types.ts';

/**
 * Возможности звена, которые маршрут просит непрозрачными id (`RouteCaps.hopFeatures`, P108:
 * ядро имён не разбирает). Неизвестный id — ОТКАЗ регистрации: маршрут, попросивший то, чего
 * звено не умеет, иначе шёл бы без этого молча.
 *
 * - `deferred-tools` — отложенные инструменты Claude разворачиваются так, как это сделал бы
 *   облачный API (локальная модель, 07:64), с пометкой шаблона чата.
 * - `tool-shim` — инструменты клиента едут текстом протокола (шлюз без поля `tools`).
 * - `driver:<id>` — прежнее имя поля `HopRegisterSpec.driver` (манифест платформы: вендорные
 *   кадры, отказы, судьба полей). Нет ни того, ни другого — совместимый шлюз OpenAI (своего
 *   сервера моделей и подставного контура это и есть).
 */

export const HOP_FEATURES = ['deferred-tools', 'tool-shim'] as const;

const DRIVERS: Record<string, HopDriver> = {
  'openai-compat': openAiCompatDriver,
  'enterprise-platform': enterprisePlatformDriver,
};

const DRIVER_PREFIX = 'driver:';

export function unknownFeatures(features: readonly string[]): string[] {
  return features.filter((id) => {
    if (id.startsWith(DRIVER_PREFIX)) return !(id.slice(DRIVER_PREFIX.length) in DRIVERS);
    return !(HOP_FEATURES as readonly string[]).includes(id);
  });
}

type DriverSpec = Pick<HopRegisterSpec, 'features' | 'driver' | 'manifest'>;

/**
 * Id драйвера сеанса: явное поле `driver`, иначе прежняя возможность `driver:<id>`; `null` —
 * совместимый шлюз OpenAI. Оба названы и расходятся — `conflict`: какой из двух хотел маршрут,
 * звено не угадывает.
 */
export function driverIdOf(spec: DriverSpec): { id: string | null } | { conflict: string } {
  const feature = spec.features.find((id) => id.startsWith(DRIVER_PREFIX));
  const fromFeature = feature ? feature.slice(DRIVER_PREFIX.length) : null;
  const explicit = spec.driver ?? null;
  if (explicit !== null && fromFeature !== null && explicit !== fromFeature)
    return { conflict: `driver ${explicit} != feature driver:${fromFeature}` };
  return { id: explicit ?? fromFeature };
}

/** Почему драйвер сеанса не годится (регистрация отказывается), или `undefined`. */
export function driverProblem(
  spec: DriverSpec,
): { code: 'driver_conflict' | 'unknown_driver'; detail: string } | undefined {
  const resolved = driverIdOf(spec);
  if ('conflict' in resolved) return { code: 'driver_conflict', detail: resolved.conflict };
  if (resolved.id !== null && !Object.hasOwn(DRIVERS, resolved.id))
    return { code: 'unknown_driver', detail: `hop does not know driver: ${resolved.id}` };
  return undefined;
}

/**
 * Манифест пресета и карточки поверх драйвера базы — то, что из него спрашивает конвейер звена,
 * тем же правилом, что `applyManifest` драйвера панели: префикс вендора пересобирает разбор кадров
 * (только у базы, которая их читает), путь инструментов, родная ручка Anthropic (пусто — снята),
 * потолки ответа (0 — сняты). Усилие, поле размышлений и ручка картинок звену не нужны: их правил
 * у драйвера звена нет.
 */
export function withManifest(driver: HopDriver, patch: PlatformManifestOverrides): HopDriver {
  let next: HopDriver = { ...driver };
  if (patch.vendorPrefix !== undefined && driver.id === enterprisePlatformDriver.id) {
    const rebuilt = buildEnterprisePlatformDriver(patch.vendorPrefix);
    next = { ...next, readFrame: rebuilt.readFrame, vendorFields: rebuilt.vendorFields };
  }
  if (patch.clientTools) next.clientTools = patch.clientTools;
  if (patch.anthropicMessages !== undefined) {
    if (patch.anthropicMessages) next.anthropic = { messages: patch.anthropicMessages };
    else delete next.anthropic;
  }
  if (patch.nonStreamTimeoutSec !== undefined) {
    if (patch.nonStreamTimeoutSec > 0) next.nonStreamTimeoutSec = patch.nonStreamTimeoutSec;
    else delete next.nonStreamTimeoutSec;
  }
  if (patch.responseCeilingSec !== undefined) {
    if (patch.responseCeilingSec > 0) next.responseCeilingSec = patch.responseCeilingSec;
    else delete next.responseCeilingSec;
  }
  return next;
}

export function driverOf(spec: DriverSpec): HopDriver {
  const resolved = driverIdOf(spec);
  const id = 'id' in resolved ? resolved.id : null;
  const base =
    (id !== null && Object.hasOwn(DRIVERS, id) ? DRIVERS[id] : undefined) ?? openAiCompatDriver;
  return spec.manifest ? withManifest(base, spec.manifest) : base;
}

export function hasFeature(
  spec: Pick<HopRegisterSpec, 'features'>,
  id: (typeof HOP_FEATURES)[number],
): boolean {
  return spec.features.includes(id);
}

/**
 * Звено, которое отвечает сеансу: шлюз — перевод диалекта, любая возможность или названный
 * драйвер; иначе DLP-звено (маска + ключ + расход на том же диалекте).
 */
export function hopKindOf(
  spec: Pick<HopRegisterSpec, 'from' | 'to' | 'features' | 'driver'>,
): 'dlp' | 'gateway' {
  const driven = spec.driver !== undefined && spec.driver !== null;
  return spec.from !== spec.to || spec.features.length > 0 || driven ? 'gateway' : 'dlp';
}
