import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { SpoolRecord } from '@agentdeck/contracts/core/records';
import { z } from 'zod';
import { absent, readFact } from '../../lib/facts/read-fact.ts';
import { ensureDir, listDir, readBytesSync, renamePath } from '../../platform/safe-io/files.ts';
import { removeVerified } from '../../platform/safe-io/remove.ts';
import type { SpoolDeps, SpoolOutcome, SpoolSink } from './ingest.types.ts';

export type { SpoolDeps, SpoolOutcome, SpoolSink } from './ingest.types.ts';

/**
 * Очередь прогонов без ядра (04:36, G22): прокладка захвата, не достучавшись до ядра, пишет итог
 * в `<дом ядра>/spool/<pidStart>-<pid>-<seq>.json`. Ядро забирает файлы лениво — на каждом
 * вопросе захвата (таймера нет: без вопросов очередь никому не нужна) — и отдаёт хранилищу как
 * происхождение `unattended`: только обратная связь, никогда повтор и никогда состав (04:13).
 *
 * Файл снимается с диска только после того, как хранилище его взяло, и снятие читается назад;
 * отказ хранилища — файл остаётся до следующего забора (названо). Нечитаемый или чужой формы —
 * в `spool/bad/`, а не молча удалён. Каталог не прочитан — `unknown` (P44), не «пусто».
 */

export const SPOOL_BAD_DIR = 'bad';

const SHA = /^[0-9a-f]{64}$/;
/** id дерева git: sha-1 или sha-256. */
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const SPOOL_RECORD = z
  .object({
    v: z.literal(1),
    spoolId: z.string().regex(/^\d+-\d+-\d+$/),
    at: z.number().int().nonnegative(),
    road: z.enum(['node-preload', 'path-wrapper']),
    argv: z.array(z.string()).min(1),
    cwd: z.string().min(1),
    // Без личности дерева файл старой прокладки — в `bad/`: ключ мига забора ему не принадлежит.
    tree: z.string().regex(OID).nullable(),
    envDigest: z.string().regex(SHA),
    envNames: z.array(z.string().min(1).max(256)).max(256),
    exit: z.number().int().nullable(),
    ms: z.number().nonnegative(),
    log: z.string(),
    truncated: z.boolean(),
    token: z.enum(['session', 'capture']),
  })
  .strict();

function listSpool(dir: string, list: SpoolDeps['list']): Promise<Fact<string[]>> {
  return readFact('capture.spool', () => {
    const got = (list ?? listDir)(dir);
    if ('absent' in got) return absent();
    if ('unknown' in got) throw new Error(got.unknown);
    return got.value;
  });
}

function parseSpool(bytes: Buffer): SpoolRecord | string {
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return `not JSON: ${(error as Error).message}`;
  }
  const parsed = SPOOL_RECORD.safeParse(doc);
  return parsed.success
    ? (parsed.data as SpoolRecord)
    : `wrong form: ${parsed.error.issues[0]?.message ?? 'invalid'}`;
}

export async function ingestSpool(
  dir: string,
  sink: SpoolSink,
  deps: SpoolDeps = {},
): Promise<SpoolOutcome> {
  const out: SpoolOutcome = { taken: [], bad: [], kept: [] };
  const listed = await listSpool(dir, deps.list);
  if ('absent' in listed) return out;
  if ('unknown' in listed) return { ...out, unread: listed.unknown };
  // Только готовые файлы: `.tmp` ещё дописывает прокладка (запись + переименование).
  const files = listed.value.filter((name) => name.endsWith('.json')).sort();
  for (const name of files) {
    const file = join(dir, name);
    const bytes = (deps.read ?? readBytesSync)(file);
    if ('absent' in bytes) continue; // забрал соседний вопрос — его итог уже в хранилище
    if ('unknown' in bytes) {
      out.kept.push({ file, reason: `unread: ${bytes.unknown}` });
      continue;
    }
    const toBad = (reason: string): void => {
      try {
        ensureDir(join(dir, SPOOL_BAD_DIR));
        renamePath(file, join(dir, SPOOL_BAD_DIR, name));
        out.bad.push({ file, reason });
      } catch (error) {
        out.kept.push({
          file,
          reason: `${reason}; not moved to bad/: ${(error as Error).message}`,
        });
      }
    };
    const record = parseSpool(bytes.value);
    if (typeof record === 'string') {
      toBad(record);
      continue;
    }
    const taken = await sink.take(record);
    if ('rejected' in taken) {
      // Постоянный неприём (не репозиторий, не та папка): держать файл — спрашивать о нём вечно.
      toBad(`store rejected: ${taken.rejected}`);
      continue;
    }
    if ('refused' in taken) {
      out.kept.push({ file, reason: `store refused: ${taken.refused}` });
      continue;
    }
    const removed = removeVerified(file);
    if (!removed.removed) {
      out.kept.push({ file, reason: `taken as ${taken.taken}, not removed: ${removed.reason}` });
      continue;
    }
    out.taken.push(taken.taken);
  }
  return out;
}
