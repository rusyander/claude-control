import {
  object,
  string,
  boolean,
  number,
  record,
  array,
  unknown,
  preprocess,
  union,
  enum as zodEnum,
} from 'zod';
// Значение, а не тип, и потому ПОДПУТЁМ, а не из барреля: баррель под
// `--experimental-strip-types` роняет сервер на старте (см. комментарий ниже).
// Само правило формата берётся отсюда, а не переписывается: разъехавшись, две
// копии дали бы «сохранилось в панели, не сохранилось в настройках».
import {
  defaultOurRules,
  defaultPlatformRules,
  isPlatformDay,
  platformCapabilities,
  platformIdPattern,
  platformThinkingSchema,
  platformToolModes,
} from '@agentdeck/contracts/platform';
import { platformConsumerSchema } from '@agentdeck/contracts/platform-consumers';
import { NOTIFY_EVENTS } from '@agentdeck/contracts/integrations';
import {
  platformDrivers,
  platformManifestOf,
  withPresetDefaults,
} from '@agentdeck/contracts/platform-presets';
import {
  defaultPlatformTransport,
  platformTransportSchema,
} from '@agentdeck/contracts/platform-transport';
import { modelSources } from '@agentdeck/contracts/models';
import { SPLIT_MAX_GROUPS } from '@agentdeck/contracts/task-split';
import { SPLIT_HEAVY_RULE_MAX } from '@agentdeck/contracts/split-groups';
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
  // Адрес генерации картинок (Т9, решение В4). Умолчанием, а не обязательным
  // полем: снимок настроек с машины, где этого поля ещё не было, обязан
  // читаться. Вырезанный схемой, он означал бы, что заданный человеком адрес
  // молча исчезает на первом же сохранении настроек — а пункт «Картинка» после
  // этого запирается «адрес не задан» про адрес, который он только что вписал.
  imagesUrl: string().default(''),
  // Профиль контура (Т3). Ключ обязан быть и здесь: вырезанный схемой, он
  // означал бы «управляемый профиль сохранился обычным» — то есть остался бы
  // после отключения контура и продолжал показывать мёртвый адрес шлюза.
  // Умолчание, а не обязательность: снимок настроек с машины, где контура ещё
  // не было, обязан читаться, а не отказывать целиком.
  ownerPlatformId: string().default(''),
});

/**
 * Контур: корпоративная платформа, к которой панель ходит по ключу. КЛЮЧА здесь
 * нет — он в зашифрованном хранилище панели (`platform:<id>`), а `state.json`
 * уезжает с машины на машину экспортом настроек.
 *
 * Повторяет `platformSchema` из contracts по той же причине, что и остальные
 * схемы этого файла: contracts тянется в сервер ТОЛЬКО типом. Расходиться им
 * нельзя — вырезанное поле означает «сохранил, а не сохранилось».
 */
