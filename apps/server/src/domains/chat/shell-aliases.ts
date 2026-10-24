import { readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseFunctions, type ShellFunctions } from './shell-functions.ts';

/**
 * Псевдонимы оболочки Bash-инструмента CLI (раунд 10, 24.10): CLI один раз за
 * сессию снимает оболочку пользователя (`~/.claude/shell-snapshots/
 * snapshot-bash-<мс>-<метка>.sh`) — функции, `shopt -s expand_aliases` и
 * `alias имя='значение'` из `.bashrc`, — и каждая команда Bash идёт поверх
 * этого снимка. `gp origin main --force` с `alias gp='git push'` — пуш в main,
 * а разбор видел неизвестное имя `gp` и пускал по правилам чата. Снимок —
 * то, что раскроет сама оболочка, поэтому псевдонимы берутся из него, а не из
 * `.bashrc`.
 */

export type ShellAliases = Readonly<Record<string, string>>;

export interface ShellAliasIo {
  list(dir: string): Promise<string[]>;
  read(file: string): Promise<string>;
}

export const realShellAliasIo: ShellAliasIo = {
  list: (dir) => readdir(dir),
  read: (file) => readFile(file, 'utf8'),
};

/** Каталог настроек CLI: `CLAUDE_CONFIG_DIR` или `~/.claude`. */
export function cliConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** `alias имя='значение'`, `alias -- имя='…'` (zsh), `'\''` — кавычка внутри. */
const ALIAS_LINE = /^alias\s+(?:--\s+)?([^\s=]+)=('(?:[^']|'\\'')*'|"[^"]*"|\S*)\s*$/;

/** `unalias -a` / `unalias имя …` (снимок снимает конфликтующие с функциями). */
const UNALIAS_LINE = /^unalias\s+([^;|&>]*?)\s*(?:\d?>.*|[;|&].*)?$/;

/** Псевдонимы из текста снимка (или вывода `alias -p`), в порядке строк. */
export function parseAliases(text: string): ShellAliases {
  // Без прототипа: имя `__proto__` или `constructor` — такой же псевдоним, как прочие.
  const aliases: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of text.split(/\r?\n/)) {
    const unalias = UNALIAS_LINE.exec(line.trim());
    if (unalias) {
      for (const name of (unalias[1] as string).trim().split(/\s+/)) {
        if (name === '-a') for (const key of Object.keys(aliases)) delete aliases[key];
        else delete aliases[name];
      }
      continue;
    }
    const match = ALIAS_LINE.exec(line.trim());
    if (!match) continue;
    const raw = match[2] as string;
    const value = raw.startsWith("'")
      ? raw.slice(1, -1).replace(/'\\''/g, "'")
      : raw.startsWith('"')
        ? raw.slice(1, -1)
        : raw;
    aliases[match[1] as string] = value;
  }
  return aliases;
}

/** Снимок, на котором идут команды сейчас: самый новый `snapshot-bash-<мс>-…`. */
const SNAPSHOT = /^snapshot-(?:bash|zsh)-(\d+)-[\w-]+\.sh$/;

/** Псевдонимы и функции одного снимка оболочки CLI. */
export interface ShellSnapshot {
  aliases: ShellAliases;
  functions: ShellFunctions;
}

const cache = new Map<string, { file: string; snapshot: ShellSnapshot }>();

/** Имя самого нового снимка в списке каталога. */
function newestOf(names: readonly string[]): string | undefined {
  let newest: string | undefined;
  let at = -1;
  for (const name of names) {
    const stamp = Number(SNAPSHOT.exec(name)?.[1] ?? -1);
    if (stamp > at) {
      at = stamp;
      newest = name;
    }
  }
  return newest;
}

function parseSnapshot(text: string): ShellSnapshot {
  return { aliases: parseAliases(text), functions: parseFunctions(text) };
}

/**
 * Псевдонимы и функции последнего снимка оболочки CLI. Читается раз на снимок:
 * новый снимок — новая сессия CLI, тогда и перечитываем. Снимка нет или он не
 * читается — `undefined`: имя команды судится, как раньше (правилами чата).
 */
export async function shellSnapshot(
  configDir: string = cliConfigDir(),
  io: ShellAliasIo = realShellAliasIo,
): Promise<ShellSnapshot | undefined> {
  const dir = join(configDir, 'shell-snapshots');
  const newest = newestOf(await io.list(dir).catch(() => [] as string[]));
  if (!newest) return undefined;
  const known = cache.get(dir);
  if (known?.file === newest) return known.snapshot;
  const text = await io.read(join(dir, newest)).catch(() => undefined);
  if (text === undefined) return undefined;
  const snapshot = parseSnapshot(text);
  cache.set(dir, { file: newest, snapshot });
  return snapshot;
}

/**
 * То же синхронно — для профиля запуска группы (`group-profile.ts`), который
 * собирается без ожидания: имена снимка становятся правилами `ask`, и вызов
 * псевдонима или функции доходит до брокера и в авторежиме CLI.
 */
export function shellSnapshotSync(configDir: string = cliConfigDir()): ShellSnapshot | undefined {
  const dir = join(configDir, 'shell-snapshots');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const newest = newestOf(names);
  if (!newest) return undefined;
  const known = cache.get(dir);
  if (known?.file === newest) return known.snapshot;
  try {
    const snapshot = parseSnapshot(readFileSync(join(dir, newest), 'utf8'));
    cache.set(dir, { file: newest, snapshot });
    return snapshot;
  } catch {
    return undefined;
  }
}

/** Имена псевдонимов и функций снимка — для правил `ask` профиля группы. */
export function snapshotNames(snapshot: ShellSnapshot | undefined): string[] {
  if (!snapshot) return [];
  return [...new Set([...Object.keys(snapshot.aliases), ...Object.keys(snapshot.functions)])];
}

/** Псевдонимы последнего снимка оболочки CLI (`shellSnapshot`). */
export async function shellAliases(
  configDir: string = cliConfigDir(),
  io: ShellAliasIo = realShellAliasIo,
): Promise<ShellAliases | undefined> {
  return (await shellSnapshot(configDir, io))?.aliases;
}

/** Функции последнего снимка оболочки CLI (`shellSnapshot`). */
export async function shellFunctions(
  configDir: string = cliConfigDir(),
  io: ShellAliasIo = realShellAliasIo,
): Promise<ShellFunctions | undefined> {
  return (await shellSnapshot(configDir, io))?.functions;
}
