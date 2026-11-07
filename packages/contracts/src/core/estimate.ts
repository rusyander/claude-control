import { z } from 'zod';
import { CHAT_ATTACHMENT_MAX_BYTES } from '../uploads.ts';
import { commandIssues, commandProofSchema, type CommandIssue } from './commands.ts';
import type { EstimateBasis } from './economy.ts';
import { uuidv7 } from './ids.ts';
import { INTAKE_SOURCES_MAX, intakeSourceSchema } from './intake.ts';
import type { LeadProfile, LeadWarning, TaskClass } from './lead.ts';
import {
  GRANT_OPS,
  LAUNCH_POLICIES,
  taskEnvNameSchema,
  taskSessionSchema,
} from './journal-data.ts';
import { PRESET_IDS, scenarioRefSchema, type OverlayEntry, type ScenarioRef } from './scenario.ts';
import type { GrantConfirmation, UserLayerReport } from './user-layer.ts';

/**
 * Оценка = создание задачи (07:7, G5): `POST /v1/estimate`. Суд полномочий первым, id задачи
 * выдаёт ядро, `task.created.origin.cmdId` — ключ повтора (тот же `cmdId` находит задачу, второй
 * не создаёт). Единицы и цена приходят состоянием задачи и SSE: план — это сессия, не ответ ручки.
 */

const line = (max: number) => z.string().min(1).max(max);

/**
 * Где идёт работа (этап 10, решение 06:98): по умолчанию — копия; в основной папке проекта —
 * только с грантом человека на этот корень. Чат, начатый из панели, несёт грант сам: начало
 * чата и есть разрешение человека; другой вызывающий без гранта получает отказ.
 */
export const placementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('copy') }),
  z.strictObject({
    kind: z.literal('in-place'),
    grant: z.strictObject({ project: line(1000), ops: z.array(z.enum(GRANT_OPS)).min(1) }),
  }),
]);
export type Placement = z.infer<typeof placementSchema>;

/**
 * Разговор CLI, который чат продолжает (этап 10, F2): начат не ядром — в терминале или прежним
 * исполнителем панели. Id — только просьба: ядро продолжит разговор, лишь когда переходник CLI сам
 * подтвердит, что транскрипт этого id лежит в хранилище CLI для ЭТОГО корня; иначе отказ по имени.
 * Форма id — без разделителей пути: из него переходник собирает имя файла.
 */
export const resumeSchema = z.strictObject({
  adapter: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  conversationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
});
export type EstimateResume = z.infer<typeof resumeSchema>;

export const estimateFieldsSchema = z.strictObject({
  title: line(300),
  /** Источник требований, хранится артефактом (02:54). */
  request: z.string().min(1).max(64_000),
  repos: z
    .array(z.strictObject({ path: line(1000), baseRef: line(300).nullable() }))
    .min(1)
    .max(8),
  scenario: z.union([scenarioRefSchema, z.strictObject({ preset: z.enum(PRESET_IDS) })]),
  launchPolicy: z.enum(LAUNCH_POLICIES),
  /** Ждать ли CI — живое решение человека для этой задачи (R:S1-09). */
  ciWait: z.boolean(),
  /** Нет — копия (06:98). `in-place` — один репозиторий, грант на его путь, сценарий `chat`. */
  placement: placementSchema.optional(),
  /** Продолжить разговор CLI, начатый не ядром; только чат на месте (`placementProblems`). */
  resume: resumeSchema.optional(),
  /**
   * Язык панели, с которой задача запущена: вопросы человеку, которые ядро пишет само (точка 10 —
   * вопрос запуска), — на нём. Нет поля — английский, как вся проза ядра (P32).
   */
  lang: z.enum(['ru', 'en']).optional(),
  /**
   * Настройки сеанса чата (этап 10, F6): имена переменных пина, без брифа, границы правки.
   * Только сценарий чата; имена `env` обязаны совпасть с ключами `env` тела в обе стороны.
   */
  session: taskSessionSchema.optional(),
  /**
   * Этап 11 (P133): снимок источника задачи (трекер, текст, голос, пункт группы); `request` тогда
   * — его тело. Несколько пунктов — `sources`. Оба поля сразу — противоречие, его называет приём
   * (`conductor/intake`), а не схема: здесь без уточнений, поля оценки только расширяются.
   */
  source: intakeSourceSchema.optional(),
  sources: z.array(intakeSourceSchema).min(1).max(INTAKE_SOURCES_MAX).optional(),
  /** Этап 11: разговор чата, из которого запуск; в задаче — `task.created.launchOrigin`. */
  launchOrigin: z
    .strictObject({
      kind: z.literal('chat'),
      conversationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    })
    .optional(),
});
export type EstimateFields = z.infer<typeof estimateFieldsSchema>;

/**
 * Вложение хода чата (этап 10, s10 G11): байты файла, который человек приложил к сообщению. Ядро
 * сверяет их (расширение из списка панели, предел, байты картинки против расширения), кладёт копию
 * в каталог вложений задачи (рядом с домом ядра) и открывает сеансу задачи чтение только этой копии — файл из дома панели модель
 * не читает. Путь копии ядро само дописывает к тексту блоком `ATTACHMENTS_MARKER`.
 */
