/**
 * Скрипты в команде Bash — для «следа хода».
 *
 * Скрипт — запуск файла или скрипта пакета: `node|bun|deno|tsx|python|bash|sh|zsh
 * <путь>`, `./x.sh`, `pnpm|npm|yarn [run] <скрипт>`, `make <цель>`. Обычные
 * команды (git, grep, ls, cat, sed, curl…) скриптами не считаются: их в ходе
 * десятки, и в следе они утопили бы то, ради чего он есть, — что из проекта
 * агент запускал.
 */

const RUNNERS = new Set(['node', 'bun', 'deno', 'tsx', 'python', 'python3', 'bash', 'sh', 'zsh']);
/** Флаги, за которыми идёт код строкой, а не файл: `node -e`, `python -c`, `python -m`. */
const INLINE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c', '-m']);
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn']);
/** Флаги менеджера пакетов со значением следом: `pnpm --filter web dev`. */
const VALUE_FLAGS = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '-w', '--workspace']);
/** Свои команды менеджеров пакетов — не скрипты проекта. */
const PM_COMMANDS = new Set([
  'add',
  'audit',
  'bin',
  'cache',
  'ci',
  'config',
  'create',
  'dlx',
  'exec',
  'fetch',
  'help',
  'i',
  'import',
  'info',
  'init',
  'install',
  'link',
  'list',
  'ls',
  'outdated',
  'pack',
  'prune',
  'publish',
  'rebuild',
  'remove',
  'rm',
  'root',
  'store',
  'uninstall',
  'unlink',
  'up',
  'update',
  'version',
  'view',
  'why',
]);

/** Слова команды: пробелы внутри кавычек слово не рвут. */
function wordsOf(segment: string): string[] {
  return segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

const looksLikeFile = (word: string): boolean => /[\\/]/.test(word) || /\.\w{1,5}$/.test(word);

function isScript(words: readonly string[]): boolean {
  const [first = '', ...rest] = words;
  const program = first.split('/').pop() ?? '';
  if (RUNNERS.has(program)) {
    // `deno run x.ts`, `bun run dev`: подкоманда `run` — ещё не файл.
    const args =
      rest[0] === 'run' && (program === 'deno' || program === 'bun') ? rest.slice(1) : rest;
    for (const arg of args) {
      if (INLINE_FLAGS.has(arg)) return false;
      if (arg.startsWith('-')) continue;
      return program === 'bun' && rest[0] === 'run' ? true : looksLikeFile(arg);
    }
    return false;
  }
  if (PACKAGE_MANAGERS.has(program)) {
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index] ?? '';
      if (VALUE_FLAGS.has(arg)) index += 1;
      else if (!arg.startsWith('-')) return arg === 'run' || !PM_COMMANDS.has(arg);
    }
    return false;
  }
  if (program === 'make') return true;
  if (/^\.\.?\//.test(first)) return true;
  // Абсолютный путь — скрипт, только если это файл с расширением: `/bin/ls` нет.
  return /^(?:~|\/)/.test(first) && /\.\w{1,5}$/.test(first);
}

/**
 * Скрипты команды по звеньям `&&`, `||`, `;`, `|` и строкам. Переменные окружения
 * перед командой (`CI=1 pnpm test`) скрипт не прячут и в подпись не идут.
 */
export function scriptCommands(command: string): string[] {
  const found: string[] = [];
  for (const raw of command.split(/&&|\|\||[;|\n]/)) {
    const words = wordsOf(raw.trim());
    let start = 0;
    while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start] ?? '')) start += 1;
    const rest = words.slice(start);
    if (rest.length > 0 && isScript(rest)) found.push(rest.join(' '));
  }
  return found;
}
