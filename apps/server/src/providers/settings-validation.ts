import { object, string, boolean, number, record, array, unknown, enum as zodEnum } from 'zod';
import { isKnownProviderId } from './registry.ts';

/**
 * Серверная проверка тел `PATCH /api/settings` и `POST /api/settings/import`.
 *
 * Почему схема ЗДЕСЬ, а не из `@agentdeck/contracts`: contracts в сервер
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

/**
 * Внешние интеграции: видимая половина настройки. ТОКЕНОВ здесь нет — они живут
 * в зашифрованном хранилище панели и правятся отдельным маршрутом
 * (`PUT /api/integrations/:id`). Схема повторяет `integrationsSettingsSchema`
 * из contracts: расходиться им нельзя, иначе PATCH молча срежет поле и тумблер
 * на карточке отскочит назад.
 *
 * Блок целиком необязателен, а внутри него обязательны все поля: карточка
 * присылает свою настройку одним объектом, и частичный объект здесь означал бы
 * «остальные поля стереть» — ровно то, чего форма не имела в виду.
 */
export const integrationSettingsSchemas = {
  atlassian: object({
    enabled: boolean(),
    baseUrl: string(),
    email: string(),
    deployment: zodEnum(['', 'cloud', 'server']),
    confluenceUrl: string(),
  }),
  forge: object({
    enabled: boolean(),
    kind: zodEnum(['', 'github', 'gitlab']),
    baseUrl: string(),
    repo: string(),
  }),
  telegram: object({
    enabled: boolean(),
    chatId: string(),
    events: array(zodEnum(['runDone', 'runError', 'permission', 'question', 'testFailed'])),
  }),
  tms: object({
    enabled: boolean(),
    kind: zodEnum(['', 'zephyr', 'xray']),
    projectKey: string(),
    groupId: string(),
  }),
  ci: object({
    enabled: boolean(),
    kind: zodEnum(['', 'github', 'gitlab']),
    repo: string(),
    workflow: string(),
    artifact: string(),
  }),
};

/**
 * Тот же набор одним блоком настроек. Схемы карточек вынесены выше и отдаются
 * наружу поимённо: маршрут `PUT /api/integrations/:id` проверяет ОДНУ карточку,
 * и второе описание тех же полей рядом с первым разошлось бы с ним на первой же
 * правке формы.
 *
 * Блок целиком необязателен (об этом `.partial()` всей схемы PATCH), но ВНУТРИ
 * него обязательны все пять: карточки правятся своим маршрутом, а сюда блок
 * попадает только целиком — снимком состояния. Половина блока здесь означала бы
 * «остальные карточки стереть».
 */
const integrationsSettingsSchema = object(integrationSettingsSchemas);

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
  // Правила прав: id правила → разрешено без вопроса. Схема нарочно широкая —
  // состав правил меняется с кодом, а сервер, зная только старый набор, вырезал
  // бы из патча новое правило и молча возвращал бы тумблер назад.
  autoApproveRules: record(string(), boolean()),
  modelPricing: record(string(), modelPricingSchema),
  encryptSecretBackups: boolean(),
  autoUpdateModels: boolean(),
  previewProviderWrites: boolean(),
  endpointProfiles: array(endpointProfileSchema),
  assistantEndpointId: string(),
  dlp: dlpSettingsSchema,
  promptGate: promptGateSettingsSchema,
  integrations: integrationsSettingsSchema,
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
  // Итоги проверок внешних систем и привязки проектов к Jira/Confluence: без
  // этих двух ключей снимок увозил бы настройки интеграций, но терял бы всё,
  // ради чего они заведены, — какая задача относится к какому проекту.
  integrationHealth: record(string(), unknown()),
  integrationLinks: record(string(), unknown()),
  // `secretBackupVerifier` намеренно НЕ импортируем: это отпечаток парольной
  // фразы, которая есть только в голове у владельца исходной машины. Чужой
  // verifier заблокировал бы шифрование копий здесь навсегда.
  settings: importSettingsSchema,
}).partial();
