import { object, string, boolean, number, record, array, unknown, enum as zodEnum } from 'zod';

/**
 * Серверная проверка тел `PATCH /api/settings` и `POST /api/settings/import`.
 *
 * Почему схема ЗДЕСЬ, а не из `@claude-control/contracts`: contracts в сервер
 * тянется ТОЛЬКО как тип. Его `index.ts` реэкспортирует модули без расширений
 * (`export * from './claude-location'`), а Node ESM в рантайме такие пути не
 * резолвит — импорт zod-ЗНАЧЕНИЯ из барреля роняет сервер на старте
 * (`ERR_MODULE_NOT_FOUND`). Поэтому проверочную схему держим на стороне сервера.
 * Поля дублируют `appSettingsSchema`/`AppState` — расходиться им нельзя.
 *
 * Без `.default()` намеренно: это ПАТЧ. С дефолтами частичный патч (`{theme}`)
 * подставил бы дефолты всем остальным полям и молча сбросил бы их в state.json.
 * Здесь отсутствующее поле остаётся отсутствующим — обновляется только присланное.
 */

const modelPricingSchema = object({
  input: number().nonnegative(),
  output: number().nonnegative(),
  cacheRead: number().nonnegative(),
  cacheWrite: number().nonnegative(),
});

/** Поля настроек без дефолтов — для частичной проверки PATCH. */
export const settingsPatchSchema = object({
  theme: zodEnum(['light', 'dark', 'system']),
  language: zodEnum(['ru', 'en']),
  claudeDirOverride: string(),
  revealSecretsByDefault: boolean(),
  backupBeforeWrite: boolean(),
  backupKeep: number().int().min(1).max(100),
  watchFiles: boolean(),
  largeText: boolean(),
  reduceMotion: boolean(),
  highContrast: boolean(),
  editor: string(),
  costUnit: zodEnum(['tokens', 'money']),
  chatModel: string(),
  chatEffort: zodEnum(['', 'low', 'medium', 'high', 'xhigh', 'max']),
  modelPricing: record(string(), modelPricingSchema),
}).partial();

/**
 * Импорт `state.json` с чужой машины. Проверяем структуру: тело — объект,
 * `groups`/`automations` — массивы, `settings` — валидные настройки. Члены
 * (группы/сценарии/хуки) сверяем структурно, а не по доменным схемам: их
 * zod-значения живут в contracts и в рантайм сервера не тянутся. Глубже сверяет
 * слияние со `DEFAULT_STATE` в `importState`. Все поля необязательны — импорт
 * сливается с дефолтами, неполный снимок это норма.
 */
export const importStateSchema = object({
  groups: array(unknown()),
  automations: array(unknown()),
  disabled: record(string(), array(string())),
  disabledByGroup: record(string(), record(string(), array(string()))),
  disabledHooks: record(string(), unknown()),
  envByGroup: record(string(), array(string())),
  settings: settingsPatchSchema,
}).partial();
