import { createHash } from 'node:crypto';
import { stepClass } from '../../../analytics/token-audit/step-class.ts';

/**
 * Подпись проверки для R4 («та же проверка трижды без правки между»). Решает,
 * ПРОВЕРКА ли это, тот же код, что очередь тяжёлых шагов и измеритель:
 * классификатор очереди (`tools/heavy-queue-classify.mjs` через хук очереди,
 * вместе с её опытом длительностей) и класс шага измерителя (`step-class.ts`,
 * `gate`). Своей копии правил тут нет — копия в `economy.ts` разошлась с хуком
 * за день.
 *
 * Подпись — сами шаги команды без служебных (`tail`, `echo` — их подпись у
 * классификатора пуста) и без перенаправлений, пробелы схлопнуты: `vitest run
 * a.test.ts` и `vitest run b.test.ts` — разные проверки, а не «одна и та же
 * трижды». Каталог `cd` — часть подписи: `cd apps/web && pnpm test` и `cd
 * apps/server && pnpm test` проверяют разное.
 */

/** Опыт очереди: подпись шага → сколько он шёл, мс. */
export type LearnedDurations = ReadonlyMap<string, number>;

interface QueueModule {
  steps(command: string): string[];
  stepSignature(step: string): string | null;
  isHeavy(command: string, learned?: LearnedDurations): boolean;
  loadLearned(dir: string, now?: number): Map<string, number>;
  shownCommand(command: string): string;
}

/**
 * Хук очереди — файл репозитория вне сервера: не загрузился (переименован,
 * битый) — сторож теряет классификатор очереди, а не панель свой запуск.
 */
const queue = (await import(
  new URL('../../../../../../../tools/heavy-queue-hook.mjs', import.meta.url).href
).catch((error: unknown) => {
  console.warn('[group-watch] heavy-queue classifier unavailable', error);
  return undefined;
})) as QueueModule | undefined;

/**
 * Полный гейт — тем же кодом, что страж «один гейт в конце» набора (`gate-at-end`):
 * скрипт гейта проекта (`check-ticket`, `scripts/check_*.mjs`, `pnpm gate`) или
 * несколько видов проверок целиком. Своей копии правил нет — та же причина, что у
 * классификатора очереди. Не загрузился — сторож судит о тяжести только по длительности.
 */
const gateAtEnd = (await import(
  new URL('../../../../../assets/kit/agentdeck-kit/hooks/lib/gate-at-end.mjs', import.meta.url).href
).catch((error: unknown) => {
  console.warn('[group-watch] full-gate classifier unavailable', error);
  return undefined;
})) as { isFullGate(command: string): boolean } | undefined;

/** Команда — полный гейт (R21); без классификатора — нет. */
export function isFullGate(command: string): boolean {
  try {
    return gateAtEnd?.isFullGate(command) === true;
  } catch {
    return false;
  }
}

/** Опыт длительностей из каталога очереди; нечитаемый — пустой. */
export function loadLearnedDurations(queueDir: string): LearnedDurations {
  try {
    return queue?.loadLearned(queueDir) ?? new Map();
  } catch {
    return new Map();
  }
}

/**
 * Команда для строки сигнала: секреты (`TOKEN=…`, `--token X`, учётка в адресе,
 * заголовок авторизации) скрыты теми же масками, что у файла аренды очереди,
 * 200 знаков. Без классификатора — только первое слово: показать секрет хуже,
 * чем показать меньше.
 */
export function maskCommand(command: string): string {
  return queue ? queue.shownCommand(command) : `${command.trim().split(/\s/)[0] ?? ''} …`;
}