// Наружу — ради сверки набора полей с контрактом в `settings-validation.audit.test.ts`.
export const platformObjectSchema = object({
  // Из идентификатора собирается адрес локального шлюза, поэтому набор символов
  // сужен схемой: пробел или слэш разъехались бы адресом.
  id: string().regex(
    platformIdPattern,
    'идентификатор: латиница, цифры, дефис, точка, подчёркивание',
  ),
  title: string().min(1),
  // Перечень пресетов — из контракта (DRV-03): переписанный здесь, он отказал бы
  // в сохранении первому же новому шлюзу, которого мастер уже показывает.
  driver: zodEnum(platformDrivers),
  baseUrl: string().min(1),
  enabled: boolean(),
  mode: zodEnum(['required', 'best-effort']),
  // Умолчание парное контракту: у контура, настроенного до Т8, поля нет, и без
  // него ВЕСЬ PATCH настроек получал бы отказ на записи, которую панель сама и
  // произвела.
  budgetUsd: number().nonnegative().default(0),
  // День, с которого считается бюджет, — тоже руками: когда контур обнуляет
  // свой счёт, снаружи не видно. Умолчание по той же причине, что у `agents`
  // ниже: у контура, настроенного до Т8, поля нет, и без умолчания отказ
  // получал бы ВЕСЬ PATCH настроек.
  // Дата проверяется и здесь, и не только видом: дни учёта сравниваются
  // посимвольно, «01.09.2026» отрезало бы весь расход молча, а `2026-13-45`
  // проходит по виду, но такого дня нет — итог тот же.
  budgetSince: string().refine(isPlatformDay).default(''),
  // Список возможностей — из контракта, а не переписанный здесь: переписанный
  // отставал ровно на одну новую возможность, и `image-generation`, который
  // визард сам же записал в черновик после пробы, получал отказ на ВЕСЬ PATCH
  // настроек — «сохранилось в панели, не сохранилось в файле».
  capabilities: array(zodEnum(platformCapabilities)),
  targets: array(string()),
  // Потребители маршрута (Т3). Умолчание по той же причине, что у `agents`: у
  // контура, настроенного до Т3, поля нет вовсе, и без умолчания отказ получал
  // бы ВЕСЬ PATCH настроек. Но пустой список — это «никуда не подключён», а не
  // «как раньше», поэтому обе двери в настройки (PATCH и разворот снимка)
  // ПЕРЕД записью возвращают прежнее поведение по сырому телу
  // (`withLegacyConsumers` в `domains/platform/store.ts`) — иначе снимок со
  // старой панели молча отключал бы контур от ассистента.
  //
  // Правило формата берётся из контракта, а не переписывается строкой: иначе
  // мусор в списке доехал бы сюда молча — схему контракта эти двери не видят.
  consumers: array(platformConsumerSchema).default([]),
  // Модель контура, переопределение на потребителя и карта соответствия имён
  // (Т6). Умолчания по той же причине, что у `consumers`: у контура,
  // настроенного до Т6, полей нет вовсе, и без них ВЕСЬ PATCH настроек получал
  // бы отказ. Пустая карта здесь безопасна ровно потому, что пустая означает
  // «переводить нечего», а не «переводи как знаешь».
  defaultModel: string().default(''),
  consumerModels: record(string(), string()).default({}),
  modelMap: record(string(), string()).default({}),
  projectPaths: array(string()),
  // Список агентов ведёт человек: маршрута «дай список агентов» на публичной
  // поверхности ключа нет, и пробе взять его неоткуда. Умолчание обязательно:
  // у контура, настроенного до Т7, поля нет вовсе, и без него ВЕСЬ PATCH
  // настроек получал бы отказ — раздел откатывался бы на первом же сохранении.
  agents: array(object({ id: string().min(1), title: string().min(1) })).default([]),
  // Прослойка инструментов и свой короткий промпт (Т5). Умолчание — пресета
  // типа, и ставит его `withPresetDefaults` над схемой той же функцией, что в
  // контракте: разойдись они, один и тот же контур вёл бы себя по-разному до
  // первого сохранения и после него. Без умолчания ВЕСЬ PATCH настроек получал
  // бы отказ на контуре, настроенном до Т5.
  toolShim: boolean(),
  // Отметка «прослойку включила панель по пробе» (Т5, решение В1). Без default
  // намеренно: пусто значит «панель ещё не решала», и ставит отметку ровно одна
  // дверь — активация. Срезанное здесь поле означало бы, что выключенную
  // человеком прослойку следующая проба включает снова: дверь сохранения
  // контура теряла бы отметку, а активация читала бы «панель не решала».
  toolShimFromProbe: string().optional(),
  contourPrompt: boolean(),
  // Маска данных контура (Р11): пусто — умолчание манифеста, поэтому без default.
  dataMask: boolean().optional(),
  // Правила контура (Т7). Умолчание обязательно по той же причине, что у
  // соседей: у контура, настроенного до Т7, поля нет вовсе. Набор значений
  // повторяет контракт поле в поле — вторую схему сверяет
  // `settings-validation.audit.test.ts`, и разойтись они не могут молча.
  // Рядом — наши слои (Т8). Умолчание `true` у каждого: запись, где поля нет,
  // означает «прогон несёт весь `~/.claude`», как было до Т8. Умолчание `false`
  // здесь тихо выключило бы человеку правила, хуки и права.
  rules: object({
    platform: object({
      platformTools: array(string()).default([]),
      toolMode: zodEnum(platformToolModes).default('loop'),
      generationPreset: string().default(''),
      enableThinking: platformThinkingSchema,
    }).default(defaultPlatformRules),
    ours: object({
      enabled: boolean().default(true),
      settings: boolean().default(true),
      skills: boolean().default(true),
      mcp: boolean().default(true),
      systemPrompt: boolean().default(true),
    }).default(defaultOurRules),
  }).default(() => ({ platform: defaultPlatformRules(), ours: defaultOurRules() })),
  caCertPath: string(),
  // Как запрос доезжает до контура (DRV-04/05). Схема контракта целиком, а не
  // копия: полей пять, и копия разошлась бы с формой на первом же новом. Отказ
  // на секретном имени ставит дверь сохранения контура, а не общий PATCH, — по
  // той же причине, что у исключения матрицы: противоречие, приехавшее архивом,
  // не должно запирать весь раздел; сборка запроса такие строки не отправляет.
  transport: platformTransportSchema.default(defaultPlatformTransport),
  // Что человек знает о своём шлюзе поверх пресета (DRV-03). Поле за полем, а
  // не отказом: по той же причине, что у транспорта, негодный путь, приехавший
  // архивом или правкой руками, не должен запирать весь раздел — он значит «как
  // у пресета». Отказ с именем поля ставит дверь сохранения контура.
  manifest: unknown().transform(platformManifestOf).optional(),
});

