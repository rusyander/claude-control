import { object, string, boolean, number, record, array, unknown, enum as zodEnum } from 'zod';
import { isKnownProviderId } from './registry.ts';

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
  // Часовая запись кэша — отдельная ставка прайса. Без этого поля zod срезал бы
  // её из своей цены пользователя, и панель считала бы часть записи по
  // выведенному множителю ×1.6 вместо введённой цифры (см. modelPricingSchema
  // в contracts).
  cacheWrite1h: number().nonnegative().optional(),
});

/**
 * Профиль своего эндпоинта. Токена здесь НЕТ и быть не может: он живёт в
 * зашифрованном хранилище панели, а `state.json` лежит открытым текстом и
 * уезжает с машины на машину экспортом настроек.
 */
const endpointProfileSchema = object({
  id: string().min(1),
  name: string().min(1),
  baseUrl: string().min(1),
  apiKind: zodEnum(['anthropic', 'google', 'openai-compat']),
  model: string(),
  writeToken: boolean(),
});

/**
 * Настройки прокси защиты данных. Правил здесь нет намеренно — они в отдельном
 * файле, и через общий PATCH настроек не правятся: в словарях правил лежат сами
 * персональные данные (см. `domains/dlp/rules-store.ts`).
 */
const dlpSettingsSchema = object({
  enabled: boolean(),
  port: number().int().min(1024).max(65535),
  upstreamUrl: string(),
  upstreamProfileId: string(),
  passUnknown: boolean(),
  journal: boolean(),
});

/**
 * Гейт на промпте. Действий два: замены меткой у события `UserPromptSubmit`
 * нет — оно по документации не умеет подменять промпт.
 */
const promptGateSettingsSchema = object({
  enabled: boolean(),
  action: zodEnum(['block', 'warn']),
});

/** Удалённый доступ — только для снимка (см. `importSettingsSchema`). */
const remoteAccessSettingsSchema = object({
  enabled: boolean(),
  publicUrl: string(),
  notify: boolean(),
});

/** Поля настроек без дефолтов — для частичной проверки PATCH. */
export const settingsPatchSchema = object({
  theme: zodEnum(['light', 'dark', 'system']),
  language: zodEnum(['ru', 'en']),
  accent: zodEnum(['default', 'blue', 'green', 'purple', 'amber']),
  // Активный провайдер: принимаем только известный реестру id (пока лишь 'claude').
  // Незнакомое значение отклоняем — оно не должно осесть в state.json.
  provider: string().refine(isKnownProviderId, { message: 'Неизвестный провайдер' }),
  onboardingDone: boolean(),
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
  mcpNetworkTimeoutMs: number().int().min(2_000).max(120_000),
  mcpAutoCheck: boolean(),
  chatModel: string(),
  chatEffort: zodEnum(['', 'low', 'medium', 'high', 'xhigh', 'max']),
  // Инициативы чата (аудит «Настройки» 2026-09-03): без этих четырёх полей PATCH
  // отвечал 200 со СТАРЫМ значением, и тумблер на странице отскакивал назад.
  taskSplitInitiative: boolean(),
  handoffInitiative: boolean(),
  handoffContextLimit: number().int().nonnegative(),
  handoffAutoDefault: boolean(),
  modelPricing: record(string(), modelPricingSchema),
  encryptSecretBackups: boolean(),
  autoUpdateModels: boolean(),
  previewProviderWrites: boolean(),
  endpointProfiles: array(endpointProfileSchema),
  assistantEndpointId: string(),
  dlp: dlpSettingsSchema,
  promptGate: promptGateSettingsSchema,
}).partial();

/**
 * Настройки внутри снимка: то же, что PATCH, плюс удалённый доступ. В PATCH его
 * НЕТ намеренно — единственный писатель этого блока `/api/remote` (он же ведёт
 * токен и гейт), а снимок обязан его сохранить: без поля в схеме zod вырезал
 * его, и после переноса гейт по токену молча оказывался выключенным.
 */
const importSettingsSchema = settingsPatchSchema.extend({
  remoteAccess: remoteAccessSettingsSchema.optional(),
});

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
  // Эти четыре поля обязаны быть в схеме, хотя `importState` и так умеет их
  // сливать: zod вырезает всё, чего в схеме нет, — и без них экспорт с одной
  // машины, применённый на другой, МОЛЧА терял список проектов, команды и
  // автозапуск dev-серверов и отметки о проверке провайдеров.
  projects: array(unknown()),
  runnerCommands: record(string(), string()),
  runnerPrefs: record(string(), unknown()),
  providerChecks: record(string(), unknown()),
  // Аудит «Настройки» 2026-09-03: без этих полей экспорт→импорт терял связи
  // чатов с сессиями (десятки записей), итоги проверок MCP, окна кода проектов
  // и спаренные телефоны — молча, снимок при этом «проходил проверку».
  mcpHealth: record(string(), unknown()),
  projectCodeViews: record(string(), unknown()),
  projectCodeLayout: unknown(),
  chatLinks: record(string(), unknown()),
  pushDevices: array(unknown()),
  // `secretBackupVerifier` намеренно НЕ импортируем: это отпечаток парольной
  // фразы, которая есть только в голове у владельца исходной машины. Чужой
  // verifier заблокировал бы шифрование копий здесь навсегда.
  settings: importSettingsSchema,
}).partial();
