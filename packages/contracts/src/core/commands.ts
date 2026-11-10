import { z } from 'zod';
import { BOARD_STOPS } from './board.ts';
import { registryId, uuidv7 } from './ids.ts';
import { allowedRouteSchema, COMMAND_TIMINGS, GRANT_OPS, OVERRIDE_SCOPES } from './journal-data.ts';
import { LEAD_ROLES } from './lead.ts';
import { scenarioSchema } from './scenario.ts';

/**
 * Команды человека ядру (01 §Commands, F23 F26). Конверт строгий, поля каждого вида — полный
 * строгий список: лишнее или недостающее поле — 400, никогда не значение по умолчанию, которое
 * что-то правит (P42). `cmdId` делает клиент (UUIDv7); повтор того же `cmdId` возвращает
 * сохранённый исход без второго действия (P47).
 *
 * Модель, усилие и переходник CLI — id из реестра, который наполняют переходники, а не
 * закрытый список имён: ядро работает с любым провайдером (владелец, 28.10).
 */

const scope = z.enum(OVERRIDE_SCOPES);
const empty = z.strictObject({});
const line = (max: number) => z.string().min(1).max(max);
/** Когда правка доходит до шага: в безопасной точке (по умолчанию в 02:78) или сразу (G9). */
const timing = z.enum(COMMAND_TIMINGS);
/** Единица в правке деления — те же поля, что у предложения плана, но все названы (P42). */
const unitEdit = z.strictObject({
  name: line(200),
  ownedPaths: z.array(z.string().min(1)).min(1),
  deps: z.array(line(200)),
  repo: line(500).nullable(),
  contract: z.boolean(),
});

export const COMMAND_FIELDS = {
  launch: empty,
  /** 02:78 «пауза в ближайшей безопасной точке»; `now` — остановка дерева сразу (G10). */
  pause: z.strictObject({ now: z.boolean() }),
  resume: empty,
  cancel: z.strictObject({ reason: z.string().min(1).max(2000) }),
  'set-model': z.strictObject({
    scope,
    scopeId: uuidv7,
    model: registryId,
    effort: registryId.nullable(),
    timing,
  }),
  'set-cli': z.strictObject({ scope, scopeId: uuidv7, adapter: registryId, timing }),
  /**
   * Новая версия сценария целиком в команде (G11); `baseVersion` не последняя — 409, как
   * устаревший `expectSeq`.
   */
  'edit-scenario': z.strictObject({
    scenario: scenarioSchema,
    baseVersion: z.number().int().positive(),
    applyNow: z.boolean(),
  }),
  answer: z.strictObject({ askId: uuidv7, answer: z.string().min(1).max(16_000) }),
  'approve-split': z.strictObject({ splitId: uuidv7 }),
  'edit-split': z.strictObject({ splitId: uuidv7, units: z.array(unitEdit).min(1).max(20) }),
  /** Правка списка требований на экране запуска / деления (G2) — единственная дорога к `waived`. */
  'edit-requirements': z
    .strictObject({
      add: z.array(z.strictObject({ text: line(2000) })).max(100),
      waive: z.array(z.strictObject({ requirementId: uuidv7, reason: line(2000) })).max(200),
    })
    .refine((v) => v.add.length + v.waive.length > 0, { message: 'add or waive at least one' }),
  'fresh-rerun': z.strictObject({
    scope: z.enum(['check', 'unit', 'key']),
    ref: z.string().min(1),
  }),
  'publish-now': z.strictObject({ unitId: uuidv7 }),
  'move-build': z.strictObject({ build: z.string().min(1) }),
  'message-to-step': z.strictObject({ stepId: uuidv7, text: z.string().min(1).max(16_000) }),
  /**
   * Закрыть шаг `chat` (этап 10): ход человека — `message-to-step`, конец разговора — только эта
   * команда или отмена задачи. Шаг другого вида команда не закрывает (409 `not-a-chat`).
   */
  'end-chat': z.strictObject({ stepId: uuidv7 }),
  'release-resource': z.strictObject({ rid: uuidv7 }),
  grant: z.strictObject({
    project: z.string().min(1),
    globs: z.array(z.string().min(1)).min(1),
    ops: z.array(z.enum(GRANT_OPS)).min(1),
  }),
  /** Ветки и теги задачи на сервере (06:19); `remote` — не `origin`, когда задача пушила в другой. */
  'clean-remote': z.strictObject({
    branches: z.array(z.string().min(1)).min(1),
    tags: z.array(z.string().min(1)).optional(),
    remote: z.string().min(1).optional(),
  }),
  /** Единственный путь расширить разрешённые маршруты — живой ход человека (11 §Policy, R:PR-15). */
  /** Новый разрешённый набор целиком: шире или уже прежнего — решает сравнение, а не флаг. */
  'set-route': z.strictObject({
    scope,
    scopeId: uuidv7,
    allowedRoutes: z.array(allowedRouteSchema).min(1),
  }),
  /** Снять исчерпание маршрута (ответ 402): только человек, ядро и звено само не снимают (P122). */
  'clear-exhausted': z.strictObject({ routeId: registryId }),
  /**
   * Этап 12 (08e): перехват — человек ведёт единицу сам в чате её копии, конвейер задачи стоит;
   * суд строгий, как у гранта: правка копии рукой человека мимо шагов ядра.
   */
  'take-over': empty,
  /** Вернуть перехваченную единицу ядру; `note` — что человек сделал, уходит в бриф шага. */
  'hand-back': z.strictObject({ note: line(16_000).optional() }),
  /** Где задача остановится сама (P157); после `publish.mr` — отказ. */
  'set-stop': z.strictObject({ stop: z.enum(BOARD_STOPS) }),
  /** Доработка готовой работы словами человека: новый круг шага работы с этим текстом. */
  rework: z.strictObject({ text: line(16_000) }),
} as const;

