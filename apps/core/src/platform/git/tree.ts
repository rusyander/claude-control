import { copyFileSync, existsSync, mkdtempSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { absent, readFact } from '../../lib/facts/read-fact.ts';
import { READ_CLASSES } from '../../lib/facts/read-classes.ts';
import { removeVerified } from '../safe-io/remove.ts';
import { DEFAULT_RETRY, READ_TRANSIENT_CODES, retryTransient } from '../safe-io/retry.ts';
import type { GitOptions, TreeRev, TreeRow } from './git.types.ts';
import { git } from './run.ts';

/**
 * Строки дерева git для ключа проверки (04:10, D§3.3): `(путь, режим, blob)`. Одна форма для
 * дерева коммита и для рабочей копии — рабочая копия снимается во временный индекс, так что
 * коммит, amend, rebase без правок и другая копия с тем же содержимым дают те же строки.
 */

const TIMEOUT_MS = READ_CLASSES['git.tree'].timeoutMs;
const MODES: ReadonlySet<string> = new Set(['100644', '100755', '120000', '160000']);
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Вывод `ls-tree -r -z --full-tree`: `<режим> <тип> <oid>\t<путь>\0`. Незнакомый режим или
 * oid — мусор, исключение (читатель факта даст `unknown`, ключ не посчитается — прогон).
 */
export function parseLsTree(out: string): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const rec of out.split('\0')) {
    if (rec === '') continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) throw new Error(`ls-tree garbage: ${rec.slice(0, 80)}`);
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    const path = rec.slice(tab + 1);
    if (!mode || !MODES.has(mode) || !oid || !OID.test(oid) || path === '')
      throw new Error(`ls-tree garbage: ${rec.slice(0, 80)}`);
    // Подмодуль (gitlink) — указатель на коммит: его смена меняет то, что проверка соберёт.
    if (type !== 'blob' && type !== 'commit')
      throw new Error(`ls-tree garbage type: ${String(type)}`);
    rows.push({ path, mode: mode as TreeRow['mode'], blob: oid });
  }
  // Свой порядок по коду, а не порядок git: формы дерева сравниваются строками, а не по месту.
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows;
}

async function lsTree(repo: string, tree: string, options: GitOptions): Promise<TreeRow[]> {
  const out = await git(repo, ['ls-tree', '-r', '-z', '--full-tree', tree], {
    ...options,
    timeoutMs: TIMEOUT_MS,
  });
  return parseLsTree(out.stdout);
}

/** Дерево ревизии; `null` — ревизии нет (прочитано: git ответил «нет такой»). */
async function revTreeId(repo: string, rev: string, options: GitOptions): Promise<string | null> {
  const out = await git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], {
    ...options,
    timeoutMs: TIMEOUT_MS,
    acceptNonZero: true,
  });
  const id = out.stdout.trim();
  if (out.code === 1 && id === '') return null;
  if (out.code !== 0 || !OID.test(id)) throw new Error(`rev-parse ${rev}: exit ${out.code}`);
  return id;
}

/**
 * Дерево рабочей копии через временный индекс (настоящий индекс не трогается). Затравка —
 * копия настоящего индекса: его кэш stat — `add -A` перечитывает только изменённое, а режим
 * файла (exec-бит при `core.fileMode=false` на Windows) берётся оттуда же, как при коммите.
 * Копия не годится (разделённый индекс, битый файл) — затравка `read-tree HEAD`.
 */
async function scratchTreeId(repo: string, options: GitOptions): Promise<string> {
  const indexOut = await git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], {
    ...options,
    timeoutMs: TIMEOUT_MS,
  });
  const realIndex = indexOut.stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-index-'));
  try {
    try {
      return await buildTree(repo, join(dir, 'copy'), realIndex, options);
    } catch {
      return await buildTree(repo, join(dir, 'fresh'), null, options);
    }
  } finally {
    // Временный индекс — ресурс чтения: уходит в любом исходе (P40).
    removeVerified(dir);
  }
}

const FLAG_CHUNK = 100;

