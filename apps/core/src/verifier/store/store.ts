import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { CheckKey, CheckRecord, RecordId } from '@agentdeck/contracts/core/records';
import { absent } from '../../lib/facts/read-fact.ts';
import { createOnceLinked, listStoreDir, readStoreFile } from '../../platform/git.ts';
import { canonical, hmac, keyFromParts, sha256 } from '../key/index.ts';
import { RECORD_ID, recordDraftSchema, recordSchema } from './schema.ts';
import type {
  KeyScan,
  RecordDraft,
  RecordStore,
  RecordStoreOptions,
  SkippedRecord,
  StoreIo,
} from './store.types.ts';

/**
 * Хранилище записей проверок (04:33, D§3.4): `<common>/agentdeck-verify/v2/` — одно на
 * репозиторий, общее у основной папки и всех копий. Запись пишется один раз и не переписывается
 * никогда: имя `<ключ>.<попытка>` (попытка — первая свободная 0..255), файл появляется жёсткой
 * ссылкой на готовый временный. Подпись — HMAC ключом дома ядра по канонической форме записи.
 * Каждое чтение — факт (P44): сбой диска — `unknown`, «нет» — только прочитанное отсутствие.
 */

const RECORD_VERSION = 3;
/** Вывод больше — хранятся голова и хвост: повтор такого вывода помечен неполным. */
export const LOG_CAP = 2 * 1024 * 1024;
const ATTEMPTS = 256;

export function storeRoot(commonDir: string): string {
  return join(commonDir, 'agentdeck-verify', 'v2');
}

const DEFAULT_IO: StoreIo = {
  read: readStoreFile,
  list: listStoreDir,
  createOnce: createOnceLinked,
};

function capLog(body: Buffer): { stored: Buffer; truncated: boolean } {
  if (body.length <= LOG_CAP) return { stored: body, truncated: false };
  const half = Math.floor(LOG_CAP / 2);
  const mark = Buffer.from(`\n[agentdeck: ${body.length - 2 * half} bytes cut]\n`);
  return {
    stored: Buffer.concat([body.subarray(0, half), mark, body.subarray(body.length - half)]),
    truncated: true,
  };
}

function signOf(key: Uint8Array, record: Omit<CheckRecord, 'sig'>): string {
  return hmac(key, canonical(record));
}

