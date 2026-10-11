import { array, boolean, enum as zEnum, number, object, string, type infer as Infer } from 'zod';

/**
 * Сборка APK телефонного приложения из панели. Собирает тот же
 * `tools/build-mobile-apk.mjs`, что `pnpm mobile:apk`, — кнопка не заводит
 * второго пути сборки. Есть только в рабочей копии репозитория: без исходников
 * приложения собирать нечего (`available: false`).
 */
export const mobileApkStateSchema = zEnum(['idle', 'building', 'succeeded', 'failed']);
export type MobileApkState = Infer<typeof mobileApkStateSchema>;

export const mobileApkStatusSchema = object({
  available: boolean(),
  state: mobileApkStateSchema,
  startedAt: string().optional(),
  finishedAt: string().optional(),
  /** Хвост вывода сборки — последние строки, без кодов цвета. */
  log: array(string()),
  /** Готовый файл в корне репозитория, если он есть. */
  file: object({ path: string(), size: number(), builtAt: string() }).optional(),
  /** Телефоны, которые видит `adb` (USB или беспроводная отладка). */
  devices: array(string()),
  /** `adb` нет в PATH — ставить на телефон кнопкой нельзя, только файлом. */
  adbMissing: boolean(),
});
export type MobileApkStatus = Infer<typeof mobileApkStatusSchema>;

export const mobileApkInstallResultSchema = object({
  ok: boolean(),
  device: string(),
  output: string(),
});
export type MobileApkInstallResult = Infer<typeof mobileApkInstallResultSchema>;