/**
 * Флаги затравки, что прячут правку от `add -A` (B1-F04): `assume-unchanged` (тег `ls-files -v`
 * строчной буквой) снимается всегда, `skip-worktree` (`S`/`s`) — только у файла, что есть на
 * диске: отсутствующий в разреженной копии — не удаление, его строка остаётся как в индексе.
 * Снимаются во ВРЕМЕННОМ индексе; настоящий не трогается. Сбой — исключение: затравка тогда
 * `read-tree HEAD` (у неё флагов нет).
 */
async function clearHidingFlags(
  repo: string,
  call: GitOptions & { timeoutMs: number; extraEnv: Record<string, string> },
): Promise<void> {
  const out = await git(repo, ['ls-files', '-v', '-z'], call);
  const assumed: string[] = [];
  const skipped: string[] = [];
  for (const rec of out.stdout.split('\0')) {
    if (rec.length < 3 || rec[1] !== ' ') continue;
    const tag = rec[0] as string;
    const path = rec.slice(2);
    if (tag !== tag.toUpperCase()) assumed.push(path);
    if (tag.toUpperCase() === 'S' && existsSync(join(repo, path))) skipped.push(path);
  }
  for (const [flag, paths] of [
    ['--no-assume-unchanged', assumed],
    ['--no-skip-worktree', skipped],
  ] as const)
    for (let i = 0; i < paths.length; i += FLAG_CHUNK)
      await git(repo, ['update-index', flag, '--', ...paths.slice(i, i + FLAG_CHUNK)], call);
}

async function buildTree(
  repo: string,
  indexFile: string,
  seedFrom: string | null,
  options: GitOptions,
): Promise<string> {
  const call = { ...options, timeoutMs: TIMEOUT_MS, extraEnv: { GIT_INDEX_FILE: indexFile } };
  const seed = seedFrom === null ? undefined : statSync(seedFrom, { throwIfNoEntry: false });
  if (seedFrom !== null && seed !== undefined) {
    retryTransient(() => copyFileSync(seedFrom, indexFile), DEFAULT_RETRY, READ_TRANSIENT_CODES);
    // Копия держит mtime настоящего индекса: по нему git узнаёт «гоночные» строки (файл
    // переписан в ту же секунду, что записан индекс, размер тот же) и перечитывает их тело.
    // Свежий mtime копии делал такую строку «чистой» — в дереве оставался старый blob, ключ
    // зависел от того, в какую секунду его сняли (Linux, git без наносекунд). Округление вниз —
    // в безопасную сторону: строк, что перечитываются, только больше.
    const mtime = Math.floor(seed.mtimeMs) / 1000;
    utimesSync(indexFile, mtime, mtime);
    await clearHidingFlags(repo, call);
  } else if ((await revTreeId(repo, 'HEAD', options)) !== null) {
    await git(repo, ['read-tree', 'HEAD'], call);
  }
  // Монитор ФС и кэш неотслеживаемого выключены: их токены относятся к настоящему индексу.
  await git(
    repo,
    ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'add', '-A', '--', '.'],
    call,
  );
  const out = await git(repo, ['write-tree'], call);
  const id = out.stdout.trim();
  if (!OID.test(id)) throw new Error(`write-tree garbage: ${id.slice(0, 80)}`);
  return id;
}

/** Id дерева рабочей копии как факт класса `git.tree`. */
export function scratchIndexTree(repo: string, options: GitOptions = {}): Promise<Fact<string>> {
  return readFact('git.tree', () => scratchTreeId(repo, options));
}

/**
 * Строки дерева ревизии или рабочей копии. «Нет» — только когда git прочитал и ревизии нет;
 * любой сбой — `unknown` (ключ не считается, проверка идёт, 04:55).
 */
export function treeRows(
  repo: string,
  rev: TreeRev,
  options: GitOptions = {},
): Promise<Fact<TreeRow[]>> {
  return readFact('git.tree', async () => {
    const tree =
      rev === 'worktree' ? await scratchTreeId(repo, options) : await revTreeId(repo, rev, options);
    if (tree === null) return absent();
    return lsTree(repo, tree, options);
  });
}
