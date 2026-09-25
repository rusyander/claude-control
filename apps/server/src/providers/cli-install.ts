import { spawnSync } from 'node:child_process';
import type { CliInfo, CliInstall } from '@agentdeck/contracts';

/**
 * Какой CLI Claude панель на самом деле запускает и нет ли рядом новее
 * (замечание живого прогона 25.09.2026). Запуск идёт по имени (`claude.cmd` /
 * `claude`), и ОС берёт первую копию из PATH: на машине стояли 2.1.278 в
 * каталоге nvm и 2.1.280+ в другом месте, модель требовала ≥ 2.1.280, а панель
 * молча работала старой — и сжатие контекста падало сырым текстом API.
 *
 * `--version` здесь спавнится — в отличие от детекта чужих CLI (`detect.ts`):
 * у Claude эта команда ничего не спрашивает и отвечает сразу.
 */

/** Запуск процесса: подменяется в тестах, наружу — только код и вывод. */
export type CliExec = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number; shell?: boolean },
) => { status: number | null; stdout: string; stderr?: string };

const defaultExec: CliExec = (file, args, options = {}) => {
  // `.cmd` на Windows запускается только через оболочку; путь с пробелами — в кавычках.
  const result = options.shell
    ? spawnSync(`"${file}" ${args.join(' ')}`, {
        shell: true,
        windowsHide: true,
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 10_000,
      })
    : spawnSync(file, args, {
        windowsHide: true,
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 10_000,
      });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

const VERSION = /(\d+)\.(\d+)\.(\d+)/;

/** Версия из вывода `--version` («2.1.282 (Claude Code)»). */
export function parseCliVersion(text: string): string | undefined {
  return VERSION.exec(text)?.[0];
}

/** Сравнение версий `a.b.c`: <0, 0, >0. Нечитаемая версия — самая старая. */
export function compareCliVersions(a: string | undefined, b: string | undefined): number {
  const parts = (value: string | undefined) =>
    (VERSION.exec(value ?? '')?.slice(1) ?? ['-1', '-1', '-1']).map(Number);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Все копии команды в PATH по порядку поиска ОС. */
function whereAll(command: string, exec: CliExec): string[] {
  const windows = process.platform === 'win32';
  const result = exec(windows ? 'where' : 'which', windows ? [command] : ['-a', command], {
    timeoutMs: 3_000,
  });
  if (result.status !== 0) return [];
  return (
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      // npm кладёт рядом с `claude.cmd` sh-обёртку без расширения: `where claude`
      // её находит, а Windows её не запустит — это не копия CLI, а шум.
      .filter((line) => !windows || /\.(cmd|bat|exe)$/i.test(line))
  );
}

function versionOf(path: string, exec: CliExec): string | undefined {
  const shell = /\.(cmd|bat)$/i.test(path);
  const result = exec(path, ['--version'], { timeoutMs: 10_000, shell });
  return result.status === 0 ? parseCliVersion(result.stdout) : undefined;
}

const CACHE_MS = 5 * 60_000;
let cached: { key: string; at: number; info: CliInfo } | undefined;

/**
 * Сведения о CLI: какая копия запускается (`command` — имя, под которым панель
 * её зовёт), все копии в PATH с версиями и новейшая, если она не та, что
 * запускается. Живёт пять минут: PATH меняется редко, а `--version` у каждой
 * копии — сотни миллисекунд. `refresh` — после обновления CLI.
 */
export function readCliInfo(
  command: string,
  candidates: readonly string[],
  options: { exec?: CliExec; refresh?: boolean; now?: number } = {},
): CliInfo {
  const exec = options.exec ?? defaultExec;
  const now = options.now ?? Date.now();
  const key = [command, ...candidates].join('|');
  if (!options.refresh && !options.exec && cached?.key === key && now - cached.at < CACHE_MS) {
    return cached.info;
  }
  // Запускается первая копия ИМЕНИ запуска; копии под другими именами (`claude.exe`
  // рядом с npm-обёрткой) — кандидаты на «есть новее».
  const used = whereAll(command, exec)[0];
  const paths = [...new Set(candidates.flatMap((name) => whereAll(name, exec)))];
  if (used && !paths.includes(used)) paths.unshift(used);
  const installs: CliInstall[] = paths.map((path) => {
    const version = versionOf(path, exec);
    return version ? { path, version } : { path };
  });
  const current = installs.find((install) => install.path === used);
  const newest = installs.reduce<CliInstall | undefined>(
    (best, install) =>
      install.version && compareCliVersions(install.version, best?.version) > 0 ? install : best,
    undefined,
  );
  const info: CliInfo = {
    command,
    ...(current ? { path: current.path } : {}),
    ...(current?.version ? { version: current.version } : {}),
    installs,
    ...(newest && newest.path !== used && compareCliVersions(newest.version, current?.version) > 0
      ? { newer: newest }
      : {}),
  };
  if (!options.exec) cached = { key, at: now, info };
  return info;
}

/** Забыть сведения — после обновления CLI ответ обязан быть свежим. */
export function resetCliInfoCache(): void {
  cached = undefined;
}

/**
 * `claude update` той копией, которую панель запускает: обновлять надо именно
 * её, иначе новее станет соседняя, а панель продолжит работать старой.
 */
export function updateCli(
  path: string,
  options: { exec?: CliExec } = {},
): { ok: boolean; output: string } {
  const exec = options.exec ?? defaultExec;
  const shell = /\.(cmd|bat)$/i.test(path);
  const result = exec(path, ['update'], { timeoutMs: 5 * 60_000, shell });
  resetCliInfoCache();
  const output = `${result.stdout}\n${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, output: output.slice(-2000) };
}
