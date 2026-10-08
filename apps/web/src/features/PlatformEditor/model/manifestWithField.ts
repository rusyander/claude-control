import type { PlatformManifestField, PlatformManifestOverrides } from '@agentdeck/contracts';

/**
 * Переопределения после правки одного поля. `undefined` убирает поле — «как у
 * пресета»; пустая строка остаётся — «не объявлено», и это разные ответы.
 * Пустой объект не хранится: у контура без переопределений поля нет вовсе.
 */
export function manifestWithField<F extends PlatformManifestField>(
  manifest: PlatformManifestOverrides | undefined,
  field: F,
  value: PlatformManifestOverrides[F] | undefined,
): PlatformManifestOverrides | undefined {
  const next: PlatformManifestOverrides = { ...manifest };
  if (value === undefined) delete next[field];
  else next[field] = value;
  return Object.keys(next).length > 0 ? next : undefined;
}
