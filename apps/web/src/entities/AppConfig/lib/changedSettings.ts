import type { AppSettings } from '@agentdeck/contracts';

/**
 * Какие поля настроек различаются — как патч для `applySettingsUpdate`.
 * Сравнение по значению: вложенные объекты (шлюз, DLP) приходят новыми ссылками.
 */
export function changedSettings(before: AppSettings, after: AppSettings): Partial<AppSettings> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof AppSettings>;
  const patch: Partial<AppSettings> = {};
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      (patch as Record<string, unknown>)[key] = after[key];
    }
  }
  return patch;
}
