import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { RUN_DIR, ensureRunDir } from '../../../lib/run-dir/run-dir.ts';
import { readRun, writeRun } from '../runs-store/runs-store.ts';

/**
 * Память результатов проверок (9.3 плана экономии, 17.10.2026). Группа гоняла
 * один и тот же гейт по нескольку раз на неизменном дереве — после сжатия, перед
 * ревью, перед «доставлено» — и каждый раз читала его журнал. Здесь зелёный итог
 * команды привязан к содержимому дерева: дерево то же — ответ из памяти, без
 * прогона. Честность держит отпечаток: любая правка, новый или удалённый файл,
 * новый коммит дают другой отпечаток, и прогон идёт по-настоящему. Красный не
 * запоминается никогда.
 */
export const CHECK_MEMO = `${RUN_DIR}/check-memo.json`;

/** Неотслеживаемых файлов больше — отпечаток не считается, прогон идёт всегда. */
const MAX_UNTRACKED = 2_000;
/** Сколько разных команд помнить: старые вытесняются. */
const MAX_ENTRIES = 20;
/**
 * `.agent/` — заметки агентов, хранилище кейсов и сама эта память: прогон пишет
 * в них историю, и с ними отпечаток менялся бы от каждого прогона. Любой
 * глубины: у проекта-подкаталога своя `.agent/` ниже корня репозитория.
 */
const OUTSIDE = ':(exclude,glob)**/.agent/**';

export interface CheckMemoEntry {
  key: string;
  fingerprint: string;
  runId: string;
  at: string;
}

function git(root: string, args: string[]): string | undefined {
  const out = spawnSync('git', args, {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.status === 0 ? out.stdout.toString('latin1') : undefined;
}

/**
 * Отпечаток дерева: коммит, все отличия от него (и в индексе, и в рабочих файлах,
 * и внутри подмодулей) и содержимое неотслеживаемых файлов, которых git не
 * игнорирует. Считается по ВСЕМУ репозиторию, а не по папке проекта: проект-
 * подкаталог собирает и соседние пакеты, и их правка должна звать прогон.
 * Сравнение — по байтам (`--no-textconv`): фильтр показа мог бы спрятать правку.
 * Чего отпечаток не видит — игнорируемых файлов (`.env`, зависимости, сборка);
 * после их правки прогон зовут с `--fresh`. Не репозиторий, нет коммита, слишком
 * много неотслеживаемого или вложенный репозиторий без записи в git (его
 * содержимого git не покажет) — `undefined`, и памяти нет.
 */
export function treeFingerprint(root: string): string | undefined {
  const head = git(root, ['rev-parse', 'HEAD']);
  const shown = git(root, ['rev-parse', '--show-toplevel']);
  const top = shown && Buffer.from(shown.trim(), 'latin1').toString('utf8');
  if (!head || !top) return undefined;
  const diff = git(top, [
    'diff',
    'HEAD',
    '--binary',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=none',
    '--submodule=diff',
    '--',
    '.',
    OUTSIDE,
  ]);
  const listed = git(top, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', OUTSIDE]);
  if (diff === undefined || listed === undefined) return undefined;
  const untracked = listed.split('\0').filter(Boolean).sort();
  if (untracked.length > MAX_UNTRACKED) return undefined;
  const hash = createHash('sha256').update(head).update('\0').update(diff, 'latin1');
  for (const file of untracked) {
    const path = join(top, Buffer.from(file, 'latin1').toString('utf8'));
    let content: Buffer;
    try {
      // Каталог в списке — вложенный репозиторий (копия задачи Claude Code, клон
      // рядом): git отдаёт его строкой `dir/`, а его файлов не видит вовсе.
      if (file.endsWith('/') || statSync(path).isDirectory()) return undefined;
      content = readFileSync(path);
    } catch {
      content = Buffer.alloc(0);
    }
    hash.update(`\0${file}\0`).update(content);
  }
  return hash.digest('hex');
}

function readEntries(root: string): CheckMemoEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, CHECK_MEMO), 'utf8'));
    return Array.isArray(parsed) ? (parsed as CheckMemoEntry[]) : [];
  } catch {
    return [];
  }
}

function writeEntries(root: string, entries: CheckMemoEntry[]): void {
  ensureRunDir(root);
  writeFileSync(join(root, CHECK_MEMO), JSON.stringify(entries.slice(-MAX_ENTRIES), null, 1));
}

/** Зелёный прогон этой команды на этом же дереве, если он был. */
export function recall(root: string, key: string, fingerprint: string): CheckMemoEntry | undefined {
  return readEntries(root).find((entry) => entry.key === key && entry.fingerprint === fingerprint);
}

/** Запомнить зелёный прогон; прежняя запись той же команды заменяется. */
export function rememberGreen(root: string, entry: CheckMemoEntry): void {
  writeEntries(root, [...readEntries(root).filter((known) => known.key !== entry.key), entry]);
}

/** Прогон не зелёный — память о команде снимается: ответ из неё больше не верен. */
export function forget(root: string, key: string): void {
  const entries = readEntries(root);
  if (entries.some((entry) => entry.key === key)) {
    writeEntries(
      root,
      entries.filter((entry) => entry.key !== key),
    );
  }
}

/**
 * Ответ из памяти ложится в историю своей записью (ревью B2-F4): проверка конца
 * хода ждёт прогона ПОСЛЕ последней правки, и без записи агент, получив «итог тот
 * же», упирался в неё снова — и гонял ту же команду, которую память опять не
 * пускала. Запись — копия зелёного прогона со своим временем и пометкой в
 * `scope`, откуда она; исходной записи нет (вытеснена) — `undefined`, и прогон
 * идёт по-настоящему.
 */
export function replayRun(
  root: string,
  runId: string,
  scope: string,
  now = new Date(),
): ProjectTestRunRecord | undefined {
  const source = readRun(root, runId);
  if (!source) return undefined;
  const at = now.toISOString();
  const { tms: _sent, ...rest } = source;
  const record: ProjectTestRunRecord = {
    ...rest,
    id: randomUUID(),
    startedAt: at,
    finishedAt: at,
    scope,
  };
  writeRun(root, record);
  return record;
}
