import type { Fact } from '@agentdeck/contracts/core/facts';
import type { QuarantineEntry } from '@agentdeck/contracts/core/records';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';
import type { QuarantineFile } from './flaky.types.ts';

/**
 * Карантин ядра на репозиторий: `<store>/quarantine.json` (G4; `<store>` = хранилище записей зоны A,
 * `<common>/agentdeck-verify/v2/`). Схема строгая (P45): чужое поле — не наш файл, не «пустой
 * карантин». Нечитаемый файл — `unknown`: вызывающий решает «сомнение → прогон», а не «карантина
 * нет» (тест из карантина вдруг заблокировал бы итог, F25).
 */

export const QUARANTINE_FILE = 'quarantine.json';

const entrySchema = z
  .object({
    test: z.string().min(1),
    file: z.string().min(1).optional(),
    checkId: z.string().min(1),
    since: z.string().min(1),
    greensInRow: z.number().int().min(0),
    caseRef: z
      .object({ groupId: z.string().min(1), caseId: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export const quarantineFileSchema = z
  .object({ v: z.literal(1), entries: z.array(entrySchema) })
  .strict();

export function readQuarantine(storeDir: string): Fact<QuarantineEntry[]> {
  const path = join(storeDir, QUARANTINE_FILE);
  const bytes = readBytesSync(path);
  if ('absent' in bytes) return { value: [] };
  if ('unknown' in bytes) return bytes;
  let json: unknown;
  try {
    json = JSON.parse(bytes.value.toString('utf8'));
  } catch {
    return { unknown: `${path}: не JSON` };
  }
  const parsed = quarantineFileSchema.safeParse(json);
  if (!parsed.success)
    return { unknown: `${path}: не по схеме (${parsed.error.issues[0]?.path.join('.') ?? ''})` };
  return { value: parsed.data.entries.map(stripUndefined) };
}

function stripUndefined(e: z.infer<typeof entrySchema>): QuarantineEntry {
  return {
    test: e.test,
    checkId: e.checkId,
    since: e.since,
    greensInRow: e.greensInRow,
    ...(e.file !== undefined ? { file: e.file } : {}),
    ...(e.caseRef !== undefined ? { caseRef: e.caseRef } : {}),
  };
}

export function writeQuarantine(storeDir: string, entries: readonly QuarantineEntry[]): void {
  const file: QuarantineFile = { v: 1, entries: [...entries] };
  writeFileAtomic(join(storeDir, QUARANTINE_FILE), `${JSON.stringify(file, null, 2)}\n`);
}
