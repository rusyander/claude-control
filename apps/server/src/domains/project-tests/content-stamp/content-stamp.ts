import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
  ProjectTestCase,
  ProjectTestGroup,
  ProjectTestPointResult,
  ProjectTestRunRecord,
} from '@agentdeck/contracts';

/**
 * Свежесть прогона по СОДЕРЖИМОМУ, а не по времени (журнал групп 24.10). Ворота
 * доставки и конца хода считали прогон старым, если он записан раньше «последней
 * правки» — а правкой считались дата коммита HEAD и mtime файлов. Обычный порядок
 * «прогнал, потом закоммитил» старил каждый прогон: коммит новее. Так же — rebase
 * после конфликта, `commit --amend`, коммит wip, checkout, тронувший только mtime;
 * и группа гоняла те же кейсы снова и снова.
 *
 * Здесь прогон помнит, ЧТО он видел: на старте — хеш блобов того, от чего кейс
 * зависит (его `codePaths` и файл автотеста, папки — всеми отслеживаемыми и
 * неотслеживаемыми файлами под ними). Прогон свеж для кейса, пока эти блобы те
 * же. Коммит, rebase, amend, не тронувшие их, свежести не снимают; любая правка
 * в них — снимает (Ф23: прогон до последней настоящей правки покрытого не в счёт).
 *
 * Отпечаток — по кейсу, а не по прогону: правка файла, не покрытого кейсом, его
 * прогон не старит. Цена ограничена: блобы отслеживаемых чистых файлов git отдаёт
 * из индекса даром (`ls-files -s`), хешируются только изменённые и новые; больше
 * `MAX_FILES` файлов или `MAX_HASHED` к хешированию — отпечатка нет, и кейс
 * судится по времени, как старая запись.
 *
 * Чего отпечаток не видит — игнорируемых файлов (`.env`, сборка) и `.agent/`
 * (заметки и хранилище блока: прогон сам пишет в него историю).
 */

/** Отслеживаемых файлов под зависимостями всех кейсов больше — отпечатков нет. */
const MAX_FILES = 20_000;
/** Изменённых и новых файлов к хешированию больше — отпечатков нет. */
const MAX_HASHED = 2_000;
const GIT_TIMEOUT_MS = 20_000;
const AGENT_DIR = /(^|\/)\.agent\//;
/** Блоб, которого нет: файл удалён в рабочем дереве. */
const DELETED = '-';

export interface CaseStampInput {
  /** `groupId:caseId`. */
  key: string;
  /** Пути от корня проекта, без повторов и упорядоченные (`stampPaths`). */
  paths: readonly string[];
}

const normal = (path: string): string =>
  path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * От чего зависит кейс: `codePaths` и файл автотеста. Без `codePaths` — ничего:
 * что кейс проверяет, не записано, и отпечатку не на что опереться — кейс
 * судится по времени. Путь вне проекта или «весь проект» (`.`) — тоже.
 */
export function stampPaths(
  testCase: Pick<ProjectTestCase, 'codePaths' | 'automation'>,
): string[] | undefined {
  const code = (testCase.codePaths ?? []).map(normal).filter(Boolean);
  if (code.length === 0) return undefined;
  const file = testCase.automation?.file ? normal(testCase.automation.file) : '';
  const all = [...new Set([...code, ...(file ? [file] : [])])].sort();
  const outside = (path: string) =>
    path === '.' ||
    path === '..' ||
    path.startsWith('../') ||
    isAbsolute(path) ||
    /^[a-z]:/i.test(path);
  return all.some(outside) ? undefined : all;
}

function git(root: string, args: string[], input?: string): string | undefined {
  const out = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return out.status === 0 ? out.stdout : undefined;
}

/**
 * Блобы файлов под путями: путь → хеш содержимого (или `DELETED`). `undefined` —
 * не репозиторий, git не ответил, предел превышен или под путём вложенный
 * репозиторий без записи в git (его содержимого git не покажет).
 */
function blobsUnder(root: string, paths: readonly string[]): Map<string, string> | undefined {
  const specs = paths.map((path) => `:(literal)${path}`);
  const tracked = git(root, ['ls-files', '-s', '-z', '--', ...specs]);
  const loose = git(root, ['ls-files', '-m', '-o', '--exclude-standard', '-z', '--', ...specs]);
  if (tracked === undefined || loose === undefined) return undefined;
  const blobs = new Map<string, string>();
  for (const entry of tracked.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [, sha, stage] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (!sha || AGENT_DIR.test(path)) continue;
    // Конфликт слияния: в индексе стадии 1–3, рабочий файл — среди изменённых ниже.
    blobs.set(path, stage === '0' ? sha : 'conflict');
  }
  if (blobs.size > MAX_FILES) return undefined;
  const dirty = [...new Set(loose.split('\0').filter((path) => path && !AGENT_DIR.test(path)))];
  if (dirty.length > MAX_HASHED) return undefined;
  const present: string[] = [];
  for (const path of dirty) {
    if (path.endsWith('/') || path.includes('\n')) return undefined;
    try {
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) return undefined;
      present.push(path);
    } catch {
      blobs.set(path, DELETED);
    }
  }
  if (present.length > 0) {
    // Те же фильтры, что у `git add` (autocrlf, clean): хеш нового файла равен
    // блобу, который ляжет в индекс, — и коммит отпечатка не меняет.
    const hashed = git(root, ['hash-object', '--stdin-paths'], `${present.join('\n')}\n`);
    const lines = hashed?.split(/\r?\n/).filter(Boolean) ?? [];
    if (lines.length !== present.length) return undefined;
    present.forEach((path, index) => blobs.set(path, lines[index] ?? ''));
  }
  return blobs;
}

