import { z } from 'zod';
import type { ModelPricing, PricingEntry } from '../app-settings.ts';
import type {
  PlatformGatewayEvent,
  PlatformSpendRecord,
  PlatformSummarizedReport,
  PlatformUsageRecord,
} from '../platform.ts';
import { dlpRuleSchema, type DlpRule } from '../dlp.ts';
import { platformManifestSchema, type PlatformManifestOverrides } from '../platform-presets.ts';
import type { Fact } from './facts.ts';
import type { Dialect, KeyRef, RouteId, RoutePrice } from './routes.ts';

/**
 * Протокол хоста звеньев (11 §Hop chain, 00:52; фаза 5): отдельный процесс ядра держит DLP-звено
 * и шлюз, переживает перезапуск ядра и панели. Ядро — клиент (`routes/hops`): регистрирует метку
 * сеанса, получает порт и заглушку ключа; настоящий ключ подставляет только звено (P112).
 *
 * Типы — то, что шлёт вызывающий (новые поля необязательны: старый вызов остаётся верным);
 * схемы — то, что хост принимает: значения по умолчанию ставит разбор, поэтому хост работает с
 * полной формой (`HopRegistration`), а не угадывает пропуски на месте.
 */

/** Сеансовая метка: ею звено различает сеансы и считает расход (P122). */
export type HopTag = string;

/**
 * Язык отказов звена. Другого источника, кроме этого поля, нет: настройка языка живёт в панели,
 * а у ядра её пока нет — ядро передаёт язык, когда узнает; молчание — `ru`.
 */
export const HOP_LANGUAGES = ['ru', 'en'] as const;
export type HopLanguage = (typeof HOP_LANGUAGES)[number];
export const DEFAULT_HOP_LANGUAGE: HopLanguage = 'ru';

/** Политика DLP звена для сеанса: `required` — непрозрачное тело отказывается (`dlp_opaque`, P124). */
export interface HopDlpPolicy {
  required: boolean;
  /** Хэш набора правил маски: звено сверяет его с правилами, которые применит. */
  rulesHash: string | null;
  /**
   * Правила маски ДАННЫМИ сеанса: звено применяет ровно их. Нет (`null`/пусто) — правила из
   * каталога данных панели хоста или встроенный набор (как было до этого поля).
   * `rulesHash` считается по правилам ПОСЛЕ разбора схемой (`dlpRuleSchema` проставляет
   * значения по умолчанию): хэш сырого объекта с опущенными полями не совпадёт.
   */
  rules?: DlpRule[] | null;
}

/**
 * Цена маршрута для расхода звена (P127): тот же факт и та же таблица, по которым ядро считает
 * деньги хода (`economy/price`). Деньги — только при факте `money` и найденной цене версии модели.
 */
export interface HopPriceSpec {
  /** Факт цены маршрута (`RouteCaps`/реестр): `unknown`/`absent`/не деньги — денег нет. */
  route: Fact<RoutePrice>;
  /** Строки прайса; нет — встроенный снимок пакета цен (`@agentdeck/pricing`). */
  entries?: PricingEntry[];
  /** Цены, объявленные шлюзом для своих моделей: точный id (нижний регистр) → цена. */
  declared?: Record<string, ModelPricing>;
}

export interface HopRegisterSpec {
  tag: HopTag;
  sessionId: string;
  routeId: RouteId;
  /** Адрес вверх по цепи (origin без пути); путь диалекта добавляет звено. */
  upstream: string;
  from: Dialect;
  to: Dialect;
  /** Ключ верхнего маршрута; `null` — маршрут без ключа (локальный). */
  keyRef: KeyRef | null;
  dlp: HopDlpPolicy;
  /** Непрозрачные id возможностей звена, которые просит маршрут (`RouteCaps.hopFeatures`). */
  features: string[];
  /**
   * Драйвер шлюза (манифест платформы: кадры, отказы, судьба полей) непрозрачным id; `null` или
   * нет — совместимый шлюз OpenAI. Прежняя форма — возможность `driver:<id>` — тоже принимается;
   * оба названы и расходятся — отказ регистрации.
   */
  driver?: string | null;
  /** Цена маршрута для денег в расходе метки; нет — деньги `null` с причиной `no-price-fact`. */
  price?: HopPriceSpec | null;
  /** Язык отказов этого сеанса; нет — язык хоста (по умолчанию `ru`). */
  language?: HopLanguage;
  /**
   * Куда звено кладёт ключ наверх: заголовок и слово перед ключом (`scheme` пусто — голый
   * ключ). Нет — по диалекту верха: `x-api-key` у Anthropic, `Authorization: Bearer` у прочих.
   * Источник — карточка контура (`transport.authHeader`/`authScheme`) или пресет драйвера.
   */
  upstreamAuth?: HopUpstreamAuth | null;
  /** Постоянные заголовки верха без ключа (`transport.headers` контура); ключ их перебивает. */
  upstreamHeaders?: Record<string, string>;
  /** Параметры адреса верха (`transport.query` контура, например `api-version`). */
  upstreamQuery?: Record<string, string>;
  /**
   * `upstream` — уже корень API С версией (`…/v1`, `…/api/v2`, режим `as-is` контура): путь
   * клиента `/v1/<rest>` уходит как `<upstream>/<rest>`. Нет — `upstream` корень хоста, путь
   * диалекта (`/v1/...`) дописывается целиком.
   */
  upstreamRooted?: boolean;
  /**
   * Переопределения манифеста поверх драйвера базы: пресет (`litellm`, `openrouter`, … — их
   * манифест) ⊕ карточка контура, тем же порядком, что сборка драйвера панели (`driverFor`).
   * Звено сводит имя пресета к базе (`driver`), и без этого поля объявленное пресетом (родная
   * ручка Anthropic, путь инструментов, префикс вендора) терялось. Нет — драйвер базы как есть.
   */
  manifest?: PlatformManifestOverrides | null;
  /**
   * Управляемые правила контура (Т7: инструменты контура, режим цикла, пресет, размышления) уже
   * разложенными в поля провода: ядро сводит выбор человека и манифест драйвера, звено только
   * кладёт поля ПОСЛЕ перевода диалекта и ДО маски. Нет — тело уходит без правил.
   */
  requestRules?: HopRequestRules | null;
}

