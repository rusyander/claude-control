import { z } from 'zod';
import { registryId, uuidv7 } from './ids.ts';
import { allowedRouteSchema } from './journal-data.ts';

/**
 * Команды человека ядру (01 §Commands, F23 F26). Конверт строгий, поля каждого вида — полный
 * строгий список: лишнее или недостающее поле — 400, никогда не значение по умолчанию, которое
 * что-то правит (P42). `cmdId` делает клиент (UUIDv7); повтор того же `cmdId` возвращает
 * сохранённый исход без второго действия (P47).
 *
 * Модель, усилие и переходник CLI — id из реестра, который наполняют переходники, а не
 * закрытый список имён: ядро работает с любым провайдером (владелец, 28.10).
 */

const scope = z.enum(['task', 'unit', 'step']);
const empty = z.strictObject({});

export const COMMAND_FIELDS = {
  launch: empty,
  pause: empty,
  resume: empty,
  cancel: z.strictObject({ reason: z.string().min(1).max(2000) }),
  'set-model': z.strictObject({
    scope,
    scopeId: uuidv7,
    model: registryId,
    effort: registryId.nullable(),
  }),
  'set-cli': z.strictObject({ scope, scopeId: uuidv7, adapter: registryId }),
  'edit-scenario': z.strictObject({
    scenarioId: z.string().min(1),
    version: z.number().int().nonnegative(),
    applyNow: z.boolean(),
  }),
  answer: z.strictObject({ askId: uuidv7, answer: z.string().min(1).max(16_000) }),
  'approve-split': z.strictObject({ splitId: uuidv7 }),
  'edit-split': z.strictObject({
    splitId: uuidv7,
    units: z
      .array(z.strictObject({ name: z.string().min(1), ownedPaths: z.array(z.string().min(1)) }))
      .min(1),
  }),
  'fresh-rerun': z.strictObject({
    scope: z.enum(['check', 'unit', 'key']),
    ref: z.string().min(1),
  }),
  'publish-now': z.strictObject({ unitId: uuidv7 }),
  'move-build': z.strictObject({ build: z.string().min(1) }),
  'message-to-step': z.strictObject({ stepId: uuidv7, text: z.string().min(1).max(16_000) }),
  'release-resource': z.strictObject({ rid: uuidv7 }),
  grant: z.strictObject({
    project: z.string().min(1),
    globs: z.array(z.string().min(1)).min(1),
    ops: z.array(z.enum(['edit', 'exec-db'])).min(1),
  }),
  'clean-remote': z.strictObject({ branches: z.array(z.string().min(1)).min(1) }),
  /** Единственный путь расширить разрешённые маршруты — живой ход человека (11 §Policy, R:PR-15). */
  /** Новый разрешённый набор целиком: шире или уже прежнего — решает сравнение, а не флаг. */
  'set-route': z.strictObject({
    scope,
    scopeId: uuidv7,
    allowedRoutes: z.array(allowedRouteSchema).min(1),
  }),
} as const;

export type CommandKind = keyof typeof COMMAND_FIELDS;
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
  if (!envelope.success) return { ok: false, issues: describe(envelope.error.issues, '', input) };
  const raw = envelope.data.fields;
  const fields = COMMAND_FIELDS[envelope.data.kind].safeParse(raw);
  if (!fields.success) return { ok: false, issues: describe(fields.error.issues, 'fields', raw) };
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

function describe(
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