/** Сравнение подписи без раннего выхода по первому несовпавшему символу. */
function sameSig(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function createRecordStore(options: RecordStoreOptions): RecordStore {
  const { root, key } = options;
  const io = guarded(options.io ?? DEFAULT_IO);
  const dirOf = (k: CheckKey) => join(root, 'records', k.slice(0, 2));
  const fileOf = (id: RecordId) => join(dirOf(id), `${id}.json`);
  const logOf = (id: RecordId) => join(root, 'logs', id.slice(0, 2), `${id}.log.gz`);
  /**
   * Указатель «проверка × единица» поверх ключей: копия файла записи (та же подпись) — выученный
   * срок прогона идёт по истории проверки, а не только одного дерева (A1-F06).
   */
  const historyOf = (checkId: string, unit: string) =>
    join(root, 'by-check', sha256(canonical([checkId, unit])));

  /** Разбор файла записи: годная запись или причина, по которой она не запись. */
  function parse(bytes: Buffer, name: string): { record: CheckRecord } | { why: string } {
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch {
      return { why: 'garbage: not JSON' };
    }
    if ((raw as { v?: unknown } | null)?.v !== RECORD_VERSION)
      return { why: `other version ${String((raw as { v?: unknown } | null)?.v)}` };
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) return { why: `garbage: ${parsed.error.issues[0]?.path.join('.')}` };
    const record = parsed.data as CheckRecord;
    if (`${record.id}.json` !== name || !record.id.startsWith(`${record.key}.`))
      return { why: 'name does not match the record id' };
    const { sig, ...body } = record;
    if (!sameSig(sig, signOf(key, body))) return { why: 'bad signature' };
    return { record };
  }

  function record(id: RecordId): Fact<CheckRecord> {
    if (!RECORD_ID.test(id)) return absent();
    const file = io.read(fileOf(id));
    if (!('value' in file)) return file;
    const got = parse(file.value, `${id}.json`);
    return 'record' in got ? { value: got.record } : { unknown: `check.records ${id}: ${got.why}` };
  }

  function scan(k: CheckKey): Fact<KeyScan> {
    const names = io.list(dirOf(k));
    if ('absent' in names) return { value: { records: [], skipped: [] } };
    if ('unknown' in names) return { unknown: `check.records: ${names.unknown}` };
    const records: CheckRecord[] = [];
    const skipped: SkippedRecord[] = [];
    const re = new RegExp(`^${k}\\.\\d{1,3}\\.json$`);
    for (const name of names.value.filter((n) => re.test(n)).sort()) {
      const file = io.read(join(dirOf(k), name));
      // Файл есть, но не прочитан: среди нечитаемых может быть красный — весь ответ `unknown`
      // (иначе зелёный соседа повторился бы поверх скрытого красного).
      if ('unknown' in file) return { unknown: `check.records ${name}: ${file.unknown}` };
      if ('absent' in file) continue;
      const got = parse(file.value, name);
      if ('record' in got) records.push(got.record);
      // Обрывок (ФС без ссылок + падение посреди записи, store-files.ts) — недописанная запись
      // ЭТОГО ключа, может быть красной: весь ответ `unknown`, как у нечитаемой. Чужая подпись и
      // другая версия — целые записи не отсюда: пропуск с причиной.
      else if (got.why.startsWith('garbage'))
        return { unknown: `check.records ${name}: ${got.why}` };
      else skipped.push({ file: name, why: got.why });
    }
    records.sort((a, b) => a.startedAt - b.startedAt || attemptOf(a.id) - attemptOf(b.id));
    return { value: { records, skipped } };
  }

  /**
   * Записи проверки и единицы по всем ключам, старые первыми. Копия не читается или не сходится
   * подписью — пропуск: история лишь учит срок, вердикт по ней не повторяется никогда.
   */
  function history(checkId: string, unit: string): Fact<CheckRecord[]> {
    const dir = historyOf(checkId, unit);
    const names = io.list(dir);
    if ('absent' in names) return { value: [] };
    if ('unknown' in names) return { unknown: `check.records history: ${names.unknown}` };
    const records: CheckRecord[] = [];
    for (const name of names.value) {
      const file = io.read(join(dir, name));
      if (!('value' in file)) continue;
      const got = parse(file.value, name);
      if ('record' in got && got.record.checkId === checkId && got.record.unit === unit)
        records.push(got.record);
    }
    records.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    return { value: records };
  }

  function byKey(k: CheckKey): Fact<CheckRecord[]> {
    const got = scan(k);
    return 'value' in got ? { value: got.value.records } : got;
  }

  function log(id: RecordId): Fact<string> {
    const rec = record(id);
    if (!('value' in rec)) return rec;
    const file = io.read(logOf(id));
    if (!('value' in file)) return 'absent' in file ? { unknown: `log of ${id} missing` } : file;
    try {
      const body = gunzipSync(file.value);
      if (sha256(body) !== rec.value.log.sha)
        return { unknown: `log of ${id} does not match its record` };
      return { value: body.toString('utf8') };
    } catch (error) {
      return { unknown: `log of ${id}: ${(error as Error).message}` };
    }
  }

  function write(
    draft: RecordDraft,
    output: string | Uint8Array,
    logTruncated = false,
  ): Fact<RecordId> {
    const checked = recordDraftSchema.safeParse(draft);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      return { unknown: `record draft invalid: ${issue?.path.join('.')} ${issue?.message}` };
    }
    // Ключ записи обязан быть хешем её частей: иначе запись отвечала бы за чужое содержимое.
    if (keyFromParts(draft.parts) !== draft.key)
      return { unknown: 'record draft invalid: key is not the hash of its parts' };
    try {
      const body = Buffer.from(output);
      const { stored, truncated } = capLog(body);
      const gz = gzipSync(stored);
      const used = new Set<number>();
      const names = io.list(dirOf(draft.key));
      if ('unknown' in names) return { unknown: `check.records: ${names.unknown}` };
      if ('value' in names)
        for (const n of names.value) {
          const m = /^[0-9a-f]{64}\.(\d{1,3})\.json$/.exec(n);
          if (m?.[1] && n.startsWith(draft.key)) used.add(Number(m[1]));
        }
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        if (used.has(attempt)) continue;
        const id = `${draft.key}.${attempt}`;
        // Вывод пишется первым: запись без вывода повторить нечем, а вывод без записи — мусор.
        if (io.createOnce(logOf(id), gz) === 'exists') continue;
        const unsigned: Omit<CheckRecord, 'sig'> = {
          ...draft,
          v: RECORD_VERSION,
          id,
          // Лог, который обрезал уже пишущий (прокладка: голова + хвост), — тоже обрезан (B2-F02).
          log: { bytes: body.length, truncated: truncated || logTruncated, sha: sha256(stored) },
        };
        const full: CheckRecord = { ...unsigned, sig: signOf(key, unsigned) };
        const bytes = Buffer.from(JSON.stringify(full));
        if (io.createOnce(fileOf(id), bytes) === 'created') {
          indexHistory(full, bytes);
          return { value: id };
        }
      }
      return { unknown: `no free record name for ${draft.key} in ${ATTEMPTS} attempts` };
    } catch (error) {
      return { unknown: `record write: ${(error as Error).message}` };
    }
  }

  /**
   * Копия в указатель после записи. Сбой не отменяет записанное: запись — доказательство, копия
   * лишь учит срок, а без неё срок берётся с ключа или по умолчанию (щедрый).
   */
  function indexHistory(full: CheckRecord, bytes: Buffer): void {
    try {
      io.createOnce(join(historyOf(full.checkId, full.unit), `${full.id}.json`), bytes);
    } catch {
      // Указатель не записан — выученный срок короче на одну запись, вердикт не меняется.
    }
  }

  return { root, record, byKey, scan, history, log, write, logPath: logOf };
}

/** Исключение чтения — `unknown` с причиной (P44): чтение хранилища не роняет решение и не даёт «нет». */
function guarded(io: StoreIo): StoreIo {
  const unknownOf = (error: unknown): { unknown: string } => ({
    unknown: (error as Error)?.message ?? String(error),
  });
  return {
    read: (path) => {
      try {
        return io.read(path);
      } catch (error) {
        return unknownOf(error);
      }
    },
    list: (dir) => {
      try {
        return io.list(dir);
      } catch (error) {
        return unknownOf(error);
      }
    },
    createOnce: (path, data) => io.createOnce(path, data),
  };
}

function attemptOf(id: RecordId): number {
  return Number(RECORD_ID.exec(id)?.[2] ?? 0);
}