/** Значение поля правила на проводе: строка, флаг или список имён. */
export type HopRuleValue = string | boolean | string[];

/**
 * Правила тела верха. `set` — поля по пути (`a.b` — вложенное, объекты по дороге копируются);
 * `streamless` — значения, с которыми верх не принимает поток (у платформы компании режим
 * `single_turn`): тогда поток снимается, ответ приходит цельным телом. `forceStream` — перевод
 * верха в поток (настройка панели `platformGateway.forceStream`, по умолчанию да).
 */
export interface HopRequestRules {
  set: { path: string; value: HopRuleValue }[];
  streamless: { path: string; values: string[] }[];
  forceStream: boolean;
}

/** Заголовок ключа верха: имя (token RFC 9110) и слово перед ключом. */
export interface HopUpstreamAuth {
  header: string;
  scheme: string;
}

/**
 * Пары перевода шлюза звена — ОДИН список для судьи `compat` ядра и для регистрации у хоста:
 * заявить больше, чем мост умеет, значило бы открыть канал, которого нет; хост отказывает
 * регистрации вне списка. Мосты: `hop-host/gateway/bridge.ts` (Anthropic → OpenAI chat) и перевод
 * на краю `hop-host/gateway/edge.ts` (Responses, Gemini → OpenAI chat, этап 10). DLP судит
 * переведённое тело верха (`compat` `dlpDialect`, план Q7), поэтому `HOP_DLP_PARSES` прежний.
 */
export const HOP_TRANSLATIONS: readonly { from: Dialect; to: Dialect }[] = [
  { from: 'anthropic-messages', to: 'openai-chat' },
  { from: 'openai-responses', to: 'openai-chat' },
  { from: 'google-genai', to: 'openai-chat' },
];

/**
 * Порт шлюза человека на хосте звеньев (этап 10): адрес, который активация пишет в конфиги CLI
 * человека. Единственное исключение из отказа 5170–5180 — только для продукта; тесты берут
 * свободный порт.
 */
export const HOP_USER_GATEWAY_PORT = 5179;

/**
 * Порт шлюза человека у ядра явно (стенды QA, тесты): число — этот порт; `0`, не число или вне
 * 1–65535 — шлюза нет. Не задан — ядро на доме человека слушает порт из настроек панели (5179 по
 * умолчанию, шлюза у панели больше нет), ядро на отдельном доме — нет (`userGatewayPlanOf` ядра).
 */
export const HOP_USER_GATEWAY_PORT_ENV = 'AGENTDECK_USER_GATEWAY_PORT';

/**
 * Порт шлюза человека по окружению — одно правило для ядра (где слушать) и проверок: число —
 * задан; `null` — выключен явно (`0`, не порт); `undefined` — не задан, решает ядро.
 */
