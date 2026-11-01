import { z } from 'zod';
import type { ModelPricing, PricingEntry } from '../app-settings.ts';
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
}

/** Заголовок ключа верха: имя (token RFC 9110) и слово перед ключом. */
export interface HopUpstreamAuth {
  header: string;
  scheme: string;
}

/**
 * Пары перевода шлюза звена (мост `hop-host/gateway/bridge.ts`: Anthropic → OpenAI chat) —
 * ОДИН список для судьи `compat` ядра и для регистрации у хоста: заявить больше, чем мост
 * умеет, значило бы открыть канал, которого нет; хост отказывает регистрации вне списка.
 */
export const HOP_TRANSLATIONS: readonly { from: Dialect; to: Dialect }[] = [
  { from: 'anthropic-messages', to: 'openai-chat' },
];

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
  | ({ op: 'probe' } & HopProbeRequest);

export type HopControlReply =
  | { op: 'register'; ok: true; reply: HopRegisterReply }
  | { op: 'unregister'; ok: true }
  | { op: 'status'; ok: true; status: HopStatus }
  | { op: 'clear-exhausted'; ok: true; cleared: boolean }
  | { op: 'spend-of'; ok: true; spend: HopSpend | null }
  | { op: 'probe'; ok: true; reply: HopProbeReply }
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
});

/** Регистрация, как её держит хост: значения по умолчанию проставлены разбором. */
export type HopRegistration = z.output<typeof hopRegisterSpecSchema>;

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
]);

export type HopControlMessage = z.output<typeof hopControlRequestSchema>;
export type HopProbeMessage = Extract<HopControlMessage, { op: 'probe' }>;

const HOP_OPS = [
  'register',
  'unregister',
  'status',
  'clear-exhausted',
  'spend-of',
  'probe',
] as const;

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
