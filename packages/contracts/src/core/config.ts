import { z } from 'zod';
import { commandIssues, commandProofSchema, type CommandIssue } from './commands.ts';
import { registryId, uuidv7 } from './ids.ts';
import { GRANT_OPS } from './journal-data.ts';
import { LEAD_PARALLELISM_MAX, leadSectionSchema } from './lead.ts';
import { BOARD_STOPS } from './board.ts';
import { inboxSectionSchema } from './inbox.ts';
import { SESSION_STEP_KINDS } from './model-tools.ts';

/**
 * Настройка ядра `<дом ядра>/config.json` (00:58): один строгий документ, один читатель
 * (`platform/core-config/read.ts`), один писатель — API ядра (`POST /v1/config`, суд
 * `human-strict`). Ни файлы репозитория, ни модель её не пишут (F23).
 *
 * Схемы пяти прежних разделов ПЕРЕНЕСЕНЫ из их разборщиков без изменения принятой формы: чего
 * разборщик не проверял (лишние ключи объекта), то и здесь пропускается (`looseObject`). Сам
 * документ строгий: неизвестный раздел — жалоба читателя, а не молчаливое расширение.
 */

export const CONFIG_SECTIONS = [
  'routes', // bootstrap/core-routes.ts parseRouteConfig
  'readAllow', // bootstrap/session-road/read-allow.ts parseReadAllow
  'grantRequired', // bootstrap/session-road/permit-sources.ts parseGrantRequired
  'forgePoll', // bootstrap/forge-wiring/poll-config.ts parseForgePoll
  'queue', // verifier/queue/config.ts parseQueueSection
  'humanPoints', // новый: список пункта 5 (06:22)
  'trustedRepos', // новый: отметка доверия панели (03:44), пути исходных репозиториев
  'cliPaths', // этап 9 (F9): явный путь к CLI переходника, выигрывает у поиска
  'mcpPicks', // s10 p7 (P73): какие серверы MCP человека отданы виду шага
  'economy', // s10 p8: рычаги экономии шагов задачи (порт рычагов групп панели)
  'lead', // этап 11 (D11): профиль ведения — умолчания машины и правки по проектам
  'board', // этап 12 (D5): пределы доски — сколько в работе, стартов в сутки, пауза, остановка
  'inbox', // этап 12 (D16): источники входящих, частота опроса, комментарий назад
  'telegram', // этап 12 (D29): привязанный владелец Telegram — отпечаток, не номер
] as const;
export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

// ── routes: заглушки и своя модель (11 R:PR-08) ────────────────────────────────────────────
// Имя «пустое», если в нём одни пробелы, — так судил разборщик (`!raw.name.trim()`).
const routeName = z.string().refine((s) => s.trim().length > 0, 'not a name');
const stubRouteSchema = z.looseObject({
  name: routeName,
  // Шаги сценария целиком (их форму судит маршрут-заглушка) или модуль с экспортом.
  script: z.union([
    z.array(z.unknown()),
    z.looseObject({ module: z.string(), export: z.string() }),
  ]),
  models: z.array(z.string()).optional(),
  trace: z.string().optional(),
});
const ownModelSchema = z.looseObject({
  id: z.string(),
  path: z.string(),
  sizeBytes: z.number().positive(),
});
const ownRouteSchema = z.looseObject({
  server: z.looseObject({
    command: z.string().min(1),
    leadArgs: z.array(z.string()).optional(),
    extraArgs: z.array(z.string()).optional(),
  }),
  models: z.array(ownModelSchema).min(1),
});
/**
 * Сервер моделей человека (этап 10, маршрут `local:user:<id>`): только HTTP — ядро пробует его,
 * читает модели и шлёт вызовы, но никогда не запускает, не останавливает и не снимает процесс.
 * Ключ — ИМЯ переменной окружения; значение в настройку не попадает.
 */