export function userGatewayPortOf(
  env: Record<string, string | undefined>,
): number | null | undefined {
  const raw = env[HOP_USER_GATEWAY_PORT_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/** Диалекты, тело которых разбирает DLP-звено (`@agentdeck/dlp` api-shapes); Google — нет. */
export const HOP_DLP_PARSES: readonly Dialect[] = ['anthropic-messages', 'openai-chat'];

/** Умеет ли мост звена перевести `from` → `to` (одинаковые — перевода нет, всегда да). */
export function hopTranslates(from: Dialect, to: Dialect): boolean {
  return from === to || HOP_TRANSLATIONS.some((pair) => pair.from === from && pair.to === to);
}

export interface HopRegisterReply {
  /** Порт звена этого сеанса на loopback; никогда не 5170-5180. */
  port: number;
  /** Заглушка ключа в окружение сеанса; настоящего ключа в ответе нет. */
  placeholder: string;
}

/**
 * Почему у расхода нет денег (P127: выдуманная сумма хуже пустой): `no-price-fact` — регистрация
 * не несла цену; остальные — те же причины, что у хода ядра (`economy/price` `TokensOnlyReason`)
 * плюс `window` (подписка меряется окном, не деньгами).
 */
export const HOP_MONEY_REASONS = [
  'no-price-fact',
  'unknown-price',
  'no-price',
  'gpu-time',
  'unknown-model',
  'window',
] as const;
export type HopMoneyReason = (typeof HOP_MONEY_REASONS)[number];

/** Расход по метке: токены всегда, деньги — только когда цена известна (P127). */
export interface HopSpend {
  tag: HopTag;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  money: number | null;
  /** Почему `money` пусто; есть всегда, когда пусто (строка из прежнего хоста — нет). */
  moneyReason?: HopMoneyReason | null;
  /** Версия прайса → сколько ответов ею оценено (видно, какой ценой посчитаны деньги). */
  priceVersions?: Record<string, number>;
}

/** Порт, который хост не смог вернуть после перезапуска: записанный → новый (P46 журналит ядро). */
export interface HopPortSubstitution {
  listener: 'control' | 'dlp' | 'gateway';
  recorded: number;
  actual: number;
  reason: string;
}

export interface HopStatus {
  pid: number;
  ports: { dlp: number | null; gateway: number | null };
  tags: HopTag[];
  /** Маршруты, исчерпанные ответом 402: держатся, пока человек не снимет (`clear-exhausted`). */
  exhausted: { routeId: RouteId; exhaustedAt: number }[];
  /** Подстановки портов при старте хоста; нет — все порты те же, что записаны. */
  substitutions?: HopPortSubstitution[];
  /** Каталог данных панели, с которым запущен хост (ключи `panel-store`, правила маски). */
  panelAppData?: string | null;
  /** Шлюз человека (этап 10); нет — не открыт. */
  userGateway?: HopUserGatewayState | null;
  /** Прокси защиты данных человека (C3c); нет — не открыт. */
  dlpProxy?: HopDlpProxyState | null;
}

/**
 * Прокси защиты данных человека на хосте звеньев (C3c, перенос `DlpProxy` панели): человек сам
 * пишет в свой CLI адрес `http://127.0.0.1:<port>`, прокси маскирует тело по правилам панели,
 * пересылает на `upstream` с ключом самого CLI (ключа у прокси нет) и разворачивает метки в
 * ответе. Журнал срабатываний — `dlp-journal.jsonl` в каталоге данных панели.
 */
export interface HopDlpProxyConfig {
  port: number;
  /** Абсолютный адрес наверх, уже разрешённый ядром (`@agentdeck/dlp/proxy-config`). */
  upstream: string;
  /** Тело незнакомой формы: пропустить (с записью в журнал) или отклонить. */
  passUnknown: boolean;
  journal: boolean;
}

/** `waiting` — порт занят, звено пробует снова; `listening` — держит. Счётчики — с настройки. */
export interface HopDlpProxyState {
  port: number;
  state: 'waiting' | 'listening';
  since: number;
  upstream: string;
  lastError?: string | null;
  requests: number;
  masked: number;
  blocked: number;
}

/**
 * Маршрут контура для шлюза человека: адрес CLI `/<platformId>/v1/...` (тот же, что у прежнего
 * шлюза в панели). `spec` — регистрация, как у метки сеанса; `from` звено ставит по ручке запроса,
 * `tag`/`sessionId` — свои (`user:<platformId>`).
 */
export interface HopUserRoute {
  platformId: string;
  title: string;
  enabled: boolean;
  /**
   * Разделы, открытые на контуре (`Platform.consumers`, у записи до Т3 — подстановка по целям):
   * адрес с отметкой `/_s/<раздел>` проходит, только если раздел здесь. Адрес без отметки проходит
   * всегда — свои проверки панели и старые файлы CLI.
   */
  consumers: string[];
  /** Имена CLI по id — для текста отказа закрытого раздела `foreign:<id>`. */
  cliNames?: Record<string, string>;
  spec: HopRegisterSpec;
}

/**
 * Шлюз человека: `waiting` — порт занят (прежний шлюз в панели ещё держит его), звено пробует
 * снова каждые `retryMs` и берёт порт, как только его отпустят; `listening` — держит.
 */
export interface HopUserGatewayState {
  port: number;
  state: 'waiting' | 'listening';
  since: number;
  routes: string[];
  lastError?: string | null;
}

/**
 * Чтение С КЛЮЧОМ (каталог моделей маршрута, зона R `keyedProbe`): ключ по `keyRef` читает и
 * подставляет только звено — ядро значения не видит (P112). `hop-injected` — ключ сеанса,
 * зарегистрированного под этой меткой.
 */
export interface HopProbeRequest {
  routeId: RouteId;
  url: string;
  keyRef: KeyRef;
  /** Куда положить ключ: заголовок (имя + слово перед ключом) или параметр адреса. */
  auth: { header: string; scheme: string } | { query: string };
  /** Прочие заголовки запроса (без ключа). */
  headers?: Record<string, string>;
}

/** Ответ верха как есть, с потолком размера; отражённый вендором ключ вычищен. */
export interface HopProbeReply {
  status: number;
  body: string;
  contentType?: string;
}

/** Сообщения управления хостом: один запрос — один ответ. */
export type HopControlRequest =
  | {
      op: 'register';
      spec: HopRegisterSpec;
      /**
       * Значение ключа `env`, прочитанное ядром из пина задачи: хост держит его в ПАМЯТИ метки
       * (не в файле меток, не в следе) до снятия метки. Вне `spec`, потому что `spec` хост
       * пишет на диск. Нет — ключ `env` читается из окружения самого хоста.
       */
      sessionKey?: string;
    }
  | { op: 'unregister'; tag: HopTag }
  | { op: 'status' }
  | { op: 'clear-exhausted'; routeId: RouteId }
  | { op: 'spend-of'; tag: HopTag }
  | ({ op: 'probe' } & HopProbeRequest)
  /** Открыть/перенастроить шлюз человека (`port: null` — закрыть); `routes` ЗАМЕНЯЮТ набор. */
  | { op: 'user-gateway'; port: number | null; routes: HopUserRoute[] }
  /** Открыть/перенастроить прокси защиты данных человека (`config: null` — закрыть). */
  | { op: 'dlp-proxy'; config: HopDlpProxyConfig | null }
  /** Учёт контуров (C3b): след и счётчики от запуска звена + сводка сжатий. */
  | { op: 'contours' }
  | { op: 'contour-spend' }
  /** Факты прогона чужого CLI для его ответа в чате (C3b): сжатие по метке, вызовы с `since`. */
  | { op: 'contour-run'; runTag: string; since: number }
  /** Id сообщений, перед которыми контур сжал историю, — ленте Claude (C3b). */
  | { op: 'contour-summarized' }
  /** Ход локальных маршрутов сейчас (этап 11, W2-5). */
  | { op: 'activity' };

/** Учёт контуров звена: то, из чего ядро собирает данные карточки шлюза ядра. */
export interface HopContours {
  /** С какого момента звено считает (запуск хоста, мс). */
  since: number;
  requests: number;
  failures: number;
  usage: PlatformUsageRecord[];
  /** Новые сверху, не больше 50. */
  events: PlatformGatewayEvent[];
  summarized: PlatformSummarizedReport;
  /** Перейдённые пороги бюджета по возрастанию `seq`, не больше 50. */
  notices: HopBudgetNotice[];
}

/**
 * Порог бюджета контура, перейдённый учётом звена (`budgetCrossing`): один раз на переход —
 * отметка о сказанном едет на диск вместе с расходом. `seq` растёт и через перезапуск звена:
 * курсор читателя (каналы панели Telegram/вебхук) не повторяет сказанное.
 */
export interface HopBudgetNotice {
  seq: number;
  at: string;
  platformId: string;
  platformTitle: string;
  level: 'near' | 'over';
  share: number;
}

export type HopControlReply =
  | { op: 'register'; ok: true; reply: HopRegisterReply }
  | { op: 'unregister'; ok: true }
  | { op: 'status'; ok: true; status: HopStatus }
  | { op: 'clear-exhausted'; ok: true; cleared: boolean }
  | { op: 'spend-of'; ok: true; spend: HopSpend | null }
  | { op: 'probe'; ok: true; reply: HopProbeReply }
  | { op: 'user-gateway'; ok: true; state: HopUserGatewayState | null }
  | { op: 'dlp-proxy'; ok: true; state: HopDlpProxyState | null }
  | { op: 'contours'; ok: true; contours: HopContours }
  | { op: 'contour-spend'; ok: true; records: Record<string, PlatformSpendRecord> }
  | ({ op: 'contour-run'; ok: true } & CoreContourRunReply)
  | ({ op: 'contour-summarized'; ok: true } & CoreContourSummarizedReply)
  | { op: 'activity'; ok: true; routes: HopActivity[] }
  | { op: HopControlRequest['op']; ok: false; code: string; detail: string };

/**
 * Строка `procs.json` хоста звеньев — ровно то, что хост пишет: `port` — порт управления
 * (loopback), рядом порты звеньев. Ядро ищет её перед запуском второго хоста.
 */
export interface HopHostProcRow {
  kind: 'hop-host';
  id: string;
  pid: number;
  pidStart: string;
  /** Порт управления (loopback). */
  port: number;
  dlpPort: number | null;
  gatewayPort: number | null;
  ownerBootId: string;
  startedAt: number;
}

/**
 * Настройка процесса хоста — одним аргументом (base64url JSON): окружение через отвязанный
 * запуск (WMI) не доходит.
 */
export interface HopHostLaunch {
  /** Дом ядра (`AGENTDECK_CORE_HOME`): всё состояние хоста — под ним. */
  home: string;
  /**
   * Каталог данных панели: ключи `panel-store` (`@agentdeck/keys`, G5) и правила маски по
   * умолчанию. Источник — вызывающий `ensureHopHost` (загрузка ядра знает каталог панели;
   * сам хост его не ищет). Нет — ключи `panel-store` не разрешаются (отказ с причиной),
   * правила — встроенный набор.
   */
  panelAppData?: string | null;
  /** Сколько ждать первого байта/следующего куска наверху, прежде чем назвать тишину (мс). */
  stallMs?: number;
  /** Как часто расход сбрасывается на диск (мс). */
  flushMs?: number;
  /** Пауза перед единственной повторной попыткой, когда контур её не назвал (мс). */
  retryPauseMs?: number;
  /** Загрузка ядра, запустившая хост (строка `procs.json`); хост её переживает. */
  ownerBootId?: string;
  /** Язык отказов хоста там, где сеанс ещё не известен; см. `HopLanguage`. */
  language?: HopLanguage;
}

// ——— схемы: то, что хост принимает по проводу ———

const nonEmpty = z.string().min(1);

const keyRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('panel-store'), name: nonEmpty }),
  z.strictObject({ kind: z.literal('env'), name: nonEmpty }),
  z.strictObject({ kind: z.literal('hop-injected'), tag: nonEmpty }),
]);

