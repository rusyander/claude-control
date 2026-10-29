import { z } from 'zod';
import type { CheckRecord } from '@agentdeck/contracts/core/records';

/**
 * Схема файла записи (strict, P45): владелец файла — хранилище, поэтому схема здесь, а не в
 * контрактах. Лишнее поле, чужая форма вердикта или «нестабильно-зелёный» без замеренных
 * повторов — не запись (мутант M5, D§4: такой «зелёный» давал ложные записи).
 */

const sha = z.string().regex(/^[0-9a-f]{64}$/);
/**
 * Значение `parts.env` — только дайджест (04:91): открытый текст переменной в файле записи был бы
 * утечкой секрета. Две переменные POSIX одного имени без регистра — два дайджеста через запятую.
 */
const envDigests = z.string().regex(/^[0-9a-f]{64}(,[0-9a-f]{64})*$/);
export const RECORD_ID = /^([0-9a-f]{64})\.(\d{1,3})$/;
const recordId = z.string().regex(RECORD_ID);
const uuid = z.string().min(1);

export const keyPartsSchema = z.strictObject({
  v: z.number().int().nonnegative(),
  checkId: z.string().min(1),
  entryHash: sha,
  unit: z.string(),
  selection: z.array(z.string()),
  closure: sha,
  machinery: sha,
  base: sha.nullable(),
  inputs: sha,
  tools: z.record(z.string(), z.string()),
  env: z.record(z.string(), envDigests),
});

const verdict = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pass') }),
  z.strictObject({ kind: z.literal('pass-flaky'), retries: z.array(recordId).min(1) }),
  z.strictObject({ kind: z.literal('fail'), reason: z.enum(['red', 'absent']) }),
  z.strictObject({
    kind: z.literal('no-verdict'),
    reason: z.enum(['aborted', 'engine', 'stand', 'env', 'selection']),
  }),
]);

const testRef = z.strictObject({ file: z.string().optional(), name: z.string().min(1) });

const draftShape = {
  key: sha,
  parts: keyPartsSchema,
  checkId: z.string().min(1),
  unit: z.string(),
  grade: z.enum(['unit', 'narrow', 'retry', 'base']),
  origin: z.enum(['core', 'session', 'unattended', 'pseudo']),
  verdict,
  exit: z.number().int().nullable(),
  ms: z.number().nonnegative(),
  startedAt: z.number().nonnegative(),
  argv: z.array(z.string()),
  failing: z.array(testRef),
  passing: z.array(testRef).min(1).optional(),
  failedCount: z.number().int().nonnegative().optional(),
  retries: z.array(recordId),
  artifacts: z.array(z.strictObject({ path: z.string().min(1), sha })).nullable(),
  envPrepared: z.boolean(),
  standEpoch: z.number().nullable(),
  taskId: uuid.nullable(),
  checkRunId: uuid.nullable(),
};

export const recordDraftSchema = z.strictObject(draftShape);

export const recordSchema = z.strictObject({
  ...draftShape,
  v: z.literal(3),
  id: recordId,
  log: z.strictObject({
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    sha,
  }),
  sig: sha,
}) satisfies z.ZodType<CheckRecord>;