export const userRouteSchema = z.strictObject({
  id: registryId,
  baseUrl: z.url(),
  dialect: z.enum(['openai-chat', 'anthropic-messages']),
  keyVar: z.string().min(1).optional(),
  /** Нет — список читается с `/v1/models` сервера. */
  models: z.array(z.string().min(1)).optional(),
});
export type UserRoute = z.infer<typeof userRouteSchema>;
export const routesSectionSchema = z.looseObject({
  stub: z.array(stubRouteSchema).optional(),
  localOwn: ownRouteSchema.optional(),
  localUser: z.array(userRouteSchema).optional(),
});

// ── readAllow: путь репозитория → список чтения вне копии (F-87) ───────────────────────────
// Разборщик проверял только запись своего репозитория; общая форма — строки по ключу пути.
export const readAllowSectionSchema = z.record(z.string(), z.array(z.string()));

// ── grantRequired: правка под маской только с грантом (06:108-112) ─────────────────────────
export const grantRequiredSectionSchema = z.array(
  z.looseObject({
    project: z.string(),
    globs: z.array(z.string().min(1)).min(1),
    ops: z.array(z.enum(GRANT_OPS)).min(1),
  }),
);

// ── forgePoll: репозитории, где включён опрос форжа (05:77) ───────────────────────────────
export const forgePollSectionSchema = z.array(z.string().min(1));

// ── queue: слоты и такты очереди проверок (D§3.8) ─────────────────────────────────────────
/**
 * Пределы полей очереди: (0, max], целое, где так. `beatMs.min` — пол такта очереди
 * (`verifier/queue/order.ts` `MIN_BEAT_MS`; тест читателя держит их равными).
 */
export const QUEUE_LIMITS = {
  slots: { min: 0, max: 256, integer: true },
  shareCap: { min: 0, max: 1, integer: false },
  agingMs: { min: 0, max: 24 * 3_600_000, integer: true },
  beatMs: { min: 50, max: 600_000, integer: true },
  /** Этап 11 (P141): места сеансов задач на машине; не больше предела параллельности ведущего. */
  sessionSlots: { min: 0, max: LEAD_PARALLELISM_MAX, integer: true },
} as const;
const queueField = (f: keyof typeof QUEUE_LIMITS) => {
  const { min, max, integer } = QUEUE_LIMITS[f];
  const n = (integer ? z.number().int() : z.number()).positive().max(max);
  return (min > 0 ? n.min(min) : n).optional();
};
export const queueSectionSchema = z.looseObject({
  slots: queueField('slots'),
  shareCap: queueField('shareCap'),
  agingMs: queueField('agingMs'),
  beatMs: queueField('beatMs'),
  sessionSlots: queueField('sessionSlots'),
});

// ── новые разделы этапа 7 ────────────────────────────────────────────────────────────────
/** Пункт человека 5 (06:22): классы действий и маски путей, записи в трекер и фордж. */
export const humanPointsSchema = z.strictObject({
  actionClasses: z.array(z.string().min(1)).max(50),
  pathGlobs: z.array(z.string().min(1)).max(200),
  trackerWrites: z.enum(['ask', 'auto']),
  forgeWrites: z.enum(['ask', 'auto']),
});
export const trustedReposSchema = z.array(z.string().min(1)).max(500);

// ── cliPaths: переходник → исполняемый файл его CLI (этап 9, F9) ───────────────────────────
/**
 * Путь только абсолютный: относительный разрешился бы от каталога сессии, у каждой своего, и один
 * и тот же раздел запускал бы разные файлы. Предпроверка дороги `cli` и запуск сессии читают
 * раздел на каждом обращении — правка действует со следующего сеанса без перезапуска ядра.
 */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
export const cliPathsSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'adapter id'),
  z.string().max(1024).regex(ABSOLUTE_PATH, 'absolute path'),
);

// ── mcpPicks: вид шага → серверы MCP человека (P73, s10 p7) ───────────────────────────────
/**
 * Выбор человека: какие свои серверы MCP он дал виду шага. По умолчанию — ни одного (строгий
 * список). Сервер берётся из предложений CLI сеанса (`mcpSource` переходника: конфиг MCP самого
 * CLI в его порядке пользователь/проект); выбранный, но не предложенный — выпадает с причиной.
 */