const dialectSchema = z.enum([
  'anthropic-messages',
  'openai-chat',
  'openai-responses',
  'google-genai',
] as const satisfies readonly Dialect[]);

const routePriceSchema = z.discriminatedUnion('unit', [
  z.strictObject({ unit: z.literal('money'), source: z.string() }),
  z.strictObject({ unit: z.literal('window') }),
  z.strictObject({ unit: z.literal('gpu-time') }),
  z.strictObject({ unit: z.literal('none') }),
]);

const priceFactSchema = z.union([
  z.strictObject({ value: routePriceSchema }),
  z.strictObject({ absent: z.literal(true) }),
  z.strictObject({ unknown: z.string() }),
]);

/** Та же форма, что `modelPricingSchema` панели (её модуль не грузится вне сборки). */
const modelPricingSchema = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  cacheWrite1h: z.number().nonnegative().optional(),
});

const pricingEntrySchema = z.strictObject({
  id: nonEmpty,
  label: z.string(),
  price: modelPricingSchema,
  from: z.string().optional(),
  until: z.string().optional(),
});

export const hopPriceSpecSchema = z.strictObject({
  route: priceFactSchema,
  entries: z.array(pricingEntrySchema).optional(),
  declared: z.record(z.string(), modelPricingSchema).optional(),
});

