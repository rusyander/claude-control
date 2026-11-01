import { z } from 'zod';
import { commandIssues, commandProofSchema, type CommandIssue } from './commands.ts';
import { uuidv7 } from './ids.ts';
import { GRANT_OPS } from './journal-data.ts';

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
export const routesSectionSchema = z.looseObject({
  stub: z.array(stubRouteSchema).optional(),
  localOwn: ownRouteSchema.optional(),
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