/** Шаги цепочки вне кавычек; без классификатора — грубо по `&&`, `;`, `|`. */
export function commandSteps(command: string): string[] {
  const list = queue ? queue.steps(command) : command.split(/&&|\|\||[;|\n]/);
  return list.map((step) => step.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

const CD_STEP = /^(?:cd|pushd)\s/;

/**
 * Отпечаток команды для сравнения между группами (R23, F-89): шаги без перехода в
 * каталог (у каждой группы своя копия), целиком — без маски и обрезки строки сигнала,
 * где две длинные команды с общим началом совпали бы. В сигнал идёт только sha256
 * (12 знаков): сама команда и её секреты наружу не уходят.
 */
export function commandPrint(command: string): string | undefined {
  const steps = commandSteps(command).filter((step) => !CD_STEP.test(step));
  if (steps.length === 0) return undefined;
  return createHash('sha256').update(steps.join(' && ')).digest('hex').slice(0, 12);
}

/** `git` с глобальными ключами (`-C путь`, `-c k=v`, `--no-pager`…) → подкоманда и остаток. */
const GIT =
  /^git(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--no-pager|--(?:git-dir|work-tree)(?:=|\s+)\S+))*\s+([\w-]+)(.*)$/;

export function gitVerb(step: string): { verb: string; rest: string } | undefined {
  const match = GIT.exec(step);
  return match?.[1] ? { verb: match[1], rest: match[2] ?? '' } : undefined;
}

const TREE_VERBS = new Set([
  'checkout',
  'switch',
  'restore',
  'reset',
  'stash',
  'pull',
  'merge',
  'rebase',
  'apply',
  'am',
  'cherry-pick',
  'revert',
]);
/** Правка файлов командой, а не Edit: прежний прогон проверки (и прочитанное) устарел. */
const BASH_EDIT =
  /^(?:sed\s+(?:-\S+\s+)*-i|perl\s+-\S*i|(?:npx\s+|pnpm\s+(?:exec\s+)?)?prettier\b.*--write|(?:npx\s+|pnpm\s+(?:exec\s+)?)?eslint\b.*--fix|(?:pnpm|npm|yarn)\s+(?:install|i|add|remove|update|up)\b|patch\s)/;

function stepChangesTree(step: string): boolean {
  if (BASH_EDIT.test(step)) return true;
  const git = gitVerb(step);
  if (!git || !TREE_VERBS.has(git.verb)) return false;
  // Список и показ тайника, новая ветка на том же коммите — дерево прежнее.
  if (git.verb === 'stash' && /^\s+(?:list|show)\b/.test(git.rest)) return false;
  if (
    (git.verb === 'checkout' && /^\s+-b\s/.test(git.rest)) ||
    (git.verb === 'switch' && /^\s+-c\s/.test(git.rest))
  )
    return false;
  return true;
}

/** Шаги, которые меняют дерево: после них прежний прогон проверки ничего не говорит. */
export function changesTree(command: string): boolean {
  return commandSteps(command).some(stepChangesTree);
}

/** Запас к опыту: прогон бывает и на четверть дольше прошлых (как срок фоновой аренды у хука). */
const EXPECT_MARGIN = 1.25;

/**
 * Сколько команда должна идти по опыту очереди, мс: известные шаги цепочки
 * подряд, с запасом. Ни один шаг не известен — `undefined` (опыта нет).
 */
export function expectedMs(command: string, learned?: LearnedDurations): number | undefined {
  if (!queue || !learned || learned.size === 0) return undefined;
  let total = 0;
  for (const step of queue.steps(command)) {
    const signature = queue.stepSignature(step);
    const ms = signature ? learned.get(signature) : undefined;
    if (ms !== undefined && Number.isFinite(ms)) total += ms;
  }
  return total > 0 ? Math.round(total * EXPECT_MARGIN) : undefined;
}

/** Перенаправления вывода (`2>&1`, `> out.log`, `&> log`) — не часть проверки. */
const REDIRECT = /\s*(?:\d?>>?|&>)\s*(?:&\d|"[^"]*"|'[^']*'|\S+)/g;
const CD = /^(?:cd|pushd)\s+(.+)$/;

/** Подпись проверки или `undefined` — команда не проверка. */
export function checkSignature(command: string, learned?: LearnedDurations): string | undefined {
  const isCheck =
    (queue?.isHeavy(command, learned) ?? false) ||
    stepClass([{ name: 'Bash', input: { command } }]) === 'gate';
  if (!isCheck) return undefined;
  let dir = '';
  const parts: string[] = [];
  for (const step of commandSteps(command)) {
    const cd = CD.exec(step);
    if (cd?.[1]) {
      dir = cd[1].replace(/^["']|["']$/g, '');
      continue;
    }
    if (queue && queue.stepSignature(step) === null) continue;
    const text = step.replace(REDIRECT, '').trim();
    if (text) parts.push(text);
  }
  if (parts.length === 0) return undefined;
  const body = parts.join(' && ');
  return dir ? `${dir}: ${body}` : body;
}
