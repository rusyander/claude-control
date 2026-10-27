import { commandSteps } from '../check-signature.ts';

/**
 * Какие команды группы журнал проверок обязан увидеть (R41): тот же распознаватель,
 * что у самого журнала (`tools/verify-ledger/checks.cjs`, `recognize`) — vitest `run`,
 * tsc `--noEmit`, eslint без `--fix`, prettier `--check`, vite `build`. Своей копии
 * правил здесь нет: команда разбирается до argv процесса node, который запустил бы
 * инструмент, и argv судит журнал. Скрипт пакета (`pnpm test`) раскрывается по
 * `package.json` каталога один раз; `--filter`, `-C`, `-r` и обёртки (turbo, nx) — чужой
 * пакет или неизвестно что: не судим, ложный GAP хуже пропущенного.
 */

interface LedgerTool {
  id: string;
  re: RegExp;
}

interface ChecksModule {
  recognize(
    argv: string[],
    cwd: string,
    env?: Record<string, string | undefined>,
  ): { id: string } | null;
  TOOLS: readonly LedgerTool[];
}

/**
 * Распознаватель журнала — файл репозитория вне сервера: не загрузился (переименован,
 * битый) — R41 молчит, панель живёт.
 */
const checks = (await import(
  new URL('../../../../../../../../tools/verify-ledger/checks.cjs', import.meta.url).href
)
  .then((mod: { default?: ChecksModule } & Partial<ChecksModule>) => mod.default ?? mod)
  .catch((error: unknown) => {
    console.warn('[group-watch] verify-ledger recognizer unavailable', error);
    return undefined;
  })) as ChecksModule | undefined;

/** Скрипты `package.json` каталога; нет файла — `undefined`. */
export type ScriptsOf = (dir: string) => Readonly<Record<string, string>> | undefined;

/** Путь файла инструмента внутри пакета — из шаблона самого журнала (`node_modules/vitest/vitest.mjs`). */
function toolFile(tool: LedgerTool): string {
  return tool.re.source.replace(/\$$/, '').replace(/\\(.)/g, '$1');
}

/** Имя запускаемого файла инструмента без каталога и расширения: `vitest.mjs` → `vitest`. */
function binName(token: string): string {
  const base = token.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.replace(/\.(?:cmd|exe|ps1|js|mjs|cjs)$/i, '').toLowerCase();
}

/** Инструмент журнала по имени бинаря (`tsc` — id `tsc`, файл `typescript/bin/tsc`). */
function toolOf(token: string): LedgerTool | undefined {
  const name = binName(token);
  return checks?.TOOLS.find((tool) => binName(toolFile(tool)) === name || tool.id === name);
}

/** Слова строки вне кавычек; кавычки снимаются. */
function words(step: string): string[] {
  return [...step.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'node']);
const MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
/** Ключи менеджера, после которых скрипт — из чужого пакета или из всех сразу. */
const FOREIGN_VALUED = new Set(['-C', '--dir', '--prefix', '--filter', '-F', '--workspace']);
const FOREIGN_FLAGS = new Set(['-r', '--recursive', '-w', '--workspaces']);
/** Ключи со значением следующим словом (раннера и менеджера). */
const VALUED = new Set(['-p', '--package', '-c', '--call', ...FOREIGN_VALUED]);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Каталог шага после `cd`: относительный — от текущего. */
function cdTarget(dir: string, step: string): string | undefined {
  const match = /^(?:cd|pushd)\s+(.+)$/.exec(step);
  if (!match?.[1]) return undefined;
  const raw = match[1].trim().replace(/^["']|["']$/g, '');
  if (/^(?:[a-zA-Z]:)?[\\/]/.test(raw)) return raw;
  return `${dir.replace(/[\\/]+$/, '')}/${raw}`;
}

/**
 * Проверка журнала в одном шаге или `undefined`. `depth` — раскрытие скрипта пакета:
 * один уровень, скрипт, зовущий скрипт, не судим.
 */
function stepCheck(
  step: string,
  dir: string,
  scriptsOf: ScriptsOf,
  depth: number,
): string | undefined {
  const list = words(step);
  let i = 0;
  while (i < list.length && ENV_ASSIGN.test(list[i]!)) i += 1;
  let manager = false;
  let foreign = false;
  while (i < list.length) {
    const word = list[i]!;
    const lower = word.toLowerCase();
    if (RUNNERS.has(lower) || ['exec', 'dlx', 'run', 'run-script', '--'].includes(lower)) {
      i += 1;
      continue;
    }
    if (MANAGERS.has(lower)) {
      manager = true;
      i += 1;
      continue;
    }
    if (word.startsWith('-')) {
      const flag = word.split('=')[0]!;
      if (FOREIGN_VALUED.has(flag) || FOREIGN_FLAGS.has(flag)) foreign = true;
      i += VALUED.has(word) ? 2 : 1;
      continue;
    }
    break;
  }
  const head = list[i];
  if (!head) return undefined;
  const tool = toolOf(head);
  if (tool) {
    const argv = ['node', `${dir.replace(/[\\/]+$/, '')}/${toolFile(tool)}`, ...list.slice(i + 1)];
    try {
      return checks?.recognize(argv, dir, {})?.id;
    } catch {
      return undefined;
    }
  }
  if (!manager || foreign || depth > 0) return undefined;
  // `npm t` — короткое имя `npm test`.
  const name = head === 't' ? 'test' : head;
  const body = scriptsOf(dir)?.[name];
  return body ? commandCheck(body, dir, scriptsOf, depth + 1) : undefined;
}

/**
 * Проверка, которую журнал должен записать за эту команду (id инструмента), или
 * `undefined`. `dir` — каталог, где команда стартует (копия группы).
 */
export function commandCheck(
  command: string,
  dir: string,
  scriptsOf: ScriptsOf,
  depth = 0,
): string | undefined {
  if (!checks) return undefined;
  let cwd = dir;
  for (const step of commandSteps(command)) {
    const next = cdTarget(cwd, step);
    if (next) {
      cwd = next;
      continue;
    }
    const found = stepCheck(step, cwd, scriptsOf, depth);
    if (found) return found;
  }
  return undefined;
}