export const mcpPicksSchema = z.partialRecord(
  z.enum(SESSION_STEP_KINDS),
  z.array(z.string().min(1).max(128)).max(50),
);

// ── economy: рычаги экономии шагов задачи (s10 p8, порт рычагов групп панели) ──────────────
/**
 * Границы — те же, что у панели (CLI отверг бы меньшее молча). Нет раздела или поля — умолчание
 * панели (`CORE_ECONOMY_DEFAULTS`, решение s10 p9); `0` / `false` — рычаг выключен явно, решает
 * CLI. Чат панели (chat@1) рычагов не получает, как разговор панели прежде.
 */
const leverOrOff = (min: number, max: number) =>
  z.union([z.literal(0), z.number().int().min(min).max(max)]).optional();

export const economySectionSchema = z.strictObject({
  compactWindow: leverOrOff(100_000, 1_000_000),
  bashOutputChars: leverOrOff(4_000, 128_000),
  readOutputTokens: leverOrOff(2_000, 100_000),
  cacheTtl: z.enum(['5m', '1h']).optional(),
  detachIde: z.boolean().optional(),
  workHabits: z.boolean().optional(),
});

/**
 * Умолчания рычагов — умолчания групп панели (`GROUP_ECONOMY_DEFAULTS`: вывод оболочки 8000 знаков,
 * чтение 10 000 токенов, IDE отключена, строка привычек); окно сжатия и срок кэша по умолчанию не
 * трогаются. Поле раздела перекрывает своё умолчание.
 */
export const CORE_ECONOMY_DEFAULTS = {
  bashOutputChars: 8_000,
  readOutputTokens: 10_000,
  detachIde: true,
  workHabits: true,
} as const satisfies z.infer<typeof economySectionSchema>;

// ── board: пределы доски задач (этап 12, D5) ───────────────────────────────────────────────
/**
 * Раздел машинный, один на все проекты: доска запускает голову очереди, только пока задач в работе
 * меньше `inWork`, доска не на паузе и за местные сутки стартов меньше `perDay` (`null` — без
 * предела). Над распределителем мест (P141), оба действуют. `stopOnQuestion` — пока хоть одна
 * карточка ждёт человека, новых стартов нет. Нет раздела — `BOARD_DEFAULTS`.
 */
export const boardSectionSchema = z.strictObject({
  inWork: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(6)]),
  perDay: z.number().int().min(1).max(50).nullable(),
  paused: z.boolean(),
  stopOnQuestion: z.boolean(),
  defaultStop: z.enum(BOARD_STOPS),
});
export type BoardSection = z.infer<typeof boardSectionSchema>;

/** Умолчания доски: две задачи в работе, без суточного предела, без паузы, остановка «до MR». */
export const BOARD_DEFAULTS: BoardSection = {
  inWork: 2,
  perDay: null,
  paused: false,
  stopOnQuestion: false,
  defaultStop: 'mr',
};

// ── telegram: привязанный владелец (этап 12, D29, P187) ──────────────────────────────────────
/**
 * Человек открывает канал Telegram записью `set-config` строгого класса: ядро хранит только
 * отпечаток sha256 от `apiBase|botId|chatId|fromId` (`telegramOwnerInput`), а не номера. `null` —
 * канал закрыт. Подпись — что показать человеку в панели, суд её не читает.
 */
export const telegramSectionSchema = z.strictObject({
  owner: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'sha256')
    .nullable(),
  label: z
    .strictObject({ bot: z.string().min(1).max(100), account: z.string().min(1).max(200) })
    .optional(),
  /**
   * Репозитории записей `/task` (W2-D): запись из Telegram несёт их в `launch.fields.repos` и
   * стартует без выбора на доске. Пишет только человек (`set-config`, строгий класс); нет поля —
   * запись ждёт репозиторий на доске, «В работу» не предлагается.
   */
  repos: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1000),
        baseRef: z.string().min(1).max(300).nullable(),
      }),
    )
    .min(1)
    .max(8)
    .optional(),
});
export type TelegramSection = z.infer<typeof telegramSectionSchema>;