const upstreamSchema = z.url({ protocol: /^https?$/, error: 'upstream is not an http(s) URL' });

/** Имя заголовка HTTP (token RFC 9110): ни пробелов, ни переводов строки — ключ не уедет вбок. */
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'header name');
const headerValue = z.string().regex(/^[^\r\n]*$/);
/** Путь поля на проводе: имена через точку (`chat_template_kwargs.enable_thinking`). */
const wirePath = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/);

export const hopRegisterSpecSchema = z.strictObject({
  tag: nonEmpty,
  sessionId: nonEmpty,
  routeId: nonEmpty,
  upstream: upstreamSchema,
  from: dialectSchema,
  to: dialectSchema,
  keyRef: keyRefSchema.nullable(),
  dlp: z.strictObject({
    required: z.boolean(),
    rulesHash: z.string().nullable(),
    rules: z.array(dlpRuleSchema).nullable().default(null),
  }),
  features: z.array(nonEmpty),
  driver: nonEmpty.nullable().default(null),
  price: hopPriceSpecSchema.nullable().default(null),
  language: z.enum(HOP_LANGUAGES).optional(),
  upstreamAuth: z
    .strictObject({ header: headerName, scheme: headerValue })
    .nullable()
    .default(null),
  upstreamHeaders: z.record(headerName, headerValue).default({}),
  upstreamQuery: z.record(nonEmpty, z.string()).default({}),
  upstreamRooted: z.boolean().default(false),
  manifest: platformManifestSchema.strict().nullable().default(null),
  requestRules: z
    .strictObject({
      set: z.array(
        z.strictObject({
          path: wirePath,
          value: z.union([z.string(), z.boolean(), z.array(z.string())]),
        }),
      ),
      streamless: z.array(z.strictObject({ path: wirePath, values: z.array(z.string()) })),
      forceStream: z.boolean(),
    })
    .nullable()
    .default(null),
});

/** Регистрация, как её держит хост: значения по умолчанию проставлены разбором. */
export type HopRegistration = z.output<typeof hopRegisterSpecSchema>;

/**
 * След запроса контура (`PlatformGatewayEvent` панели). Схема держит обязательное ядро формы;
 * прочие поля едут как есть — их пишет и читает один и тот же тип контракта.
 */
const contourEventSchema = z.looseObject({
  at: z.string().min(1),
  platformId: nonEmpty,
  path: z.string(),
  dialect: z.string(),
  status: z.number().int(),
});

/**
 * `GET /v1/contours` ядра (C3b): учёт контуров звена — единственный источник карточки шлюза,
 * расхода и полосы бюджета панели. `live` — след и счётчики от запуска звена, `records` — дни
 * расхода по контурам (бюджет панель сверяет общей функцией `spendInfo`).
 */
export interface CoreContoursReply {
  live: HopContours;
  records: Record<string, PlatformSpendRecord>;
  /**
   * Шлюз человека на хосте (`HopStatus.userGateway`): по нему панель решает, куда вести прогоны
   * CLI через контур (порт `listening`), и отвечает «шлюз не поднят». Нет — не открыт.
   */
  userGateway?: HopUserGatewayState | null;
}

/**
 * `POST /v1/contours/apply` ядра (этап 10, s10 G7): панель записала контур — ядро настраивает шлюз
 * человека сейчас, а не на такте (5 с). Ответ приходит, когда хост звеньев уже принял маршруты:
 * снятый раздел закрыт к моменту ответа панели человеку. `applied: false` — шлюза у этого ядра нет
 * (ядро на отдельном доме без порта шлюза); `userGateway` — состояние, как его назвал хост.
 */