export const chatAttachmentSchema = z.strictObject({
  name: z.string().min(1).max(200),
  base64: z
    .string()
    .min(1)
    .max(Math.ceil(CHAT_ATTACHMENT_MAX_BYTES / 3) * 4),
});
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;
export const CHAT_ATTACHMENTS_MAX_COUNT = 16;
/** Тело оценки с вложениями больше общего предела API ядра: свой предел маршрута (как у панели). */
export const ESTIMATE_BODY_LIMIT = 64 * 1024 * 1024;

/** Тело `POST /v1/estimate`; `proof` — тот же, что у команды (число страницы, подпись устройства). */
export const estimateBodySchema = z.strictObject({
  cmdId: uuidv7,
  fields: estimateFieldsSchema,
  proof: commandProofSchema,
  /**
   * ЗНАЧЕНИЯ переменных `fields.session.env` (этап 10, F6). Вне `fields` намеренно: поля оценки
   * уходят в журнал, значения — нет, они живут только в памяти ядра до конца задачи.
   */
  env: z.record(taskEnvNameSchema, z.string().max(32_000)).optional(),
  /** Вложения первого слова чата; вне `fields` по той же причине: байты в журнал не ложатся. */
  attachments: z.array(chatAttachmentSchema).min(1).max(CHAT_ATTACHMENTS_MAX_COUNT).optional(),
});
export type EstimateBody = z.infer<typeof estimateBodySchema>;

/**
 * `POST /v1/tasks/:id/attachments` — вложение следующего хода того же чата: одно на звонок, класс
 * полномочий — как у `message-to-step`, которому оно служит. Ответ — путь копии ядра; панель
 * называет его в тексте `message-to-step` (в команду, а значит и в журнал, уходит только путь).
 * `cmdId` — ключ повтора: тот же id с теми же байтами отвечает той же копией.
 */
export const taskAttachmentBodySchema = z.strictObject({
  cmdId: uuidv7,
  attachment: chatAttachmentSchema,
  proof: commandProofSchema,
});
export type TaskAttachmentBody = z.infer<typeof taskAttachmentBodySchema>;
export interface TaskAttachmentReply {
  /** Абсолютный путь копии в каталоге вложений задачи. */
  file: string;
  name: string;
  bytes: number;
}
export const TASK_ATTACHMENT_BODY_LIMIT = Math.ceil(CHAT_ATTACHMENT_MAX_BYTES / 3) * 4 + 64 * 1024;
export const taskAttachmentsPath = (taskId: string): string =>
  `/v1/tasks/${encodeURIComponent(taskId)}/attachments`;

/** Разбор тела оценки: ошибка — список проблем с путём, как у команды (400, P42). */
export function parseEstimateBody(
  input: unknown,
): { ok: true; body: EstimateBody } | { ok: false; issues: CommandIssue[] } {
  const parsed = estimateBodySchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: commandIssues(parsed.error.issues, '', input) };
  return { ok: true, body: parsed.data };
}

export const PREFLIGHT_STATUS = ['ok', 'failed', 'not-checked'] as const;
export type PreflightStatus = (typeof PREFLIGHT_STATUS)[number];

export interface EstimateReply {
  taskId: string;
  seq: number;
  /** `refused` — дорога предпроверки упала или сценарий/правка негодны: задача есть, ничего не идёт. */
  state: 'estimating' | 'refused';
  replayed: boolean;
  preflight: { road: string; status: PreflightStatus; detail: string }[];
  overlay: { rejected: OverlayEntry[] };
  scenario: ScenarioRef | null;
  problems: string[];
  /**
   * Числа из истории прогонов (03 §Economy): `history` — оценка и разброс [p10, p90] в токенах;
   * `no-history` — истории нет, числа `null`, а не выдуманные.
   */
  estimate: {
    minutes: number | null;
    tokens: number | null;
    spread: [number, number] | null;
    basis: EstimateBasis;
  };
  /** Слой пользователя на экране запуска (07:23-24): опись, режимы, подмены, предупреждения. */
  userLayer: UserLayerReport;
  /** Гранты, которые человек подтверждает до запуска (06:108-112); нет — пусто. */
  grants: GrantConfirmation[];
  /**
   * Этап 11 (P144, W2-6, W3-16): ведение задачи, как его называет экран запуска — профиль,
   * действующая параллельность и срезанные расширения; класс — когда решён (до разведки — `null`);
   * ожидание места сеанса — мс, `null` — не оценено. Нет поля — задача не ведущего (чат, ревью).
   */
  lead?: {
    profile: LeadProfile;
    class: TaskClass | null;
    parallelism: number;
    warnings: LeadWarning[];
    sessionWaitMs: number | null;
  };
  /**
   * Этап 11 (D18, W3-18): `sources` из N пунктов — N задач одной группы; `taskId` выше — первая из
   * `taskIds`. Нет поля — оценка создала одну задачу.
   */
  group?: { groupId: string; taskIds: string[] };
}
