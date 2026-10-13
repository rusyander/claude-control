import { execFile } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Недокачанные пакеты `fetch`, брошенные убитым git.
 *
 * `fetch` складывает приходящие объекты во временный `objects/pack/tmp_pack_*`
 * и переименовывает его только в конце. Срок `execFile` на Windows — это
 * TerminateProcess: git не успевает убрать за собой, и файл остаётся навсегда —
 * ни `fetch`, ни `gc` его не трогают. Медленная сеть плюс повторный `fetch` на
 * каждой сдаче группы превратили репозиторий на 159 МБ в 2,3 ГБ из двух сотен
 * одинаковых обрывков за полдня.
 *
 * Поэтому перед каждым походом в сеть панель убирает такие файлы старше часа:
 * свежие могут принадлежать `fetch`, который идёт прямо сейчас (из терминала
 * человека или соседнего прогона), а час дольше любого нашего потолка ожидания.
 */
export const STALE_PACK_AGE_MS = 60 * 60 * 1000;

/** Временные файлы, которые git пишет в `objects/pack` до переименования. */
const TEMP_PACK = /^tmp_(pack|idx|rev|mtimes)_/;

/** Подкоманды, которые качают пакет в существующий репозиторий. */
const NETWORK_SUBCOMMANDS = new Set(['fetch', 'pull']);

/** Первый аргумент, который не ключ `-c name=value` и не другой ключ git. */
export function gitSubcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '-c' || arg === '-C') {
      index += 1;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

export function fetchesPack(args: readonly string[]): boolean {
  const sub = gitSubcommand(args);
  return sub !== undefined && NETWORK_SUBCOMMANDS.has(sub);
}

function commonDir(cwd: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(
      'git',
      ['rev-parse', '--git-common-dir'],
      { cwd: resolve(cwd), timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        const dir = String(stdout).trim();
        if (error || !dir) return done(undefined);
        done(isAbsolute(dir) ? dir : resolve(cwd, dir));
      },
    );
  });
}

/**
 * Убрать брошенные `tmp_*` из `objects/pack` репозитория (общего для всех его
 * копий-worktree). Никогда не бросает: это уборка перед делом, а не само дело.
 * Возвращает имена убранных файлов — для теста и журнала.
 */
export async function sweepStalePacks(cwd: string, now = Date.now()): Promise<string[]> {
  const dir = await commonDir(cwd);
  if (!dir) return [];
  const packDir = join(dir, 'objects', 'pack');
  let names: string[];
  try {
    names = await readdir(packDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!TEMP_PACK.test(name)) continue;
    const path = join(packDir, name);
    try {
      const { mtimeMs } = await stat(path);
      if (now - mtimeMs < STALE_PACK_AGE_MS) continue;
      await rm(path, { force: true });
      removed.push(name);
    } catch {
      // Файл занят или уже убран — следующий поход в сеть попробует снова.
    }
  }
  return removed;
}