export const platformSchema = preprocess(withPresetDefaults, platformObjectSchema);

/**
 * Локальный шлюз контуров: один слушатель на все контуры, различаемые первым
 * сегментом адреса. Ключей здесь нет — они в зашифрованном хранилище.
 */
const platformGatewaySettingsSchema = object({
  enabled: boolean(),
  port: number().int().min(1024).max(65535),
  forceStream: boolean(),
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
    events: array(zodEnum(NOTIFY_EVENTS)),
  }),
  tms: object({
    enabled: boolean(),
    kind: zodEnum(['', 'zephyr', 'xray', 'testit']),
    // Адрес читает только Test IT: своя установка у каждого своя, у двух
    // облачных API общий на всех и поле остаётся пустым.
    baseUrl: string(),
    projectKey: string(),
    groupId: string(),
  }).superRefine((value, ctx) => {
    // Включённая карточка обязана быть рабочей. Проверку «чего не хватает»
    // форма делала только у себя, и это давало щель: включённый Zephyr,
    // переключённый на Test IT, сохранялся ВКЛЮЧЁННЫМ и без адреса — карточка
    // горела зелёным, а первая же кнопка отвечала «не указан адрес Test IT».
    // Форма — не место для правила: телефон и curl ходят тем же маршрутом.
    if (!value.enabled) return;
    for (const [field, missing] of [
      ['kind', !value.kind],
      ['projectKey', !value.projectKey.trim()],
      ['baseUrl', value.kind === 'testit' && !value.baseUrl.trim()],
    ] as const) {
      if (missing) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `Включённый тест-менеджмент без поля «${field}» работать не может`,
        });
      }
    }
  }),
  ci: object({
    enabled: boolean(),
    kind: zodEnum(['', 'github', 'gitlab']),
    repo: string(),
    workflow: string(),
    artifact: string(),
  }),
  webhook: object({
    enabled: boolean(),
    url: string(),
    events: array(zodEnum(NOTIFY_EVENTS)),
  }),
};