export interface CoreContoursApplyReply {
  applied: boolean;
  userGateway: HopUserGatewayState | null;
}

/**
 * `GET /v1/dlp-proxy` · `POST /v1/dlp-proxy/apply` (C3c): прокси защиты данных человека, как его
 * держит хост звеньев по настройкам панели. `enabled` — тумблер раздела; `proxy` — слушатель
 * (`null` — не открыт); `problem` — почему не открыт при включённом тумблере: код — тот же, что
 * у отказа панели (`dlp-no-rules`, `dlp-upstream-missing`, …), `detail` — слова.
 */
export interface CoreDlpProxyReply {
  enabled: boolean;
  /** Порт из настроек — адрес, который человек вписывает в CLI, даже пока слушателя нет. */
  port: number;
  proxy: HopDlpProxyState | null;
  problem: { code: string; detail: string } | null;
}

/** `GET /v1/contours/notices?after=<seq>` — извещения о бюджете; звена нет — пусто. */
export interface CoreContourNoticesReply {
  notices: HopBudgetNotice[];
}

/**
 * `GET /v1/contours/run?tag=<метка>&since=<мс>` — факты прогона чужого CLI для его ответа в чате:
 * сжимал ли контур историю в прогоне с этой меткой; сколько вызовов инструментов агента видел
 * учёт с `since` (`toolCalls` нет — запросов за это время не было: молчать честнее нуля).
 */
export interface CoreContourRunReply {
  summarized: boolean;
  toolCalls?: number;
}

/** `GET /v1/contours/summarized` — id сообщений, перед которыми контур сжал историю. */
export interface CoreContourSummarizedReply {
  messageIds: string[];
}

/**
 * Метка звена для запросов САМОЙ панели в контур (картинки, презентации, запасной путь
 * помощника) — `panel:<id контура>`. Регистрирует её ядро (`POST /v1/contours/:id/link`), не
 * панель: факты маршрута — те же, что у шлюза человека для этого контура:
 *   - маршрут `gateway:<id>` — расход, бюджет, отметка «исчерпан» и след ложатся на карточку
 *     ЭТОГО контура (`/v1/contours`), как у запросов CLI;
 *   - ключ — из хранилища панели (`platform:<id>`), читает и подставляет хост; панель получает
 *     только заглушку `adk-hop-…`;
 *   - DLP — политика контура (`dataMask`/обязательная маска), правила хоста;
 *   - драйвер, заголовки, query, корень API, управляемые правила запроса — из карточки;
 *   - диалект клиента И верха — OpenAI chat (перевода нет, прослойки инструментов нет);
 *     ручки: `/v1/chat/completions`, `/v1/images/generations`, `GET /v1/models`.
 * Заглушка одна на метку: повторная регистрация гасит прежнюю, поэтому ядро держит выданную,
 * пока факты контура и хост те же; панель держит ответ и просит `fresh` после 401 хоста.
 * Свои эндпоинты панели (профили api-key, не контуры) этой меткой не покрыты.
 */
export const panelHopTag = (platformId: string): HopTag => `panel:${platformId}`;

/**
 * Метка звена для прямых вызовов API самой панели по ключу (Q5): свой эндпоинт человека
 * (`api-key:endpoint:<id>`) и ключ вендора (`api-key:<cli>`) — `panel:<routeId>`. Регистрирует
 * ядро (`POST /v1/links`): верх — адрес профиля, ключ — из хранилища панели (подставляет хост),
 * DLP — общий выключатель маски панели, диалект клиента И верха — вид API профиля (перевода нет).
 * С меткой контура не пересекается: id маршрута ключа начинается с `api-key:`.
 */
export const panelRouteHopTag = (routeId: string): HopTag => `panel:${routeId}`;

/** Маршруты, которые звено панели принимает в `POST /v1/links`: ключ API, не контур. */
export const PANEL_LINK_ROUTE = /^api-key:[\w.:-]{1,200}$/;

/** Тело `POST /v1/links`: id маршрута ключа и «заново» после 401 хоста. */
export interface CoreRouteLinkBody {
  routeId: string;
  fresh?: boolean;
}

/**
 * `POST /v1/contours/:id/link` (тело `{fresh?: true}`) — адрес звена и заглушка ключа метки
 * `panelHopTag(id)`. Токен ядра или Bearer панели; сеанс модели — 403 `forged-authority`.
 * 404 `unknown-platform` — контура нет или он выключен; 409 `link-refused` (+ `hopCode`) — хост
 * не принял регистрацию; 503 `hop-unavailable` — хост не ответил.
 */
export interface CoreContourLinkReply {
  /** `http://127.0.0.1:<порт шлюза звена>`; ручка — `/v1/chat/completions` или `/v1/images/generations`. */
  baseUrl: string;
  /** Заглушка ключа метки — `Authorization: Bearer <key>`. */
  key: string;
}

/** Перейдённый порог бюджета контура (`HopBudgetNotice`). */
export const budgetNoticeSchema = z.strictObject({
  seq: z.number().int().positive(),
  at: z.string().min(1),
  platformId: nonEmpty,
  platformTitle: z.string(),
  level: z.enum(['near', 'over']),
  share: z.number(),
});