export type CommandKind = keyof typeof COMMAND_FIELDS;
/**
 * Что судит суд полномочий: каждая команда и оценка (`POST /v1/estimate`, G5) — оценка не команда
 * задачи (задачи ещё нет), но человека доказывает так же. Запись настройки ядра
 * (`POST /v1/config`, G11) — тоже не команда задачи: настройка машинная, задачи у неё нет.
 * Этап 9: `save-scenario` — новый сценарий в библиотеку (`POST /v1/scenarios`, однократная
 * запись, F6) и `adopt-devices` — перенос привязанных ключей телефона в устройства ядра (F11);
 * оба машинные, задачи у них нет.
 */
export type AuthorityKind =
  | CommandKind
  | 'estimate'
  | 'ask'
  | 'set-config'
  | 'save-scenario'
  | 'adopt-devices'
  | 'learned-reset'
  /** Этап 12: ход человека на доске (`POST /v1/board/move`) — машинный, задачи у записи ещё нет. */
  | 'board-move'
  /** Этап 12 (P167): записи во «Входящие» из поиска или `/task` Telegram — только записи, не задача. */
  | 'inbox-create';
export const COMMAND_KINDS = Object.keys(COMMAND_FIELDS) as CommandKind[];

/**
 * Доказательство в теле: одноразовое число ядра и подпись устройства (заголовок формата
 * `phone-signing`). Токен и пир-процесс в тело не входят — их устанавливает канал (06).
 */
export const commandProofSchema = z.strictObject({
  nonce: z.string().min(1).max(200).optional(),
  /** Загрузка страницы, для которой ядро выдало `nonce`: число чужой загрузки не принимается. */
  page: uuidv7.optional(),
  signature: z.string().min(1).max(2000).optional(),
});

export const commandEnvelopeSchema = z.strictObject({
  cmdId: uuidv7,
  kind: z.enum(COMMAND_KINDS as unknown as [CommandKind, ...CommandKind[]]),
  target: z.strictObject({ taskId: uuidv7 }),
  expectSeq: z.number().int().nonnegative().optional(),
  fields: z.json(),
  proof: commandProofSchema,
});

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

/**
 * Ключ обучения (`LearnedKey` в `economy.ts`, этап 11 P140) как его называет человек. `role` нет —
 * строка до этапа 11 (роль по умолчанию вида шага); `model: null` — модель по умолчанию CLI.
 */
export const learnedKeySchema = z.strictObject({
  project: line(1000),
  stepKind: line(100),
  adapter: registryId,
  route: registryId,
  model: registryId.nullable(),
  role: z.enum(LEAD_ROLES).optional(),
});

/**
 * Тело сброса ключа обучения (этап 11, P140): только человек (суд `learned-reset`). Машинное, как
 * `set-config`: ключ — строка таблицы обучения ядра, а не задачи, поэтому не конверт команды с
 * `target.taskId`. Подъём, заработанный ключом, снимается целиком; автоматического понижения нет.
 */
export const learnedResetBodySchema = z.strictObject({
  cmdId: uuidv7,
  key: learnedKeySchema,
  proof: commandProofSchema,
});
export type LearnedResetBody = z.infer<typeof learnedResetBodySchema>;

/** Ответ `POST /v1/learned/reset`. */
export interface LearnedResetReply {
  cmdId: string;
  /** Строка ключа в таблице обучения (`keyOf`: роль по умолчанию вида шага подставлена). */
  key: string;
  at: number;
}

/** Разбор конверта и полей вида; ошибка — список проблем с путём, для 400 с типизированным кодом. */
export interface CommandIssue {
  path: string;
  code: 'unknown-field' | 'missing-field' | 'invalid-field';
  message: string;
}

export function parseCommand(
  input: unknown,
): { ok: true; command: CommandEnvelope } | { ok: false; issues: CommandIssue[] } {
  const envelope = commandEnvelopeSchema.safeParse(input);
  if (!envelope.success)
    return { ok: false, issues: commandIssues(envelope.error.issues, '', input) };
  const raw = envelope.data.fields;
  const fields = COMMAND_FIELDS[envelope.data.kind].safeParse(raw);
  if (!fields.success) {
    return { ok: false, issues: commandIssues(fields.error.issues, 'fields', raw) };
  }
  return { ok: true, command: { ...envelope.data, fields: fields.data } };
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let at = root;
  for (const key of path) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<PropertyKey, unknown>)[key];
  }
  return at;
}

/** Проблемы zod → 400 с путём; общий разбор команд и тела `/v1/estimate` (`estimate.ts`). */
export function commandIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: string,
  root: unknown,
): CommandIssue[] {
  return issues.flatMap((issue): CommandIssue[] => {
    const base = [prefix, ...issue.path.map(String)].filter(Boolean).join('.');
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        path: [base, key].filter(Boolean).join('.'),
        code: 'unknown-field',
        message: 'unknown field',
      }));
    }
    // Нет поля во входе — 400 «нет поля», а не «плохое значение»: по самому входу, а не по
    // тексту сообщения zod (у перечисления отсутствие называется «invalid option»).
    const missing = issue.path.length > 0 && valueAt(root, issue.path) === undefined;
    return [
      { path: base, code: missing ? 'missing-field' : 'invalid-field', message: issue.message },
    ];
  });
}

/** Ответ на команду — сохранённый исход; повтор `cmdId` отдаёт его же. */
export interface CommandOutcome {
  cmdId: string;
  status: 'applied' | 'rejected';
  code?: string;
  reason?: string;
  seq: number;
  outcome?: unknown;
}
