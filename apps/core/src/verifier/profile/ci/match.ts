import { commandStem } from '../../../platform/build-wrappers.ts';
import type { CiSignature, DetectedCheck } from '../profile.types.ts';
import { baseName } from '../view.ts';
import type { CiCommand, CiScan } from './ci.types.ts';

/**
 * Сопоставление команды CI с найденной проверкой — по сигнатуре, не по тексту целиком:
 * `pnpm -r test`, `pnpm run test`, `npx turbo run test`, `turbo test` и `nx run-many -t test` —
 * один и тот же `test`.
 */

const PMS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

export function normaliseBinary(bin: string): string {
  const name = commandStem(baseName(bin.replace(/\\/g, '/')));
  if (name === 'gradlew') return 'gradle';
  if (name === 'mvnw') return 'mvn';
  if (name === 'python3') return 'python';
  return name;
}

/**
 * Слова сигнатуры: бинарь (семейство), затем слова без флагов, шаблонов и путей; обёртки
 * `uv run` / `poetry run` / `pipenv run` сняты, `python -m pytest` ≡ `pytest`.
 */
export function matchWords(argv: readonly string[]): string[] {
  const words: string[] = [];
  argv.forEach((a, i) => {
    if (i === 0) words.push(normaliseBinary(a));
    else if (!a.startsWith('-') && !a.includes('{') && !a.includes('/') && a !== '.') words.push(a);
  });
  while (['uv', 'poetry', 'pipenv'].includes(words[0] ?? '') && words[1] === 'run') {
    words.splice(0, 2);
    if (words[0]) words[0] = normaliseBinary(words[0]);
  }
  if (words[0] === 'python' && words[1] === 'pytest') words.shift();
  return words;
}

interface ScriptHit {
  scripts: string[];
  scope: 'root' | 'packages';
}

const VALUE_FLAGS = new Set([
  '--filter',
  '-F',
  '--workspace',
  '--scope',
  '--dir',
  '-C',
  '--prefix',
  '--cwd',
]);
const PACKAGE_FLAGS = /^(-r|--recursive|--filter|-F|--workspace|--workspaces|-ws|--scope)(=|$)/;
/** Подкоманды turbo, которые не задачи: `turbo test` — задача, `turbo prune` — нет. */
const TURBO_COMMANDS = new Set([
  'run',
  'prune',
  'login',
  'logout',
  'link',
  'unlink',
  'daemon',
  'gen',
  'generate',
  'info',
  'ls',
  'query',
  'telemetry',
  'watch',
  'boundaries',
  'scan',
  'bin',
]);

function turboTasks(rest: readonly string[]): string[] {
  const scripts: string[] = [];
  for (const a of rest) {
    if (a.startsWith('-')) break;
    scripts.push(a);
  }
  return scripts;
}

/** Команда менеджера пакетов или turbo / nx → какие скрипты она гоняет и в каком охвате. */
export function scriptHit(argv: readonly string[]): ScriptHit | null {
  const bin = normaliseBinary(argv[0] ?? '');
  const at = (name: string): number =>
    argv.findIndex((a, i) => i > 0 && normaliseBinary(a) === name);
  const turbo = bin === 'turbo' ? 0 : at('turbo');
  if (turbo >= 0) {
    const next = argv[turbo + 1];
    if (next === 'run') return { scripts: turboTasks(argv.slice(turbo + 2)), scope: 'packages' };
    // turbo 2: `turbo test` — то же, что `turbo run test`.
    if (next !== undefined && !next.startsWith('-') && !TURBO_COMMANDS.has(next))
      return { scripts: turboTasks(argv.slice(turbo + 1)), scope: 'packages' };
  }
  const nx = bin === 'nx' ? 0 : at('nx');
  if (nx >= 0) {
    const rest = argv.slice(nx + 1);
    const scripts: string[] = [];
    rest.forEach((a, i) => {
      if (a === '-t' || a === '--target' || a === '--targets')
        for (const v of rest.slice(i + 1)) {
          if (v.startsWith('-')) break;
          scripts.push(...v.split(','));
        }
      const eq = /^--targets?=(.+)$/.exec(a);
      if (eq) scripts.push(...(eq[1] as string).split(','));
      if (rest[0] === 'run' && i === 1 && a.includes(':')) scripts.push(a.split(':')[1] as string);
    });
    return scripts.length > 0 ? { scripts, scope: 'packages' } : null;
  }
  if (!PMS.has(bin)) return null;
  const words: string[] = [];
  let packages = false;
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (PACKAGE_FLAGS.test(a)) packages = true;
    // `-w` у npm — пакет воркспейса (со значением), у pnpm — корень воркспейса (без значения).
    if (a === '-w' && bin === 'npm') {
      packages = true;
      i += 1;
      continue;
    }
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) i += 1;
      continue;
    }
    words.push(a);
  }
  if (words[0] === 'workspaces' && (words[1] === 'foreach' || words[1] === 'run')) {
    packages = true;
    words.splice(0, words[1] === 'run' ? 1 : 2);
  }
  // `yarn workspace <имя> <скрипт>` — скрипт одного пакета.
  if (bin === 'yarn' && words[0] === 'workspace') {
    packages = true;
    words.splice(0, 2);
  }
  if (words[0] === 'run' || words[0] === 'run-script') words.shift();
  const script = words[0];
  if (!script || ['install', 'ci', 'i', 'add', 'exec', 'dlx', 'x', 'build:deps'].includes(script))
    return null;
  return { scripts: [script === 't' ? 'test' : script], scope: packages ? 'packages' : 'root' };
}

/** Слова проверки — подпоследовательность слов команды при том же бинаре. */
function wordsMatch(entry: readonly string[], cmd: readonly string[]): boolean {
  if (entry.length === 0 || entry[0] !== cmd[0]) return false;
  let j = 1;
  for (let i = 1; i < cmd.length && j < entry.length; i += 1) if (cmd[i] === entry[j]) j += 1;
  return j === entry.length;
}

function signatureMatches(sig: CiSignature, cmd: CiCommand, strictRoot: boolean): boolean {
  if (strictRoot && sig.root !== cmd.cwd) return false;
  if (sig.kind === 'script') {
    const hit = scriptHit(cmd.argv);
    return hit !== null && hit.scripts.includes(sig.script);
  }
  return wordsMatch(sig.words, matchWords(cmd.argv));
}

/**
 * Какие проверки гоняет CI. Сначала — совпадение и по сигнатуре, и по каталогу; нет — та же
 * сигнатура в любом корне, если такая проверка одна (CI зовёт `go test ./svc/...` из корня).
 * Скрипт пакетов без своей проверки пакетов — корневой и наоборот.
 */
export function ciSet(
  checks: readonly DetectedCheck[],
  scan: CiScan,
): { ids: string[]; unmatched: CiCommand[] } {
  const ids = new Set<string>();
  const unmatched: CiCommand[] = [];
  for (const cmd of scan.commands) {
    let hits = checks.filter((c) => signatureMatches(c.match, cmd, true));
    if (hits.length === 0) {
      const loose = checks.filter((c) => signatureMatches(c.match, cmd, false));
      if (loose.length === 1) hits = loose;
    }
    const hit = scriptHit(cmd.argv);
    if (hit && hits.length > 1) {
      const scoped = hits.filter((c) => c.match.kind === 'script' && c.match.scope === hit.scope);
      if (scoped.length > 0) hits = scoped;
    }
    if (hits.length === 0) unmatched.push(cmd);
    for (const h of hits) ids.add(h.entry.id);
  }
  return { ids: [...ids].sort(), unmatched };
}
