import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { readFact } from '../../lib/facts/read-fact.ts';
import { commitOf } from '../copy-git.ts';
import { snapshotDir, type DirEntrySnap } from '../resource-scan.ts';
import { readBytesSync } from '../safe-io/files.ts';
import type { GitOptions } from './git.types.ts';
import { git } from './run.ts';

/**
 * Снимок рабочего дерева копии на границе хода (02 §User interventions, P69, G17): `git status
 * --porcelain` + mtime и размер каждого грязного пути; содержимое хэшируется только когда mtime
 * или размер сдвинулись против прошлого снимка (R:S3-22) — снимок на каждом ходе не читает дерево.
 * Класс чтения `git.status` (`onUnknown: run`): непрочитанный снимок — `unknown`, шаг идёт, бриф
 * говорит «не прочитано», а не «правок нет».
 */

export interface StatusEntry {
  /** Оба знака porcelain: индекс и рабочее дерево. */
  xy: string;
  /** `null` — пути нет на диске (удалён). */
  mtimeMs: number | null;
  size: number | null;
  /** sha256 содержимого; `kind:mtime:size` для каталога и файла больше потолка. */
  stamp: string;
}

export interface StatusSnapshot {
  head: string | null;
  entries: Record<string, StatusEntry>;
}

/** Файл крупнее — отпечаток без чтения: снимок хода не читает гигабайты. */
const HASH_CAP = 8 * 1024 * 1024;
const STATUS_TIMEOUT_MS = 15_000;

function parseStatusXY(stdout: string): { xy: string; path: string }[] {
  return stdout
    .split('\0')
    .filter((entry) => entry.length >= 4)
    .map((entry) => ({ xy: entry.slice(0, 2), path: entry.slice(3) }));
}

function stampOf(abs: string, row: DirEntrySnap): string {
  if (row.kind !== 'file' || row.size > HASH_CAP) return `${row.kind}:${row.mtimeMs}:${row.size}`;
  const bytes = readBytesSync(abs);
  if ('unknown' in bytes) throw new Error(`${abs}: ${bytes.unknown}`);
  if (!('value' in bytes)) return 'absent';
  return `sha256:${createHash('sha256').update(bytes.value).digest('hex')}`;
}

function entriesOf(
  root: string,
  rows: readonly { xy: string; path: string }[],
  prev: StatusSnapshot | null,
): Record<string, StatusEntry> {
  const dirs = new Map<string, Map<string, DirEntrySnap>>();
  const rowsOf = (dir: string): Map<string, DirEntrySnap> => {
    let got = dirs.get(dir);
    if (!got) {
      const read = snapshotDir(dir);
      if ('unknown' in read) throw new Error(`${dir}: ${read.unknown}`);
      got = new Map(('value' in read ? read.value : []).map((r) => [r.name, r]));
      dirs.set(dir, got);
    }
    return got;
  };
  const out: Record<string, StatusEntry> = {};
  for (const { xy, path } of rows) {
    const abs = join(root, path);
    const row = rowsOf(dirname(abs)).get(basename(abs));
    if (!row) {
      out[path] = { xy, mtimeMs: null, size: null, stamp: 'absent' };
      continue;
    }
    const before = prev?.entries[path];
    // Время и размер те же — содержимое не перечитывается (G17: хэш только сдвинутого).
    const same = before && before.mtimeMs === row.mtimeMs && before.size === row.size;
    out[path] = {
      xy,
      mtimeMs: row.mtimeMs,
      size: row.size,
      stamp: same ? before.stamp : stampOf(abs, row),
    };
  }
  return out;
}

export function statusSnapshot(
  dir: string,
  prev: StatusSnapshot | null,
  options: GitOptions = {},
): Promise<Fact<StatusSnapshot>> {
  return readFact('git.status', async () => {
    const head = await commitOf(dir, 'HEAD');
    if ('unknown' in head) throw new Error(`HEAD: ${head.unknown}`);
    const out = await git(dir, ['status', '--porcelain=v1', '-z', '-uall', '--no-renames'], {
      ...options,
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    return {
      head: 'value' in head ? head.value : null,
      entries: entriesOf(dir, parseStatusXY(out.stdout), prev),
    };
  });
}