/**
 * Отпечатки кейсов по содержимому рабочего дерева сейчас: `key` → хеш. Кейса нет
 * в ответе — отпечаток не снят (вне git, предел, вложенный репозиторий), и
 * свежесть его прогона судится по времени.
 */
export function contentStamps(root: string, cases: readonly CaseStampInput[]): Map<string, string> {
  const stamps = new Map<string, string>();
  const wanted = cases.filter((item) => item.paths.length > 0);
  if (wanted.length === 0) return stamps;
  const blobs = blobsUnder(root, [...new Set(wanted.flatMap((item) => item.paths))]);
  if (!blobs) return stamps;
  const files = [...blobs.keys()].sort();
  for (const item of wanted) {
    // Список путей — в отпечатке: кейс, которому дописали `codePaths`, видит больше,
    // чем видел прогон, и прошлый прогон его не закрывает.
    const hash = createHash('sha256').update(item.paths.join('\0')).update('\0\0');
    for (const file of files) {
      if (item.paths.some((path) => file === path || file.startsWith(`${path}/`))) {
        hash.update(`${file}\0${blobs.get(file) ?? ''}\n`);
      }
    }
    stamps.set(item.key, hash.digest('hex').slice(0, 32));
  }
  return stamps;
}

/** Входы отпечатка для кейсов групп; `keys` — только эти (`groupId:caseId`). */
export function stampInputs(
  groups: readonly ProjectTestGroup[],
  keys?: ReadonlySet<string>,
): CaseStampInput[] {
  const inputs: CaseStampInput[] = [];
  for (const group of groups) {
    if (group.error) continue;
    for (const item of group.cases) {
      const key = `${group.id}:${item.id}`;
      if (item.archived || (keys && !keys.has(key))) continue;
      const paths = stampPaths(item);
      if (paths) inputs.push({ key, paths });
    }
  }
  return inputs;
}

/**
 * Отпечатки кейсов сейчас — для ворот. Считаются только для кейсов, у которых
 * хоть один прогон отпечаток записал: на истории без отпечатков git не зовётся.
 */
export function currentStamps(
  root: string,
  groups: readonly ProjectTestGroup[],
  runs: readonly ProjectTestRunRecord[],
  keys: Iterable<string>,
): Map<string, string> {
  const stored = new Set(runs.flatMap((run) => Object.keys(run.stamps ?? {})));
  const wanted = new Set([...keys].filter((key) => stored.has(key)));
  if (wanted.size === 0) return new Map();
  return contentStamps(root, stampInputs(groups, wanted));
}

/** Отпечатки в запись прогона — только кейсов, чей результат в ней есть. */
export function stampsOf(
  stamps: ReadonlyMap<string, string> | undefined,
  results: readonly Pick<ProjectTestPointResult, 'groupId' | 'caseId'>[],
): Pick<ProjectTestRunRecord, 'stamps'> {
  if (!stamps || stamps.size === 0) return {};
  const kept = Object.fromEntries(
    results.flatMap((result) => {
      const key = `${result.groupId}:${result.caseId}`;
      const stamp = stamps.get(key);
      return stamp ? [[key, stamp] as const] : [];
    }),
  );
  return Object.keys(kept).length > 0 ? { stamps: kept } : {};
}

/**
 * Свеж ли результат кейса `key` прогона `run`. Отпечаток есть и в записи, и
 * сейчас — решает только он: те же блобы — свеж, в какой бы момент ни лёг
 * коммит. Нет одного из двух — прежнее правило: прогон начат не раньше
 * последней правки `changedAt` (мс).
 */
export function freshResult(
  run: Pick<ProjectTestRunRecord, 'startedAt' | 'stamps'>,
  key: string,
  changedAt: number,
  current?: ReadonlyMap<string, string>,
): boolean {
  const stored = run.stamps?.[key];
  const now = current?.get(key);
  if (stored !== undefined && now !== undefined) return stored === now;
  return Date.parse(run.startedAt) >= changedAt;
}
