import { z } from 'zod';
import { registryId, sha256Hex, uuidv7 } from './ids.ts';
import { JOURNAL_DATA_V1, type JournalKind } from './journal-data.ts';

/**
 * Строка журнала задачи (01 §Journal). Виды — закрытый список (`JOURNAL_KINDS`), данные каждого
 * вида — строгая схема своей версии (`journal-data.ts`). `at`, `mono`, `bootId` и `seq` ставит
 * только `journal.append` в ядре: у входа записи этих полей нет вовсе (P09).
 */

export {
  JOURNAL_DATA_V1,
  ACTION_KINDS,
  RESOURCE_KINDS,
  ROUTE_KINDS,
  CREDENTIAL_KINDS,
  LIMIT_KINDS,
  routeSchema,
  allowedRouteSchema,
} from './journal-data.ts';
export type { JournalKind, JournalDataV1, ActionKind } from './journal-data.ts';

/** Версия, которую пишут; читаются все версии из `JOURNAL_DATA_BY_VERSION` через апкастеры. */
export const JOURNAL_VERSION = 1;

export const JOURNAL_DATA_BY_VERSION: Record<number, Record<string, z.ZodType>> = {
  1: JOURNAL_DATA_V1,
};

export const JOURNAL_KINDS = Object.keys(JOURNAL_DATA_V1) as JournalKind[];

/**
 * Что ждёт fsync до того, как на событие кто-то опирается (01 §Durability): команды, решения,
 * действия, ответы человека, публикация, ресурсы — и всё прочее по умолчанию. Пачкой (fsync
 * ≤ 1 с) идёт только телеметрия инструментов и ходов: её потеря в последнюю секунду до краха
 * не меняет ни одного решения.
 */
export const TELEMETRY_KINDS: readonly JournalKind[] = [
  'tool.event',
  'turn.usage',
  'turn.cli-initiated',
];

export function isTelemetryKind(kind: string): boolean {
  return (TELEMETRY_KINDS as readonly string[]).includes(kind);
}

/** Кто записал: ядро, человек по каналу, сессия, переходник (id из реестра), форж, супервизор. */
export const ACTOR_PATTERN =
  /^(core|forge|supervisor|human:[a-z0-9-]+|session:[0-9a-f-]{36}|adapter:[\w.:/@+-]+)$/;
export const actorSchema = z.string().regex(ACTOR_PATTERN, 'actor');

/** Строка больше этого — данные уходят в артефакт по sha256, в строке остаётся ссылка. */
export const JOURNAL_LINE_MAX_BYTES = 64 * 1024;

export const dataRefSchema = z.strictObject({
  sha256: sha256Hex,
  bytes: z.number().int().nonnegative(),
});

/** Конверт строки на диске; `data` сверяется схемой своего вида отдельно (после чтения артефакта). */
export const journalLineSchema = z
  .strictObject({
    v: z.number().int().positive(),
    seq: z.number().int().positive(),
    at: z.number().int().nonnegative(),
    mono: z.number().nonnegative(),
    bootId: uuidv7,
    taskId: uuidv7,
    unitId: uuidv7.optional(),
    stepId: uuidv7.optional(),
    sessionId: uuidv7.optional(),
    kind: z.string().min(1),
    actor: actorSchema,
    cmdId: uuidv7.optional(),
    cause: z.number().int().positive().optional(),
    /** Сколько секретов замаскировано на входе записи (DLP, 01 §Durability). */
    masked: z.number().int().positive().optional(),
    data: z.json(),
    dataRef: dataRefSchema.optional(),
  })
  .refine((line) => line.dataRef === undefined || line.data === null, {
    message: 'dataRef requires data: null',
  });

export type JournalLineEnvelope = z.infer<typeof journalLineSchema>;

export interface JournalLine<K extends JournalKind = JournalKind> {
  v: number;
  seq: number;
  at: number;
  mono: number;
  bootId: string;
  taskId: string;
  unitId?: string;
  stepId?: string;
  sessionId?: string;
  kind: K;
  actor: string;
  cmdId?: string;
  cause?: number;
  masked?: number;
  data: z.infer<(typeof JOURNAL_DATA_V1)[K]>;
}

/** Схема данных вида в версии; `undefined` — вида в этой версии нет (закрытый список). */
export function dataSchemaFor(v: number, kind: string): z.ZodType | undefined {
  const table = JOURNAL_DATA_BY_VERSION[v];
  return table ? table[kind] : undefined;
}

export { registryId, sha256Hex, uuidv7 };