/** Запись постоянного учёта контура (`PlatformSpendRecord`): дни и отметка «исчерпан». */
const contourSpendRecordSchema = z.looseObject({
  platformId: nonEmpty,
  days: z.array(z.looseObject({ day: z.string() })),
});

export const hopControlRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('register'),
    spec: hopRegisterSpecSchema,
    sessionKey: nonEmpty.optional(),
  }),
  z.strictObject({ op: z.literal('unregister'), tag: nonEmpty }),
  z.strictObject({ op: z.literal('status') }),
  z.strictObject({ op: z.literal('clear-exhausted'), routeId: nonEmpty }),
  z.strictObject({ op: z.literal('spend-of'), tag: nonEmpty }),
  z.strictObject({
    op: z.literal('probe'),
    routeId: nonEmpty,
    url: upstreamSchema,
    keyRef: keyRefSchema,
    auth: z.union([
      z.strictObject({ header: headerName, scheme: headerValue }),
      z.strictObject({ query: nonEmpty }),
    ]),
    headers: z.record(headerName, headerValue).default({}),
  }),
  z.strictObject({
    op: z.literal('user-gateway'),
    port: z.number().int().min(1).max(65_535).nullable(),
    routes: z.array(
      z.strictObject({
        platformId: nonEmpty,
        title: z.string(),
        enabled: z.boolean(),
        consumers: z.array(z.string()).default([]),
        cliNames: z.record(z.string(), z.string()).optional(),
        spec: hopRegisterSpecSchema,
      }),
    ),
  }),
  z.strictObject({
    op: z.literal('dlp-proxy'),
    config: z
      .strictObject({
        port: z.number().int().min(1).max(65_535),
        upstream: z.string().regex(/^https?:\/\//),
        passUnknown: z.boolean(),
        journal: z.boolean(),
      })
      .nullable(),
  }),
  /** Учёт контуров (C3b): след, расход от запуска, счётчики и сводка сжатий — для карточки шлюза. */
  z.strictObject({ op: z.literal('contours') }),
  /** Постоянный учёт контуров по дням (вся запись, включая отметку «исчерпан»). */
  z.strictObject({ op: z.literal('contour-spend') }),
  z.strictObject({
    op: z.literal('contour-run'),
    runTag: nonEmpty,
    since: z.number().int().nonnegative(),
  }),
  z.strictObject({ op: z.literal('contour-summarized') }),
  /** Ход локальных маршрутов сейчас (этап 11, W2-5): этапы, доля промпта, ответ, застой. */
  z.strictObject({ op: z.literal('activity') }),
]);

/**
 * Этап хода локального маршрута: `starting` — сервер поднимается, `loading` — грузит модель,
 * `queued` — запрос ждёт слота, `prompt` — читает промпт, `generating` — пишет ответ.
 */
export const HOP_ACTIVITY_PHASES = [
  'idle',
  'starting',
  'loading',
  'queued',
  'prompt',
  'generating',
] as const;
export type HopActivityPhase = (typeof HOP_ACTIVITY_PHASES)[number];

/**
 * Предел тишины локального маршрута: столько без движения — застой. Один на ленту звена ядра и на
 * снимок панели (`stallMs`), чтобы «застой» в чате и на странице моделей наступал в одну секунду.
 * Видеокарта: пакет промпта там — секунды.
 */
export const HOP_STALL_GPU_MS = 120_000;
/** То же на процессоре: пакет в 2048 токенов у 27B идёт минуту и дольше. */
export const HOP_STALL_CPU_MS = 600_000;

/**
 * Ход одного локального маршрута звена. Сервер опрашивается, только пока по маршруту идёт
 * запрос (`inFlight > 0`); без запросов — `idle` и ни одного опроса.
 */
export const hopActivitySchema = z.strictObject({
  route: nonEmpty,
  model: z.string().min(1).optional(),
  phase: z.enum(HOP_ACTIVITY_PHASES),
  /** Запросов по маршруту в полёте сейчас. */
  inFlight: z.number().int().nonnegative(),
  /** Когда ушёл самый ранний запрос в полёте, мс эпохи. */
  startedAt: z.number().int().nonnegative().optional(),
  /** Прочитано токенов промпта и сколько всего (`total` сервер называет не всегда). */
  prompt: z
    .strictObject({
      filled: z.number().int().nonnegative(),
      total: z.number().int().positive().optional(),
    })
    .optional(),
  /** Токенов ответа написано. */
  decoded: z.number().int().nonnegative().optional(),
  /** Последнее движение (новый токен промпта или ответа, смена этапа), мс эпохи. */
  lastMoveAt: z.number().int().nonnegative(),
  /** Движения нет дольше предела устройства (GPU 120 с, CPU 600 с). */
  stalled: z.boolean(),
});
export type HopActivity = z.output<typeof hopActivitySchema>;

export type HopControlMessage = z.output<typeof hopControlRequestSchema>;
export type HopProbeMessage = Extract<HopControlMessage, { op: 'probe' }>;

const HOP_OPS = [
  'register',
  'unregister',
  'status',
  'clear-exhausted',
  'spend-of',
  'probe',
  'user-gateway',
  'dlp-proxy',
  'contours',
  'contour-spend',
  'contour-run',
  'contour-summarized',
  'activity',
] as const;

