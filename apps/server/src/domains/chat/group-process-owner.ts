import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessRow } from '../../lib/kill-tree.mjs';

/**
 * Чей процесс гасит группа (D-1, 24.10). Живое дерево от CLI группы (`ownPids`
 * по `planTreeKill`) не видит сироту: группа завела `(vite --port 5284 &)`,
 * оболочка-посредник вышла, и у vite в таблице ОС родителя нет — свой же
 * dev-сервер судился чужим и шёл карточкой человеку. Своё доказывают два
 * признака, которых у процессов владельца и других групп не бывает:
 *
 * 1. Метка группы в окружении: имя переменной несёт хэш группы
 *    (`groupProcessMark`), её наследует каждый потомок CLI группы, сирота тоже.
 *    Читает её тот же помощник, что и добор после паузы (`process-env-mark.ts`).
 * 2. Текст запуска: Git Bash держит заглушку `bash.exe` форкнутого фонового
 *    звена, пока жив запущенный им процесс, и в её командной строке — обёртка
 *    CLI `eval '<команда>'`. Команда, знак в знак записанная вызовом Bash в
 *    транскрипте копии группы, — её, если CLI, заведший обёртку, ушёл (сирота).
 *    Так доказываются и процессы, заведённые до появления метки.
 *
 * Обёртка, чей родитель жив и вне своего дерева (чужой CLI в той же копии,
 * терминал владельца), не сирота — текстом запуска её не присвоить.
 */

/** Строка снимка с командной строкой; в тестах её может не быть. */
export type OwnerRow = ProcessRow & { command?: string };

/** Имя переменной-метки группы: свои процессы несут его с непустым значением. */
export function groupProcessMark(parentChatId: string, groupIndex: number): string {
  const hash = createHash('sha256').update(`${parentChatId}#${groupIndex}`).digest('hex');
  return `AGENTDECK_OWNER_${hash.slice(0, 16).toUpperCase()}`;
}

/**
 * Метка группы в окружение прогона звена (P-06): у групп Claude её ставит профиль
 * группы (`processMark`), у чужого CLI — сборка (`setChildRun`). По ней суд
 * погашения узнаёт сирот группы. Звено без номера группы — без метки.
 */
export function groupMarkEnv(link: {
  parentChatId: string;
  groupIndex?: number;
}): Record<string, string> {
  return typeof link.groupIndex === 'number'
    ? { [groupProcessMark(link.parentChatId, link.groupIndex)]: '1' }
    : {};
}

/** Командная строка Windows → слова, по правилам `CommandLineToArgvW`. */
export function windowsArgv(line: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i] as string)) i += 1;
    if (i >= line.length) break;
    let arg = '';
    let quoted = false;
    while (i < line.length) {
      const char = line[i] as string;
      if (char === '\\') {
        let end = i;
        while (line[end] === '\\') end += 1;
        const count = end - i;
        if (line[end] === '"') {
          arg += '\\'.repeat(Math.floor(count / 2));
          if (count % 2 === 1) {
            arg += '"';
            i = end + 1;
          } else i = end;
        } else {
          arg += '\\'.repeat(count);
          i = end;
        }
        continue;
      }
      if (char === '"') {
        if (quoted && line[i + 1] === '"') {
          arg += '"';
          i += 2;
          continue;
        }
        quoted = !quoted;
        i += 1;
        continue;
      }
      if (!quoted && /\s/.test(char)) break;
      arg += char;
      i += 1;
    }
    args.push(arg);
  }
  return args;
}

/**
 * Слово оболочки из `'…'`, `\'` и `"…"` без подстановок подряд — так CLI
 * экранирует команду для `eval`: одинарную кавычку внутри — `'"'"'` (Claude
 * Code 24.10, живая заглушка) или `'\''`.
 */