/**
 * Тот же набор одним блоком настроек. Схемы карточек вынесены выше и отдаются
 * наружу поимённо: маршрут `PUT /api/integrations/:id` проверяет ОДНУ карточку,
 * и второе описание тех же полей рядом с первым разошлось бы с ним на первой же
 * правке формы.
 *
 * Блок целиком необязателен (об этом `.partial()` всей схемы PATCH), но ВНУТРИ
 * него обязательны все карточки: они правятся своим маршрутом, а сюда блок
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
  deliverToMr: boolean(),
  // Правила прав: id правила → разрешено без вопроса. Схема нарочно широкая —
  // состав правил меняется с кодом, а сервер, зная только старый набор, вырезал
  // бы из патча новое правило и молча возвращал бы тумблер назад.
  autoApproveRules: record(string(), boolean()),
  chatAutoMode: boolean(),
  modelPricing: record(string(), modelPricingSchema),
  encryptSecretBackups: boolean(),
  autoUpdateModels: boolean(),
  // Источник каталога и контур-источник: без ключей здесь переключатель
  // источника на экране настроек возвращался бы назад на первом же F5.
  modelSource: zodEnum(modelSources),
  modelSourcePlatform: string(),
  previewProviderWrites: boolean(),
  endpointProfiles: array(endpointProfileSchema),
  // Контуры: без ключа в этой схеме PATCH отвечал бы 200 со старым списком, а
  // раздел «Контур» откатывался бы к прежнему состоянию на первом же F5 — тот
  // самый молча проглоченный ключ настроек, ради которого заведён аудит.
  platforms: array(platformSchema),
  // Шлюз: тот же довод, что и у контуров, плюс свой — порт слушателя правится с
  // экрана настроек, и проглоченный ключ означал бы «сохранил порт, а CLI
  // по-прежнему смотрят в старый».
  platformGateway: platformGatewaySettingsSchema,
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
  /**
   * Активный контур. В PATCH его нет намеренно (он переключается транзакцией
   * активации), а в снимке обязан быть: без ключа zod вырезал его, тумблеры
   * контуров при этом приезжали как есть — и панель называла контур неактивным,
   * пока шлюз продолжал его обслуживать. Пару сводит `reconcileActivePlatform`
   * сразу после записи.
   */
  activePlatformId: string().optional(),
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
  // Итог последней пробы контура. Без этого ключа снимок увозил бы настройки
  // контура, но терял бы всё, что панель о нём УЗНАЛА, — и раздел на новой
  // машине показывал бы «не проверялся» по работающему контуру.
  platformHealth: record(string(), unknown()),
  // Разделение: записи проектов и общие правила вкладки «Группы». Без ключей
  // снимок увозил бы группы, но терял бы, сколько их идёт разом и что они
  // решают сами. Чтение обоих прощающее (`split-settings.ts`), поэтому здесь
  // только форма верхнего уровня.
  splitSettings: record(string(), unknown()),
  splitDefaults: record(string(), unknown()),
  // `secretBackupVerifier` намеренно НЕ импортируем: это отпечаток парольной
  // фразы, которая есть только в голове у владельца исходной машины. Чужой
  // verifier заблокировал бы шифрование копий здесь навсегда.
  settings: importSettingsSchema,
}).partial();

/**
 * `PUT /api/split-defaults` — общие правила групп разделения (вкладка
 * «Группы»). Границы здесь, а не только в форме: запрос приходит и с телефона,
 * и из скрипта, а потолок 0 значил бы «группы не стартуют никогда» без единой
 * ошибки на экране. Состав строк разрешений не сверяем — он меняется с кодом,
 * незнакомую строку чтение просто не увидит (`pickGroupPermissions`).
 */
export const splitDefaultsSchema = object({
  // Булево — от клиента прошлой версии (`true` — сама, `false` — человеку).
  permissions: record(string(), union([boolean(), zodEnum(['auto', 'notify', 'human'])])),
  groupQuestions: zodEnum(['plan', 'human']).optional(),
  parallelLight: number().int().min(1).max(SPLIT_MAX_GROUPS),
  parallelHeavy: number().int().min(1).max(SPLIT_MAX_GROUPS),
  heavy: object({
    chains: number().int().min(1).max(SPLIT_HEAVY_RULE_MAX),
    steps: number().int().min(1).max(SPLIT_HEAVY_RULE_MAX),
  }),
});