/** Схема каждого раздела — таблица исчерпывающая: новый раздел не соберётся без своей схемы. */
export const CONFIG_SECTION_SCHEMAS = {
  routes: routesSectionSchema,
  readAllow: readAllowSectionSchema,
  grantRequired: grantRequiredSectionSchema,
  forgePoll: forgePollSectionSchema,
  queue: queueSectionSchema,
  humanPoints: humanPointsSchema,
  trustedRepos: trustedReposSchema,
  cliPaths: cliPathsSchema,
  mcpPicks: mcpPicksSchema,
  economy: economySectionSchema,
  lead: leadSectionSchema,
  board: boardSectionSchema,
  inbox: inboxSectionSchema,
  telegram: telegramSectionSchema,
} as const satisfies Record<ConfigSection, z.ZodType>;

export const coreConfigSchema = z.strictObject({
  /** Нет — файл до этапа 7: ядро принимает его один раз при загрузке. */
  v: z.literal(1).optional(),
  routes: routesSectionSchema.optional(),
  readAllow: readAllowSectionSchema.optional(),
  grantRequired: grantRequiredSectionSchema.optional(),
  forgePoll: forgePollSectionSchema.optional(),
  queue: queueSectionSchema.optional(),
  humanPoints: humanPointsSchema.optional(),
  trustedRepos: trustedReposSchema.optional(),
  cliPaths: cliPathsSchema.optional(),
  mcpPicks: mcpPicksSchema.optional(),
  economy: economySectionSchema.optional(),
  lead: leadSectionSchema.optional(),
  board: boardSectionSchema.optional(),
  inbox: inboxSectionSchema.optional(),
  telegram: telegramSectionSchema.optional(),
});
export type CoreConfig = z.infer<typeof coreConfigSchema>;

/**
 * Тело `POST /v1/config` (G11: настройка машины — не команда задачи): документ целиком, ключ
 * повтора `cmdId`, оптимистичная сверка по отпечатку последней записи ядра, доказательство — то
 * же, что у команды.
 */
export const setConfigBodySchema = z.strictObject({
  cmdId: uuidv7,
  doc: coreConfigSchema,
  baseDigest: z.string().regex(/^[0-9a-f]{64}$/, 'sha256'),
  proof: commandProofSchema,
});
export type SetConfigBody = z.infer<typeof setConfigBodySchema>;

export function parseSetConfigBody(
  input: unknown,
): { ok: true; body: SetConfigBody } | { ok: false; issues: CommandIssue[] } {
  const parsed = setConfigBodySchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: commandIssues(parsed.error.issues, '', input) };
  return { ok: true, body: parsed.data };
}

/** Что отдаёт `GET /v1/config`. */
export interface ConfigView {
  /** Действующий документ = последний, записанный ядром. */
  doc: CoreConfig;
  /** sha256 действующего документа. */
  digest: string;
  /** Файл правлен мимо API (G6): не действует, ждёт подтверждения человека. */
  drift: null | { fileDigest: string; sections: string[]; at: number };
  /** Раздел, который не прошёл свою схему (или неизвестный ключ), — с причиной. */
  issues: { section: string; reason: string }[];
}

/** Расширение настройки, которое запись применила и назвала (сужение молчит). */
export interface ConfigWidening {
  section: string;
  detail: string;
}

/**
 * Ответ `POST /v1/config` (200); `replayed` — тот же `cmdId` уже применён. `warnings` — что эта
 * запись расширила (пункт человека снят, `ask → auto`, маска чтения шире); повтор отдаёт те же.
 */
export interface SetConfigReply {
  view: ConfigView;
  replayed: boolean;
  warnings: ConfigWidening[];
}