function singleQuotedWord(text: string, start: number): string | undefined {
  let i = start;
  let out = '';
  if (text[i] !== "'") return undefined;
  while (i < text.length) {
    if (text[i] === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return undefined;
      out += text.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (text[i] === '\\' && text[i + 1] === "'") {
      out += "'";
      i += 2;
      continue;
    }
    if (text[i] === '"') {
      const end = text.indexOf('"', i + 1);
      const inner = end < 0 ? '' : text.slice(i + 1, end);
      // `$`, `` ` `` и `\` в двойных кавычках подставляются — текст уже не знак в знак.
      if (end < 0 || /[$`\\]/.test(inner)) return undefined;
      out += inner;
      i = end + 1;
      continue;
    }
    break;
  }
  return out;
}

/**
 * Команда, которую исполняет обёртка Bash-инструмента CLI (`bash -c "source
 * <снимок> … && eval '<команда>' < /dev/null && pwd -P >| …"`), или `undefined`
 * — это не такая обёртка. Первый `eval '` сценария — обёртки: в прологе
 * до команды `eval` нет.
 */
export function launchedCommandOf(
  commandLine: string,
  platform: string = process.platform,
): string | undefined {
  let script = commandLine;
  if (platform === 'win32') {
    const argv = windowsArgv(commandLine);
    const at = argv.indexOf('-c');
    if (at < 0 || at + 1 >= argv.length) return undefined;
    script = argv[at + 1] as string;
  }
  const at = script.indexOf("eval '");
  if (at < 0) return undefined;
  return singleQuotedWord(script, at + 'eval '.length);
}

/**
 * Родителя строки нет в живых: его нет в снимке, или его номер занят позже
 * ребёнка (тот вышел, номер достался другому). Время создания неизвестно —
 * подмену не доказать: родитель считается живым.
 */
function parentGone(byPid: ReadonlyMap<number, OwnerRow>, row: OwnerRow): boolean {
  const parent = byPid.get(row.ppid);
  if (!parent || parent.pid === row.pid) return true;
  return parent.created > 0n && row.created > 0n && parent.created > row.created;
}

/** Цепочка предков снизу вверх, до первого ушедшего родителя. */
function chainOf(byPid: ReadonlyMap<number, OwnerRow>, pid: number): OwnerRow[] {
  const rows: OwnerRow[] = [];
  const seen = new Set<number>();
  let row = byPid.get(pid);
  while (row && !seen.has(row.pid)) {
    rows.push(row);
    seen.add(row.pid);
    if (parentGone(byPid, row)) break;
    row = byPid.get(row.ppid);
  }
  return rows;
}

/** Мс Unix из тиков FILETIME (`created` снимка). */
function msOfFiletime(created: bigint): number {
  return Number(created / 10_000n) - 11_644_473_600_000;
}

/** Транскрипты копии: `*.jsonl` в каталоге и подкаталогах субагентов (глубина 3). */
function transcriptFiles(dir: string, depth = 0): { path: string; mtimeMs: number }[] {
  if (depth > 3) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) out.push(...transcriptFiles(path, depth + 1));
    else if (name.endsWith('.jsonl')) out.push({ path, mtimeMs: stat.mtimeMs });
  }
  return out;
}

/** Запас на часы: запись вызова ложится до запуска процесса, файл дописывается после. */
const RAN_SLACK_MS = 60_000;

/**
 * Записан ли вызов Bash с этой командой знак в знак в транскриптах копии.
 * Файлы, не тронутые с запуска процесса, не читаются: вызова в них нет.
 */
export function ranInCopy(dir: string, command: string, sinceMs: number): boolean {
  const needle = `"command":${JSON.stringify(command)}`;
  for (const file of transcriptFiles(dir)) {
    if (file.mtimeMs < sinceMs - RAN_SLACK_MS) continue;
    try {
      if (readFileSync(file.path, 'utf8').includes(needle)) return true;
    } catch {
      // Занят или удалён — в нём не ищем.
    }
  }
  return false;
}

export interface OwnerEvidence {
  /** Живое дерево от корней прогона группы. */
  tree: ReadonlySet<number>;
  /** Метка группы по номеру (`readMarks`); `undefined` — не прочесть на этой ОС. */
  marks?: ReadonlyMap<number, boolean>;
  /** Каталог транскриптов копии группы; нет — текст запуска не сверяется. */
  transcriptDir?: string;
  ran?: typeof ranInCopy;
  platform?: string;
}

/** Номера из `pids`, чьё происхождение от группы доказано (см. шапку модуля). */
export function provenOwn(
  table: readonly OwnerRow[],
  pids: readonly number[],
  evidence: OwnerEvidence,
): Set<number> {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const ran = evidence.ran ?? ranInCopy;
  const own = new Set<number>();
  for (const pid of pids) {
    if (evidence.tree.has(pid) || evidence.marks?.get(pid) === true) {
      own.add(pid);
      continue;
    }
    const chain = chainOf(byPid, pid);
    if (chain.some((row) => evidence.tree.has(row.pid))) {
      own.add(pid);
      continue;
    }
    if (!evidence.transcriptDir) continue;
    const dir = evidence.transcriptDir;
    // Обёртка в счёт, только если CLI, что её завёл, ушёл: живой родитель вне
    // своего дерева — чужой CLI (другая сессия в той же копии, терминал).
    const launched = chain.some((row) => {
      const command = row.command ? launchedCommandOf(row.command, evidence.platform) : undefined;
      return (
        command !== undefined &&
        parentGone(byPid, row) &&
        ran(dir, command, msOfFiletime(row.created))
      );
    });
    if (launched) own.add(pid);
  }
  return own;
}

/** Короткая подпись процесса для отказа агенту: имя программы и начало строки. */
export function processLabel(row: OwnerRow | undefined): string {
  const command = row?.command?.replace(/\s+/g, ' ').trim();
  if (!command) return 'unknown command';
  return command.length > 120 ? `${command.slice(0, 117)}...` : command;
}
