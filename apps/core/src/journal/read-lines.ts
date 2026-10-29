import { join } from 'node:path';
import {
  JOURNAL_VERSION,
  journalLineSchema,
  type JournalLine,
} from '@agentdeck/contracts/core/journal';
import { readBytesSync } from '../platform/safe-io/files.ts';
import { chainHash, genesisHash, sha256OfText, validateData } from './line.ts';
import { JournalCorruptError, TASK_FILES } from './journal.types.ts';
import { upcastToCurrent, type RawLine } from './upcast.ts';

/**
 * Чтение журнала задачи: строки по порядку, цепочка хешей, артефакты по sha256, апкаст к
 * текущей версии. Без свёртки — сворачивает только `resume()` и вид для чтения (P11).
 * Оборванный хвост (крах посреди записи) читатель не режет — пропускает и сообщает его размер;
 * режет только владелец аренды при открытии (`journal.repaired`).
 */

export interface ReadResult {
  lines: JournalLine[];
  /** `hashes[i]` — цепочка после строки `seq = i + 1`. */
  hashes: string[];
  lastHash: string;
  tornBytes: number;
}

export function readJournalLines(dir: string, taskId: string): ReadResult {
  const read = readBytesSync(join(dir, TASK_FILES.journal));
  if ('unknown' in read) throw new Error(`journal unreadable: ${read.unknown}`);
  const genesis = genesisHash(taskId);
  if ('absent' in read) return { lines: [], hashes: [], lastHash: genesis, tornBytes: 0 };
  const bytes = read.value;
  const end = bytes.lastIndexOf(0x0a) + 1;
  const tornBytes = bytes.length - end;
  const text = bytes.subarray(0, end).toString('utf8');
  const lines: JournalLine[] = [];
  const hashes: string[] = [];
  let hash = genesis;
  let seq = 0;
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    seq += 1;
    hash = chainHash(hash, raw);
    hashes.push(hash);
    lines.push(parseLine(dir, raw, seq));
  }
  return { lines, hashes, lastHash: hash, tornBytes };
}

function parseLine(dir: string, raw: string, expectedSeq: number): JournalLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new JournalCorruptError(expectedSeq, 'not JSON');
  }
  const envelope = journalLineSchema.safeParse(parsed);
  if (!envelope.success)
    throw new JournalCorruptError(expectedSeq, envelope.error.issues[0]?.message ?? 'envelope');
  const line = envelope.data;
  if (line.seq !== expectedSeq)
    throw new JournalCorruptError(expectedSeq, `seq gap: found ${line.seq}`);
  let data: unknown = line.data;
  if (line.dataRef) data = readArtifact(dir, line.dataRef.sha256, expectedSeq);
  const ownIssues = validateData(line.kind, data, line.v);
  if (ownIssues.length)
    throw new JournalCorruptError(expectedSeq, `v${line.v} ${line.kind}: ${ownIssues[0]}`);
  const { dataRef: _ref, ...rest } = line;
  let current: RawLine;
  try {
    current = upcastToCurrent({ ...rest, data } as RawLine);
  } catch (error) {
    throw new JournalCorruptError(expectedSeq, (error as Error).message);
  }
  const issues = validateData(current.kind, current.data, JOURNAL_VERSION);
  if (issues.length)
    throw new JournalCorruptError(expectedSeq, `upcast ${current.kind}: ${issues[0]}`);
  return current as unknown as JournalLine;
}

function readArtifact(dir: string, sha: string, seq: number): unknown {
  const read = readBytesSync(join(dir, TASK_FILES.artifacts, `${sha}.json`));
  if (!('value' in read)) throw new JournalCorruptError(seq, `artifact ${sha} missing`);
  const text = read.value.toString('utf8');
  if (sha256OfText(text) !== sha)
    throw new JournalCorruptError(seq, `artifact ${sha} hash mismatch`);
  try {
    return JSON.parse(text);
  } catch {
    // Как и любой другой сбой чтения — порча с номером строки, не сырой SyntaxError (F-103).
    throw new JournalCorruptError(seq, `artifact ${sha} is not JSON`);
  }
}