const userGatewayStateSchema = z.looseObject({
  port: z.number().int(),
  state: z.enum(['waiting', 'listening']),
  since: z.number(),
  routes: z.array(z.string()),
  lastError: z.string().nullable().optional(),
});

const dlpProxyStateSchema = z.looseObject({
  port: z.number().int(),
  state: z.enum(['waiting', 'listening']),
  since: z.number(),
  upstream: z.string(),
  lastError: z.string().nullable().optional(),
  requests: z.number().int().nonnegative(),
  masked: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
});

const spendSchema = z.looseObject({
  tag: nonEmpty,
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
  money: z.number().nullable(),
  moneyReason: z.enum(HOP_MONEY_REASONS).nullable().optional(),
  priceVersions: z.record(z.string(), z.number()).optional(),
});

const statusSchema = z.looseObject({
  pid: z.number().int(),
  ports: z.object({ dlp: z.number().nullable(), gateway: z.number().nullable() }),
  tags: z.array(z.string()),
  exhausted: z.array(z.object({ routeId: z.string(), exhaustedAt: z.number() })),
  substitutions: z
    .array(
      z.object({
        listener: z.enum(['control', 'dlp', 'gateway']),
        recorded: z.number(),
        actual: z.number(),
        reason: z.string(),
      }),
    )
    .optional(),
  panelAppData: z.string().nullable().optional(),
  userGateway: userGatewayStateSchema.nullable().optional(),
  dlpProxy: dlpProxyStateSchema.nullable().optional(),
});

/** Ответ хоста, как его проверяет клиент: чужая или битая форма — не ответ. */
export const hopControlReplySchema = z.union([
  z.looseObject({
    op: z.literal('register'),
    ok: z.literal(true),
    reply: z.looseObject({ port: z.number().int().positive(), placeholder: nonEmpty }),
  }),
  z.looseObject({ op: z.literal('unregister'), ok: z.literal(true) }),
  z.looseObject({ op: z.literal('status'), ok: z.literal(true), status: statusSchema }),
  z.looseObject({ op: z.literal('clear-exhausted'), ok: z.literal(true), cleared: z.boolean() }),
  z.looseObject({ op: z.literal('spend-of'), ok: z.literal(true), spend: spendSchema.nullable() }),
  z.looseObject({
    op: z.literal('probe'),
    ok: z.literal(true),
    reply: z.looseObject({
      status: z.number().int(),
      body: z.string(),
      contentType: z.string().optional(),
    }),
  }),
  z.looseObject({
    op: z.literal('user-gateway'),
    ok: z.literal(true),
    state: userGatewayStateSchema.nullable(),
  }),
  z.looseObject({
    op: z.literal('dlp-proxy'),
    ok: z.literal(true),
    state: dlpProxyStateSchema.nullable(),
  }),
  z.looseObject({
    op: z.literal('contours'),
    ok: z.literal(true),
    contours: z.looseObject({
      since: z.number(),
      requests: z.number().int().nonnegative(),
      failures: z.number().int().nonnegative(),
      usage: z.array(z.looseObject({ platformId: z.string() })),
      events: z.array(contourEventSchema),
      summarized: z.looseObject({ total: z.number(), recent: z.array(z.looseObject({})) }),
      notices: z.array(budgetNoticeSchema),
    }),
  }),
  z.looseObject({
    op: z.literal('contour-spend'),
    ok: z.literal(true),
    records: z.record(z.string(), contourSpendRecordSchema),
  }),
  z.looseObject({
    op: z.literal('contour-run'),
    ok: z.literal(true),
    summarized: z.boolean(),
    toolCalls: z.number().int().nonnegative().optional(),
  }),
  z.looseObject({
    op: z.literal('contour-summarized'),
    ok: z.literal(true),
    messageIds: z.array(z.string()),
  }),
  z.looseObject({
    op: z.literal('activity'),
    ok: z.literal(true),
    routes: z.array(hopActivitySchema),
  }),
  z.looseObject({
    op: z.enum(HOP_OPS),
    ok: z.literal(false),
    code: z.string(),
    detail: z.string(),
  }),
]);

/** Строка `procs.json` хоста: прочие строки и поля — не дело этой схемы. */
export const hopHostProcRowSchema = z.looseObject({
  kind: z.literal('hop-host'),
  id: nonEmpty,
  pid: z.number().int().nonnegative(),
  pidStart: nonEmpty,
  port: z.number().int().positive(),
  dlpPort: z.number().int().positive().nullable().default(null),
  gatewayPort: z.number().int().positive().nullable().default(null),
  ownerBootId: nonEmpty,
  startedAt: z.number().int().nonnegative(),
});

export const hopHostLaunchSchema = z.strictObject({
  home: nonEmpty,
  panelAppData: nonEmpty.nullable().optional(),
  stallMs: z.number().int().positive().optional(),
  flushMs: z.number().int().positive().optional(),
  retryPauseMs: z.number().int().nonnegative().optional(),
  ownerBootId: nonEmpty.optional(),
  language: z.enum(HOP_LANGUAGES).optional(),
});
